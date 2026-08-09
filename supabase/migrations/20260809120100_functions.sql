-- Panther Carts — Ticket 1: queue engine (PostgreSQL functions / RPC)
--
-- All authoritative queue mutations live here and are invoked via Supabase
-- RPC by trusted server operations only. No React/browser code may call these.
--
-- Concurrency model
-- -----------------
-- Every mutation takes a transaction-scoped advisory lock keyed by session id
-- (public.lock_session -> pg_advisory_xact_lock). Because the lock is
-- xact-scoped it is released automatically at commit/rollback, and it is
-- re-entrant, so nested helper calls in the same transaction are safe. This
-- serializes all operations within a single session so queue order cannot be
-- corrupted and a bin cannot be double-assigned, while operations in different
-- sessions run concurrently. Row-level FOR UPDATE locks and partial unique
-- indexes provide defense in depth.
--
-- Idempotency
-- -----------
-- checkout/return carry an idempotency key persisted on rentals
-- (checkout_idempotency_key / return_idempotency_key, both uniquely indexed);
-- a replay returns the original result without new side effects.
-- expire_reservations is naturally idempotent (it only acts on ACTIVE expired
-- reservations). Notification creation is deduplicated by dedupe_key.
--
-- All functions are SECURITY DEFINER with a fixed empty search_path; every
-- object reference is schema-qualified.

-- ===========================================================================
-- Helpers
-- ===========================================================================

-- Normalize a phone number to an E.164-ish string. US-centric by documented
-- assumption: a bare 10-digit number gets +1. Kept in sync with the TypeScript
-- mirror in src/lib/validation/phone.ts.
create or replace function public.normalize_phone(p_phone text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_digits text;
begin
  if p_phone is null then
    return null;
  end if;
  v_digits := regexp_replace(p_phone, '[^0-9]', '', 'g');
  if v_digits = '' then
    return '';
  end if;
  if char_length(v_digits) = 10 then
    return '+1' || v_digits;
  elsif char_length(v_digits) = 11 and left(v_digits, 1) = '1' then
    return '+' || v_digits;
  else
    return '+' || v_digits;
  end if;
end;
$$;

-- Transaction-scoped, session-level advisory lock. Re-entrant and released at
-- commit. This is the single serialization point for a session's mutations.
create or replace function public.lock_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_session_id::text, 0));
end;
$$;

-- Cryptographically-random four-digit pickup code, unique among active READY
-- entries in the session. gen_random_uuid() is backed by a CSPRNG on
-- PostgreSQL, so digits derived from its bits are cryptographically random.
create or replace function public.generate_pickup_code(p_session_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
  v_try integer := 0;
begin
  loop
    v_try := v_try + 1;
    v_code := lpad(
      (
        ('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 15))::bit(60)::bigint
        % 10000
      )::text,
      4, '0'
    );
    if not exists (
      select 1 from public.queue_entries qe
      where qe.session_id = p_session_id
        and qe.status = 'READY'
        and qe.pickup_code = v_code
    ) then
      return v_code;
    end if;
    if v_try > 100 then
      raise exception 'PANTHER_CARTS:PICKUP_CODE_EXHAUSTED';
    end if;
  end loop;
end;
$$;

-- Reassign contiguous 1..n ranks to WAITING entries, preserving FIFO order
-- (queue_rank, then joined_at, then id as a stable tie-breaker).
create or replace function public.reindex_waiting_ranks(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  with ordered as (
    select id,
      row_number() over (
        order by queue_rank asc nulls last, joined_at asc, id asc
      ) as rn
    from public.queue_entries
    where session_id = p_session_id and status = 'WAITING'
  )
  update public.queue_entries qe
  set queue_rank = ordered.rn, updated_at = now()
  from ordered
  where qe.id = ordered.id
    and qe.queue_rank is distinct from ordered.rn;
end;
$$;

-- Estimated wait in minutes for a 1-based queue position. Returns NULL to mean
-- "unavailable" (no active OUT rental to base an estimate on). See docs.
create or replace function public.estimated_wait_minutes(
  p_session_id uuid,
  p_position integer
)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_n integer;
  v_rental_minutes integer;
  v_cycle integer;
  v_index integer;   -- 0-based
  v_due timestamptz;
  v_est timestamptz;
  v_minutes numeric;
begin
  if p_position is null or p_position < 1 then
    return null;
  end if;

  select rental_duration_minutes into v_rental_minutes
  from public.sessions where id = p_session_id;
  if v_rental_minutes is null then
    return null;
  end if;

  select count(*) into v_n
  from public.rentals
  where session_id = p_session_id and status = 'OUT';

  if v_n = 0 then
    return null;  -- clearly-typed "unavailable"
  end if;

  v_cycle := (p_position - 1) / v_n;   -- floor for non-negatives
  v_index := (p_position - 1) % v_n;   -- 0-based index into sorted due times

  select due_at into v_due
  from public.rentals
  where session_id = p_session_id and status = 'OUT'
  order by due_at asc, id asc
  offset v_index
  limit 1;

  v_est := v_due + make_interval(mins => v_cycle * v_rental_minutes);
  v_minutes := ceil(extract(epoch from (v_est - now())) / 60.0);
  if v_minutes < 0 then
    v_minutes := 0;  -- overdue rentals contribute zero remaining minutes this cycle
  end if;
  return v_minutes::integer;
end;
$$;

-- ===========================================================================
-- Allocation
-- ===========================================================================

-- Authoritative allocation: while an AVAILABLE bin and a WAITING entry both
-- exist, offer the earliest-ranked entry a deterministically-chosen bin.
-- Called by join, checkout (on swap), return, and expiration. Returns the
-- number of allocations made.
create or replace function public.allocate_bins(p_session_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bin public.bins;
  v_entry public.queue_entries;
  v_code text;
  v_pickup_window integer;
  v_reservation_id uuid;
  v_count integer := 0;
begin
  perform public.lock_session(p_session_id);

  select pickup_window_minutes into v_pickup_window
  from public.sessions where id = p_session_id;
  if v_pickup_window is null then
    raise exception 'PANTHER_CARTS:SESSION_NOT_FOUND';
  end if;

  loop
    select * into v_bin
    from public.bins
    where session_id = p_session_id and status = 'AVAILABLE'
    order by bin_number asc, id asc
    for update skip locked
    limit 1;
    exit when v_bin.id is null;

    select * into v_entry
    from public.queue_entries
    where session_id = p_session_id and status = 'WAITING'
    order by queue_rank asc nulls last, joined_at asc, id asc
    for update skip locked
    limit 1;
    exit when v_entry.id is null;

    v_code := public.generate_pickup_code(p_session_id);

    update public.bins
    set status = 'RESERVED', updated_at = now()
    where id = v_bin.id;

    update public.queue_entries
    set status = 'READY',
        ready_at = now(),
        pickup_code = v_code,
        reserved_bin_id = v_bin.id,
        pickup_expires_at = now() + make_interval(mins => v_pickup_window),
        queue_rank = null,
        updated_at = now()
    where id = v_entry.id;

    insert into public.reservations (
      session_id, queue_entry_id, bin_id, status, expires_at
    )
    values (
      p_session_id, v_entry.id, v_bin.id, 'ACTIVE',
      now() + make_interval(mins => v_pickup_window)
    )
    returning id into v_reservation_id;

    insert into public.notification_outbox (
      session_id, student_id, type, body, dedupe_key
    )
    select p_session_id, qe.student_id, 'READY',
      'A Panther Cart is reserved for you. Your pickup code is ' || v_code
        || '. Reservation expires in ' || v_pickup_window || ' min.',
      'READY:' || v_reservation_id::text
    from public.queue_entries qe
    where qe.id = v_entry.id
    on conflict (dedupe_key) do nothing;

    v_count := v_count + 1;
  end loop;

  perform public.reindex_waiting_ranks(p_session_id);
  return v_count;
end;
$$;

-- ===========================================================================
-- Join queue
-- ===========================================================================
create or replace function public.join_queue(
  p_session_id uuid,
  p_full_name text,
  p_panther_id text,
  p_email text,
  p_phone text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.session_status;
  v_phone text;
  v_student_id uuid;
  v_entry public.queue_entries;
  v_max_rank integer;
  v_position integer;
  v_estimate integer;
  v_body text;
begin
  perform public.lock_session(p_session_id);

  select status into v_status from public.sessions where id = p_session_id;
  if v_status is null then
    raise exception 'PANTHER_CARTS:SESSION_NOT_FOUND';
  end if;
  if v_status <> 'ACTIVE' then
    raise exception 'PANTHER_CARTS:SESSION_NOT_ACTIVE';
  end if;

  v_phone := public.normalize_phone(p_phone);
  if coalesce(btrim(p_full_name), '') = ''
     or coalesce(btrim(p_panther_id), '') = ''
     or coalesce(btrim(p_email), '') = ''
     or coalesce(v_phone, '') = '' then
    raise exception 'PANTHER_CARTS:INVALID_STUDENT_INPUT';
  end if;

  if exists (
    select 1 from public.queue_entries qe
    where qe.session_id = p_session_id
      and qe.phone = v_phone
      and qe.status in ('WAITING', 'READY', 'CHECKED_OUT')
  ) then
    raise exception 'PANTHER_CARTS:DUPLICATE_ACTIVE_ENTRY';
  end if;

  insert into public.students (session_id, full_name, panther_id, email, phone)
  values (p_session_id, btrim(p_full_name), btrim(p_panther_id), btrim(p_email), v_phone)
  returning id into v_student_id;

  select coalesce(max(queue_rank), 0) into v_max_rank
  from public.queue_entries
  where session_id = p_session_id and status = 'WAITING';

  insert into public.queue_entries (
    session_id, student_id, phone, status, queue_rank, joined_at
  )
  values (
    p_session_id, v_student_id, v_phone, 'WAITING', v_max_rank + 1, now()
  )
  returning * into v_entry;

  perform public.allocate_bins(p_session_id);

  select * into v_entry from public.queue_entries where id = v_entry.id;

  if v_entry.status = 'READY' then
    v_position := 0;   -- 0 = a bin is ready now
    v_estimate := 0;
    v_body := 'You have joined Panther Carts. A cart is ready now — check your pickup code.';
  else
    v_position := v_entry.queue_rank;
    v_estimate := public.estimated_wait_minutes(p_session_id, v_position);
    if v_estimate is null then
      v_body := 'You have joined Panther Carts. You are #' || v_position
        || ' in line. Estimated wait: not yet available.';
    else
      v_body := 'You have joined Panther Carts. You are #' || v_position
        || ' in line. Estimated wait: ~' || v_estimate || ' min.';
    end if;
  end if;

  insert into public.notification_outbox (
    session_id, student_id, type, body, dedupe_key
  )
  values (
    p_session_id, v_student_id, 'INITIAL', v_body, 'INITIAL:' || v_entry.id::text
  )
  on conflict (dedupe_key) do nothing;

  return jsonb_build_object(
    'queue_entry', to_jsonb(v_entry),
    'position', v_position,
    'estimated_wait_minutes', v_estimate
  );
end;
$$;

-- ===========================================================================
-- HOLD (one-time)
-- ===========================================================================
create or replace function public.hold_reservation(
  p_session_id uuid,
  p_queue_entry_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_a public.queue_entries;
  v_res public.reservations;
  v_bin_id uuid;
  v_pickup_window integer;
  v_b public.queue_entries;
  v_new_code text;
  v_new_res_id uuid;
  v_other_count integer;
  v_a_position integer;
begin
  perform public.lock_session(p_session_id);

  select pickup_window_minutes into v_pickup_window
  from public.sessions where id = p_session_id;
  if v_pickup_window is null then
    raise exception 'PANTHER_CARTS:SESSION_NOT_FOUND';
  end if;

  -- Lock A.
  select * into v_a
  from public.queue_entries
  where id = p_queue_entry_id and session_id = p_session_id
  for update;
  if v_a.id is null then
    raise exception 'PANTHER_CARTS:ENTRY_NOT_FOUND';
  end if;
  if v_a.status <> 'READY' then
    raise exception 'PANTHER_CARTS:ENTRY_NOT_READY';
  end if;
  if v_a.hold_used then
    raise exception 'PANTHER_CARTS:HOLD_ALREADY_USED';
  end if;

  -- Lock A's active reservation and confirm it is unexpired.
  select * into v_res
  from public.reservations
  where queue_entry_id = v_a.id and status = 'ACTIVE'
  for update;
  if v_res.id is null then
    raise exception 'PANTHER_CARTS:RESERVATION_NOT_ACTIVE';
  end if;
  if v_res.expires_at <= now() then
    raise exception 'PANTHER_CARTS:RESERVATION_EXPIRED';
  end if;
  v_bin_id := v_res.bin_id;

  -- Lock the reserved bin.
  perform 1 from public.bins where id = v_bin_id for update;

  -- Require at least one waiting student; lock the first one (B).
  select * into v_b
  from public.queue_entries
  where session_id = p_session_id and status = 'WAITING'
  order by queue_rank asc nulls last, joined_at asc, id asc
  for update
  limit 1;
  if v_b.id is null then
    raise exception 'PANTHER_CARTS:NOBODY_WAITING';
  end if;

  -- Defer A's reservation; the bin stays RESERVED and is transferred to B.
  update public.reservations
  set status = 'DEFERRED', ended_at = now()
  where id = v_res.id;

  v_new_code := public.generate_pickup_code(p_session_id);
  update public.queue_entries
  set status = 'READY',
      ready_at = now(),
      pickup_code = v_new_code,
      reserved_bin_id = v_bin_id,
      pickup_expires_at = now() + make_interval(mins => v_pickup_window),
      queue_rank = null,
      updated_at = now()
  where id = v_b.id;

  insert into public.reservations (
    session_id, queue_entry_id, bin_id, status, expires_at
  )
  values (
    p_session_id, v_b.id, v_bin_id, 'ACTIVE',
    now() + make_interval(mins => v_pickup_window)
  )
  returning id into v_new_res_id;

  -- A returns to WAITING with its one HOLD consumed.
  update public.queue_entries
  set status = 'WAITING',
      hold_used = true,
      pickup_code = null,
      reserved_bin_id = null,
      ready_at = null,
      pickup_expires_at = null,
      queue_rank = null,
      updated_at = now()
  where id = v_a.id;

  -- Place A at actual position two among the remaining waitlist (the students
  -- still waiting after B was promoted). If nobody else remains, A is one.
  select count(*) into v_other_count
  from public.queue_entries
  where session_id = p_session_id and status = 'WAITING' and id <> v_a.id;

  if v_other_count = 0 then
    update public.queue_entries
    set queue_rank = 1, updated_at = now()
    where id = v_a.id;
    v_a_position := 1;
  else
    -- Keep the current front at rank 1, shift the rest down by one to open a
    -- slot at rank 2 for A.
    with others as (
      select id,
        row_number() over (
          order by queue_rank asc nulls last, joined_at asc, id asc
        ) as rn
      from public.queue_entries
      where session_id = p_session_id and status = 'WAITING' and id <> v_a.id
    )
    update public.queue_entries qe
    set queue_rank = case when o.rn = 1 then 1 else o.rn + 1 end,
        updated_at = now()
    from others o
    where qe.id = o.id;

    update public.queue_entries
    set queue_rank = 2, updated_at = now()
    where id = v_a.id;
    v_a_position := 2;
  end if;

  -- Notifications: READY for the promoted student, HOLD confirmation for A.
  insert into public.notification_outbox (
    session_id, student_id, type, body, dedupe_key
  )
  select p_session_id, qe.student_id, 'READY',
    'A Panther Cart is now reserved for you. Your pickup code is ' || v_new_code || '.',
    'READY:' || v_new_res_id::text
  from public.queue_entries qe
  where qe.id = v_b.id
  on conflict (dedupe_key) do nothing;

  insert into public.notification_outbox (
    session_id, student_id, type, body, dedupe_key
  )
  select p_session_id, qe.student_id, 'HOLD',
    'Your hold is confirmed. You are now #' || v_a_position || ' in line.',
    'HOLD:' || v_res.id::text
  from public.queue_entries qe
  where qe.id = v_a.id
  on conflict (dedupe_key) do nothing;

  return jsonb_build_object(
    'position', v_a_position,
    'promoted_entry_id', v_b.id
  );
end;
$$;

-- ===========================================================================
-- Checkout
-- ===========================================================================
create or replace function public.checkout(
  p_session_id uuid,
  p_pickup_code text,
  p_bin_number text,
  p_panthercard_collected boolean,
  p_staff_label text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.rentals;
  v_entry public.queue_entries;
  v_res public.reservations;
  v_reserved_bin_id uuid;
  v_selected_bin public.bins;
  v_rental public.rentals;
  v_rental_minutes integer;
  v_swapped boolean := false;
begin
  perform public.lock_session(p_session_id);

  -- Idempotent replay.
  select * into v_existing
  from public.rentals
  where checkout_idempotency_key = p_idempotency_key;
  if v_existing.id is not null then
    return jsonb_build_object('rental', to_jsonb(v_existing), 'idempotent_replay', true);
  end if;

  if not p_panthercard_collected then
    raise exception 'PANTHER_CARTS:PANTHERCARD_REQUIRED';
  end if;

  select rental_duration_minutes into v_rental_minutes
  from public.sessions where id = p_session_id;
  if v_rental_minutes is null then
    raise exception 'PANTHER_CARTS:SESSION_NOT_FOUND';
  end if;

  select * into v_entry
  from public.queue_entries
  where session_id = p_session_id and pickup_code = p_pickup_code and status = 'READY'
  for update;
  if v_entry.id is null then
    raise exception 'PANTHER_CARTS:PICKUP_CODE_INVALID';
  end if;

  select * into v_res
  from public.reservations
  where queue_entry_id = v_entry.id and status = 'ACTIVE'
  for update;
  if v_res.id is null then
    raise exception 'PANTHER_CARTS:RESERVATION_NOT_ACTIVE';
  end if;
  if v_res.expires_at <= now() then
    raise exception 'PANTHER_CARTS:RESERVATION_EXPIRED';
  end if;
  v_reserved_bin_id := v_res.bin_id;

  select * into v_selected_bin
  from public.bins
  where session_id = p_session_id and bin_number = p_bin_number
  for update;
  if v_selected_bin.id is null then
    raise exception 'PANTHER_CARTS:BIN_NOT_FOUND';
  end if;

  if v_selected_bin.id = v_reserved_bin_id then
    if v_selected_bin.status <> 'RESERVED' then
      raise exception 'PANTHER_CARTS:BIN_NOT_USABLE';
    end if;
  else
    -- Swap to a different AVAILABLE bin; release the reserved one.
    if v_selected_bin.status <> 'AVAILABLE' then
      raise exception 'PANTHER_CARTS:BIN_NOT_USABLE';
    end if;
    update public.bins set status = 'AVAILABLE', updated_at = now()
    where id = v_reserved_bin_id;
    v_swapped := true;
  end if;

  update public.bins set status = 'OUT', updated_at = now()
  where id = v_selected_bin.id;

  update public.reservations set status = 'CLAIMED', ended_at = now()
  where id = v_res.id;

  update public.queue_entries
  set status = 'CHECKED_OUT', pickup_code = null, updated_at = now()
  where id = v_entry.id;

  insert into public.rentals (
    session_id, bin_id, student_id, queue_entry_id, status,
    checked_out_at, due_at, panthercard_collected_at,
    checkout_staff_label, checkout_idempotency_key
  )
  values (
    p_session_id, v_selected_bin.id, v_entry.student_id, v_entry.id, 'OUT',
    now(), now() + make_interval(mins => v_rental_minutes), now(),
    p_staff_label, p_idempotency_key
  )
  returning * into v_rental;

  -- A bin freed by a swap goes to the next waiting student.
  if v_swapped then
    perform public.allocate_bins(p_session_id);
  end if;

  return jsonb_build_object('rental', to_jsonb(v_rental), 'swapped', v_swapped);
end;
$$;

-- ===========================================================================
-- Return
-- ===========================================================================
create or replace function public.return_rental(
  p_session_id uuid,
  p_bin_number text,
  p_panthercard_returned boolean,
  p_staff_label text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.rentals;
  v_bin public.bins;
  v_rental public.rentals;
  v_new_res public.reservations;
begin
  perform public.lock_session(p_session_id);

  -- Idempotent replay.
  select * into v_existing
  from public.rentals
  where return_idempotency_key = p_idempotency_key;
  if v_existing.id is not null then
    return jsonb_build_object(
      'rental', to_jsonb(v_existing),
      'reservation', null,
      'idempotent_replay', true
    );
  end if;

  select * into v_bin
  from public.bins
  where session_id = p_session_id and bin_number = p_bin_number
  for update;
  if v_bin.id is null then
    raise exception 'PANTHER_CARTS:BIN_NOT_FOUND';
  end if;

  select * into v_rental
  from public.rentals
  where bin_id = v_bin.id and status = 'OUT'
  for update;
  if v_rental.id is null then
    raise exception 'PANTHER_CARTS:NO_ACTIVE_RENTAL';
  end if;

  if not p_panthercard_returned then
    raise exception 'PANTHER_CARTS:PANTHERCARD_REQUIRED';
  end if;

  update public.rentals
  set status = 'RETURNED',
      returned_at = now(),
      was_late = (now() > due_at),
      panthercard_returned_at = now(),
      return_staff_label = p_staff_label,
      return_idempotency_key = p_idempotency_key
  where id = v_rental.id
  returning * into v_rental;

  update public.queue_entries
  set status = 'RETURNED', completed_at = now(), updated_at = now()
  where id = v_rental.queue_entry_id;

  update public.bins set status = 'AVAILABLE', updated_at = now()
  where id = v_bin.id;

  perform public.allocate_bins(p_session_id);

  select * into v_new_res
  from public.reservations
  where bin_id = v_bin.id and status = 'ACTIVE';

  return jsonb_build_object(
    'rental', to_jsonb(v_rental),
    'reservation',
      case when v_new_res.id is not null then to_jsonb(v_new_res) else null end
  );
end;
$$;

-- ===========================================================================
-- Reservation expiration
-- ===========================================================================
create or replace function public.expire_reservations(p_session_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_res public.reservations;
  v_count integer := 0;
begin
  perform public.lock_session(p_session_id);

  for v_res in
    select * from public.reservations
    where session_id = p_session_id
      and status = 'ACTIVE'
      and expires_at <= now()
    for update
  loop
    update public.reservations set status = 'EXPIRED', ended_at = now()
    where id = v_res.id;

    update public.queue_entries
    set status = 'EXPIRED',
        completed_at = now(),
        pickup_code = null,
        reserved_bin_id = null,
        pickup_expires_at = null,
        updated_at = now()
    where id = v_res.queue_entry_id and status = 'READY';

    update public.bins set status = 'AVAILABLE', updated_at = now()
    where id = v_res.bin_id;

    v_count := v_count + 1;
  end loop;

  perform public.allocate_bins(p_session_id);
  return v_count;
end;
$$;

-- ===========================================================================
-- Execution privileges
-- ===========================================================================
-- Revoke the default PUBLIC execute grant; only the service-role key (used by
-- trusted server operations) may call these RPCs. anon/authenticated get no
-- access. SECURITY DEFINER means internal helper calls still run as the owner.
do $$
declare
  v_role text;
begin
  execute 'revoke execute on all functions in schema public from public';
  foreach v_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('revoke execute on all functions in schema public from %I', v_role);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on all functions in schema public to service_role';
  end if;
end;
$$;
