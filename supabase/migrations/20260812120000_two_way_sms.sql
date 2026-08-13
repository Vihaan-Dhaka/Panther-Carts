-- Panther Carts - Ticket 5: two-way SMS, consent, and reliable outbox delivery.
-- Queue mutations remain authoritative PostgreSQL operations. Provider
-- credentials, signature verification, and network calls remain server-only.

-- ---------------------------------------------------------------------------
-- Consent evidence and outbox delivery state
-- ---------------------------------------------------------------------------

alter table public.students
  add column sms_consent_at timestamptz,
  add column sms_consent_version text,
  add constraint students_sms_consent_evidence check (
    (sms_consent_at is null and sms_consent_version is null)
    or (sms_consent_at is not null and btrim(sms_consent_version) <> '')
  );

alter type public.notification_type add value if not exists 'UNKNOWN';

alter table public.notification_outbox
  alter column session_id drop not null,
  alter column student_id drop not null,
  add column destination_phone text,
  add column available_at timestamptz not null default now(),
  add column claimed_at timestamptz,
  add column lease_expires_at timestamptz,
  add column claim_token uuid,
  add column unconfirmed_provider_message_id text,
  add column delivery_outcome_unknown_at timestamptz,
  add constraint notification_outbox_attempts_nonnegative check (attempts >= 0),
  add constraint notification_outbox_destination_valid check (
    destination_phone is null or public.is_valid_phone(destination_phone)
  ),
  add constraint notification_outbox_processing_lease check (
    status <> 'PROCESSING'
    or (
      claimed_at is not null
      and lease_expires_at is not null
      and claim_token is not null
    )
  ),
  add constraint notification_outbox_unknown_delivery_evidence check (
    (
      unconfirmed_provider_message_id is null
      and delivery_outcome_unknown_at is null
    )
    or (
      unconfirmed_provider_message_id is not null
      and btrim(unconfirmed_provider_message_id) <> ''
      and char_length(unconfirmed_provider_message_id) <= 200
      and delivery_outcome_unknown_at is not null
    )
  );

-- Preserve one canonical destination on every provider-independent intent.
create or replace function public.notification_outbox_set_destination()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if right(new.body, 13) <> 'STOP=opt out.' then
    new.body := new.body || ' STOP=opt out.';
  end if;
  if new.destination_phone is null and new.student_id is not null then
    select s.phone into new.destination_phone
    from public.students s
    where s.id = new.student_id
      and s.session_id = new.session_id;
  end if;
  if not public.is_valid_phone(new.destination_phone)
     or new.destination_phone <> public.normalize_phone(new.destination_phone) then
    raise exception 'PANTHER_CARTS:INVALID_PHONE';
  end if;
  return new;
end;
$$;

create trigger notification_outbox_destination_trigger
before insert or update of student_id, session_id, destination_phone, type, body
on public.notification_outbox
for each row execute function public.notification_outbox_set_destination();

-- Run the populated-data backfill through the trigger so legacy MANUAL rows
-- receive the same required opt-out disclosure as newly-created rows.
update public.notification_outbox o
set destination_phone = s.phone
from public.students s
where s.id = o.student_id
  and s.session_id = o.session_id
  and o.destination_phone is null;

alter table public.notification_outbox
  alter column destination_phone set not null;

drop index public.notification_outbox_status_idx;
create index notification_outbox_delivery_idx
  on public.notification_outbox (status, available_at, created_at, id);
create index notification_outbox_expired_lease_idx
  on public.notification_outbox (lease_expires_at, id)
  where status = 'PROCESSING';

-- Provider webhook identifiers are retained without message bodies or phone
-- numbers. The command/outcome fields are enough to prove idempotency and to
-- record an ambiguity diagnostic without PII.
create table public.inbound_sms_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('telnyx', 'twilio')),
  provider_event_id text not null,
  provider_message_id text not null,
  provider_received_at timestamptz not null,
  command text not null check (command in ('TIME', 'HOLD', 'CANCEL', 'UNKNOWN')),
  compliance_classification text check (
    compliance_classification is null
    or compliance_classification in ('STOP', 'START', 'HELP')
  ),
  outcome text not null default 'RECEIVED',
  resolved_session_id uuid references public.sessions (id) on delete set null,
  response_outbox_id uuid references public.notification_outbox (id) on delete set null,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint inbound_sms_events_provider_event_uniq
    unique (provider, provider_event_id),
  constraint inbound_sms_events_provider_message_uniq
    unique (provider, provider_message_id)
);

alter table public.inbound_sms_events enable row level security;

-- ---------------------------------------------------------------------------
-- GSM-7, single-segment message templates used by authoritative functions
-- ---------------------------------------------------------------------------

create or replace function public.sms_ready_body(
  p_pickup_code text,
  p_pickup_window_minutes integer
)
returns text
language sql
immutable
set search_path = ''
as $$
  select format(
    'Panther Carts: Cart ready. Code %s; pickup within %s min. Reply HOLD once to defer or CANCEL to leave. Msg&data rates may apply. STOP=opt out.',
    p_pickup_code,
    greatest(0, p_pickup_window_minutes)
  );
$$;

create or replace function public.sms_signup_waiting_body(
  p_position integer,
  p_estimate integer
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_estimate is null then format(
      'Panther Carts: Joined. #%s; wait TBD. Reply TIME for status, CANCEL to leave, or HOLD once after an offer. Msg&data rates may apply. STOP=opt out.',
      p_position
    )
    else format(
      'Panther Carts: Joined. #%s, est %s min. Reply TIME for status, CANCEL to leave, or HOLD once after an offer. Msg&data rates may apply. STOP=opt out.',
      p_position,
      greatest(0, p_estimate)
    )
  end;
$$;

create or replace function public.sms_hold_body(p_position integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select format(
    'Panther Carts: HOLD confirmed. You are #%s. Reply TIME for status or CANCEL to leave. Msg&data rates may apply. STOP=opt out.',
    p_position
  );
$$;

create or replace function public.sms_time_waiting_body(
  p_position integer,
  p_estimate integer
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_estimate is null then format(
      'Panther Carts: #%s; wait TBD. Reply CANCEL to leave. STOP=opt out.',
      p_position
    )
    else format(
      'Panther Carts: #%s, est %s min. Reply CANCEL to leave. STOP=opt out.',
      p_position,
      greatest(0, p_estimate)
    )
  end;
$$;

-- ---------------------------------------------------------------------------
-- Corrected allocation, signup, and HOLD notification generation
-- ---------------------------------------------------------------------------

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
    v_bin := null;
    v_entry := null;
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
    where id = v_bin.id and session_id = p_session_id;
    update public.queue_entries
    set status = 'READY',
        ready_at = now(),
        pickup_code = v_code,
        reserved_bin_id = v_bin.id,
        pickup_expires_at = now() + make_interval(mins => v_pickup_window),
        queue_rank = null,
        updated_at = now()
    where id = v_entry.id and session_id = p_session_id;

    insert into public.reservations (
      session_id, queue_entry_id, bin_id, status, expires_at
    ) values (
      p_session_id, v_entry.id, v_bin.id, 'ACTIVE',
      now() + make_interval(mins => v_pickup_window)
    ) returning id into v_reservation_id;

    insert into public.notification_outbox (
      session_id, student_id, type, body, dedupe_key, destination_phone
    ) values (
      p_session_id,
      v_entry.student_id,
      'READY',
      public.sms_ready_body(v_code, v_pickup_window),
      'READY:' || v_reservation_id::text,
      v_entry.phone
    ) on conflict (dedupe_key) do nothing;
    v_count := v_count + 1;
  end loop;

  perform public.reindex_waiting_ranks(p_session_id);
  return v_count;
end;
$$;

drop function public.join_queue(uuid, text, text, text, text);

create function public.join_queue(
  p_session_id uuid,
  p_full_name text,
  p_panther_id text,
  p_email text,
  p_phone text,
  p_sms_consent boolean
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
  v_reservation_id uuid;
  v_updated integer;
  v_pickup_window integer;
begin
  v_phone := public.normalize_phone(p_phone);
  if p_sms_consent is distinct from true then
    raise exception 'PANTHER_CARTS:SMS_CONSENT_REQUIRED';
  end if;
  if coalesce(btrim(p_full_name), '') = ''
     or coalesce(btrim(p_panther_id), '') = ''
     or coalesce(btrim(p_email), '') = '' then
    raise exception 'PANTHER_CARTS:INVALID_STUDENT_INPUT';
  end if;
  if not public.is_valid_email(btrim(p_email)) then
    raise exception 'PANTHER_CARTS:INVALID_EMAIL';
  end if;
  if not public.is_valid_phone(v_phone) then
    raise exception 'PANTHER_CARTS:INVALID_PHONE';
  end if;

  -- The phone lock makes cross-session inbound resolution stable while a
  -- signup for this same sender is in progress.
  perform public.lock_idempotency_key('active_phone', v_phone);
  perform public.lock_session(p_session_id);

  select status, pickup_window_minutes
    into v_status, v_pickup_window
  from public.sessions where id = p_session_id;
  if v_status is null then
    raise exception 'PANTHER_CARTS:SESSION_NOT_FOUND';
  end if;
  if v_status <> 'ACTIVE' then
    raise exception 'PANTHER_CARTS:SESSION_NOT_ACTIVE';
  end if;

  if exists (
    select 1 from public.queue_entries qe
    where qe.session_id = p_session_id
      and qe.phone = v_phone
      and qe.status in ('WAITING', 'READY', 'CHECKED_OUT')
  ) then
    raise exception 'PANTHER_CARTS:DUPLICATE_ACTIVE_ENTRY';
  end if;

  insert into public.students (
    session_id, full_name, panther_id, email, phone,
    sms_consent_at, sms_consent_version
  ) values (
    p_session_id, btrim(p_full_name), btrim(p_panther_id), btrim(p_email), v_phone,
    now(), '2026-08-11.transactional-v1'
  ) returning id into v_student_id;

  select coalesce(max(queue_rank), 0) into v_max_rank
  from public.queue_entries
  where session_id = p_session_id and status = 'WAITING';

  insert into public.queue_entries (
    session_id, student_id, phone, status, queue_rank, joined_at
  ) values (
    p_session_id, v_student_id, v_phone, 'WAITING', v_max_rank + 1, now()
  ) returning * into v_entry;

  perform public.allocate_bins(p_session_id);
  select * into v_entry from public.queue_entries
  where id = v_entry.id and session_id = p_session_id;

  if v_entry.status = 'READY' then
    v_position := 0;
    v_estimate := 0;
    v_body := public.sms_ready_body(v_entry.pickup_code, v_pickup_window);
    select r.id into v_reservation_id
    from public.reservations r
    where r.queue_entry_id = v_entry.id
      and r.session_id = p_session_id
      and r.status = 'ACTIVE';

    -- Allocation created READY. Convert that one row into the combined first
    -- signup/pickup message rather than enqueueing INITIAL plus READY.
    update public.notification_outbox
    set type = 'INITIAL',
        body = v_body,
        dedupe_key = 'INITIAL:' || v_entry.id::text,
        destination_phone = v_phone
    where dedupe_key = 'READY:' || v_reservation_id::text
      and session_id = p_session_id;
    get diagnostics v_updated = row_count;
    if v_updated = 0 then
      insert into public.notification_outbox (
        session_id, student_id, type, body, dedupe_key, destination_phone
      ) values (
        p_session_id, v_student_id, 'INITIAL', v_body,
        'INITIAL:' || v_entry.id::text, v_phone
      ) on conflict (dedupe_key) do nothing;
    end if;
  else
    v_position := v_entry.queue_rank;
    v_estimate := public.estimated_wait_minutes(p_session_id, v_position);
    v_body := public.sms_signup_waiting_body(v_position, v_estimate);
    insert into public.notification_outbox (
      session_id, student_id, type, body, dedupe_key, destination_phone
    ) values (
      p_session_id, v_student_id, 'INITIAL', v_body,
      'INITIAL:' || v_entry.id::text, v_phone
    ) on conflict (dedupe_key) do nothing;
  end if;

  return jsonb_build_object(
    'queue_entry', to_jsonb(v_entry),
    'position', v_position,
    'estimated_wait_minutes', v_estimate
  );
end;
$$;

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
  v_holder_outbox_id uuid;
begin
  perform public.lock_session(p_session_id);
  select pickup_window_minutes into v_pickup_window
  from public.sessions where id = p_session_id;
  if v_pickup_window is null then
    raise exception 'PANTHER_CARTS:SESSION_NOT_FOUND';
  end if;

  select * into v_a from public.queue_entries
  where id = p_queue_entry_id and session_id = p_session_id for update;
  if v_a.id is null then raise exception 'PANTHER_CARTS:ENTRY_NOT_FOUND'; end if;
  if v_a.status <> 'READY' then raise exception 'PANTHER_CARTS:ENTRY_NOT_READY'; end if;
  if v_a.hold_used then raise exception 'PANTHER_CARTS:HOLD_ALREADY_USED'; end if;

  select * into v_res from public.reservations
  where queue_entry_id = v_a.id and session_id = p_session_id and status = 'ACTIVE'
  for update;
  if v_res.id is null then raise exception 'PANTHER_CARTS:RESERVATION_NOT_ACTIVE'; end if;
  if v_res.expires_at <= now() then raise exception 'PANTHER_CARTS:RESERVATION_EXPIRED'; end if;
  v_bin_id := v_res.bin_id;
  perform 1 from public.bins where id = v_bin_id and session_id = p_session_id for update;

  select * into v_b from public.queue_entries
  where session_id = p_session_id and status = 'WAITING'
  order by queue_rank asc nulls last, joined_at asc, id asc for update limit 1;
  if v_b.id is null then raise exception 'PANTHER_CARTS:NOBODY_WAITING'; end if;

  update public.reservations set status = 'DEFERRED', ended_at = now()
  where id = v_res.id and session_id = p_session_id;
  v_new_code := public.generate_pickup_code(p_session_id);
  update public.queue_entries
  set status = 'READY', ready_at = now(), pickup_code = v_new_code,
      reserved_bin_id = v_bin_id,
      pickup_expires_at = now() + make_interval(mins => v_pickup_window),
      queue_rank = null, updated_at = now()
  where id = v_b.id and session_id = p_session_id;
  insert into public.reservations (
    session_id, queue_entry_id, bin_id, status, expires_at
  ) values (
    p_session_id, v_b.id, v_bin_id, 'ACTIVE',
    now() + make_interval(mins => v_pickup_window)
  ) returning id into v_new_res_id;

  update public.queue_entries
  set status = 'WAITING', hold_used = true, pickup_code = null,
      reserved_bin_id = null, ready_at = null, pickup_expires_at = null,
      queue_rank = null, updated_at = now()
  where id = v_a.id and session_id = p_session_id;

  select count(*) into v_other_count from public.queue_entries
  where session_id = p_session_id and status = 'WAITING' and id <> v_a.id;
  if v_other_count = 0 then
    update public.queue_entries set queue_rank = 1, updated_at = now()
    where id = v_a.id and session_id = p_session_id;
    v_a_position := 1;
  else
    with others as (
      select id, row_number() over (
        order by queue_rank asc nulls last, joined_at asc, id asc
      ) as rn
      from public.queue_entries
      where session_id = p_session_id and status = 'WAITING' and id <> v_a.id
    )
    update public.queue_entries qe
    set queue_rank = case when o.rn = 1 then 1 else o.rn + 1 end,
        updated_at = now()
    from others o where qe.id = o.id and qe.session_id = p_session_id;
    update public.queue_entries set queue_rank = 2, updated_at = now()
    where id = v_a.id and session_id = p_session_id;
    v_a_position := 2;
  end if;

  insert into public.notification_outbox (
    session_id, student_id, type, body, dedupe_key, destination_phone
  ) values (
    p_session_id, v_b.student_id, 'READY',
    public.sms_ready_body(v_new_code, v_pickup_window),
    'READY:' || v_new_res_id::text, v_b.phone
  ) on conflict (dedupe_key) do nothing;
  insert into public.notification_outbox (
    session_id, student_id, type, body, dedupe_key, destination_phone
  ) values (
    p_session_id, v_a.student_id, 'HOLD',
    public.sms_hold_body(v_a_position),
    'HOLD:' || v_res.id::text, v_a.phone
  ) on conflict (dedupe_key) do update
    set dedupe_key = excluded.dedupe_key
  returning id into v_holder_outbox_id;

  return jsonb_build_object(
    'position', v_a_position,
    'promoted_entry_id', v_b.id,
    'holder_outbox_id', v_holder_outbox_id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Atomic, idempotent CANCEL
-- ---------------------------------------------------------------------------

create or replace function public.cancel_queue_entry(
  p_session_id uuid,
  p_queue_entry_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry public.queue_entries;
  v_res public.reservations;
  v_existing public.notification_outbox;
  v_outbox public.notification_outbox;
  v_dedupe text;
  v_body text;
  v_outcome text;
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    raise exception 'PANTHER_CARTS:IDEMPOTENCY_KEY_REQUIRED';
  end if;
  perform public.lock_session(p_session_id);
  perform public.lock_idempotency_key('cancel_queue_entry', p_idempotency_key);
  v_dedupe := 'CANCEL:' || p_idempotency_key;

  select * into v_existing from public.notification_outbox
  where dedupe_key = v_dedupe;
  if v_existing.id is not null then
    if v_existing.session_id is distinct from p_session_id
       or not exists (
         select 1 from public.queue_entries qe
         where qe.id = p_queue_entry_id
           and qe.session_id = p_session_id
           and qe.student_id = v_existing.student_id
       ) then
      raise exception 'PANTHER_CARTS:IDEMPOTENCY_CONFLICT';
    end if;
    return jsonb_build_object(
      'outcome', 'IDEMPOTENT_REPLAY',
      'outbox_id', v_existing.id,
      'idempotent_replay', true
    );
  end if;

  select * into v_entry from public.queue_entries
  where id = p_queue_entry_id and session_id = p_session_id for update;
  if v_entry.id is null then raise exception 'PANTHER_CARTS:ENTRY_NOT_FOUND'; end if;

  if v_entry.status = 'WAITING' then
    update public.queue_entries
    set status = 'CANCELLED', queue_rank = null, completed_at = now(), updated_at = now()
    where id = v_entry.id and session_id = p_session_id;
    perform public.reindex_waiting_ranks(p_session_id);
    v_body := 'Panther Carts: You left the queue. STOP=opt out.';
    v_outcome := 'WAITING_CANCELLED';
  elsif v_entry.status = 'READY' then
    select * into v_res from public.reservations
    where queue_entry_id = v_entry.id
      and session_id = p_session_id
      and status = 'ACTIVE'
    for update;
    if v_res.id is null then raise exception 'PANTHER_CARTS:RESERVATION_NOT_ACTIVE'; end if;
    perform 1 from public.bins
    where id = v_res.bin_id and session_id = p_session_id for update;
    update public.reservations
    set status = 'CANCELLED', ended_at = now()
    where id = v_res.id and session_id = p_session_id;
    update public.queue_entries
    set status = 'CANCELLED', queue_rank = null, pickup_code = null,
        reserved_bin_id = null, pickup_expires_at = null,
        completed_at = now(), updated_at = now()
    where id = v_entry.id and session_id = p_session_id;
    update public.bins set status = 'AVAILABLE', updated_at = now()
    where id = v_res.bin_id and session_id = p_session_id;
    perform public.allocate_bins(p_session_id);
    v_body := 'Panther Carts: Your pickup offer was canceled and you left the queue. STOP=opt out.';
    v_outcome := 'READY_CANCELLED';
  elsif v_entry.status = 'CHECKED_OUT' then
    if not exists (
      select 1 from public.rentals r
      where r.queue_entry_id = v_entry.id
        and r.session_id = p_session_id
        and r.status = 'OUT'
    ) then
      raise exception 'PANTHER_CARTS:NO_ACTIVE_RENTAL';
    end if;
    v_body := 'Panther Carts: An active rental cannot be canceled by SMS. Return the cart through staff. STOP=opt out.';
    v_outcome := 'CHECKED_OUT_REJECTED';
  else
    raise exception 'PANTHER_CARTS:ENTRY_NOT_ACTIVE';
  end if;

  insert into public.notification_outbox (
    session_id, student_id, type, body, dedupe_key, destination_phone
  ) values (
    p_session_id, v_entry.student_id, 'CANCEL', v_body, v_dedupe, v_entry.phone
  ) returning * into v_outbox;

  if v_outcome in ('WAITING_CANCELLED', 'READY_CANCELLED') then
    insert into public.audit_events (
      session_id, actor_type, action, entity_type, entity_id, metadata
    ) values (
      p_session_id, 'STUDENT_SMS', 'QUEUE_CANCELLED', 'QUEUE_ENTRY',
      v_entry.id::text, jsonb_build_object('previous_status', v_entry.status)
    );
  end if;

  return jsonb_build_object(
    'outcome', v_outcome,
    'outbox_id', v_outbox.id,
    'idempotent_replay', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Provider-scoped inbound idempotency and command dispatch
-- ---------------------------------------------------------------------------

create or replace function public.handle_inbound_sms(
  p_provider text,
  p_provider_event_id text,
  p_provider_message_id text,
  p_from_phone text,
  p_to_phone text,
  p_received_at timestamptz,
  p_command text,
  p_compliance text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.inbound_sms_events;
  v_existing public.inbound_sms_events;
  v_phone text;
  v_match_count integer;
  v_entry public.queue_entries;
  v_outbox public.notification_outbox;
  v_body text;
  v_outcome text;
  v_estimate integer;
  v_minutes integer;
  v_rental_id uuid;
  v_rental_due_at timestamptz;
  v_rental_bin_number text;
  v_hold jsonb;
  v_cancel jsonb;
  v_error text;
  v_session_status public.session_status;
begin
  if p_provider not in ('telnyx', 'twilio')
     or p_provider_event_id is null or btrim(p_provider_event_id) = ''
     or char_length(p_provider_event_id) > 200
     or p_provider_message_id is null or btrim(p_provider_message_id) = ''
     or char_length(p_provider_message_id) > 200
     or p_received_at is null
     or p_command not in ('TIME', 'HOLD', 'CANCEL', 'UNKNOWN')
     or (p_compliance is not null and p_compliance not in ('STOP', 'START', 'HELP')) then
    raise exception 'PANTHER_CARTS:INVALID_SMS_INPUT';
  end if;
  v_phone := public.normalize_phone(p_from_phone);
  if not public.is_valid_phone(v_phone)
     or not public.is_valid_phone(public.normalize_phone(p_to_phone)) then
    raise exception 'PANTHER_CARTS:INVALID_PHONE';
  end if;

  perform public.lock_idempotency_key(
    'inbound_sms_event', p_provider || ':' || p_provider_event_id
  );
  perform public.lock_idempotency_key(
    'inbound_sms_message', p_provider || ':' || p_provider_message_id
  );
  select * into v_existing from public.inbound_sms_events
  where provider = p_provider
    and (
      provider_event_id = p_provider_event_id
      or provider_message_id = p_provider_message_id
    );
  if v_existing.id is not null then
    return jsonb_build_object(
      'duplicate', true,
      'outcome', v_existing.outcome,
      'response_outbox_id', v_existing.response_outbox_id
    );
  end if;

  insert into public.inbound_sms_events (
    provider, provider_event_id, provider_message_id, provider_received_at,
    command, compliance_classification
  ) values (
    p_provider, p_provider_event_id, p_provider_message_id, p_received_at,
    p_command, p_compliance
  ) returning * into v_event;

  -- Telnyx autoresponse_type or Twilio OptOutType means the provider has
  -- already handled and replied. Never mutate the queue or send a duplicate.
  if p_compliance is not null then
    v_outcome := case
      when p_command = 'UNKNOWN' then 'COMPLIANCE_ACKNOWLEDGED'
      else 'COMPLIANCE_OVERRODE_COMMAND'
    end;
    update public.inbound_sms_events
    set outcome = v_outcome, processed_at = now()
    where id = v_event.id;
    return jsonb_build_object(
      'duplicate', false,
      'outcome', v_outcome,
      'response_outbox_id', null
    );
  end if;

  if p_command = 'UNKNOWN' then
    insert into public.notification_outbox (
      type, body, dedupe_key, destination_phone
    ) values (
      'UNKNOWN',
      'Panther Carts: Reply TIME, HOLD, or CANCEL for queue help. Reply STOP to opt out.',
      'UNKNOWN:' || p_provider || ':' || p_provider_event_id,
      v_phone
    ) returning * into v_outbox;
    update public.inbound_sms_events
    set outcome = 'UNKNOWN_COMMAND', response_outbox_id = v_outbox.id,
        processed_at = now()
    where id = v_event.id;
    return jsonb_build_object(
      'duplicate', false,
      'outcome', 'UNKNOWN_COMMAND',
      'response_outbox_id', v_outbox.id
    );
  end if;

  -- Stabilize resolution against another signup for this same normalized
  -- number, then count every active lifecycle in an ACTIVE session.
  perform public.lock_idempotency_key('active_phone', v_phone);
  select count(*) into v_match_count
  from public.queue_entries qe
  join public.sessions s on s.id = qe.session_id
  where qe.phone = v_phone
    and qe.status in ('WAITING', 'READY', 'CHECKED_OUT')
    and s.status = 'ACTIVE';

  if v_match_count = 0 then
    insert into public.notification_outbox (
      type, body, dedupe_key, destination_phone
    ) values (
      p_command::public.notification_type,
      'Panther Carts: No active queue, reservation, or rental was found. Reply STOP to opt out.',
      'RESPONSE:' || p_provider || ':' || p_provider_event_id,
      v_phone
    ) returning * into v_outbox;
    v_outcome := 'NO_ACTIVE_MATCH';
  elsif v_match_count > 1 then
    insert into public.notification_outbox (
      type, body, dedupe_key, destination_phone
    ) values (
      p_command::public.notification_type,
      'Panther Carts: We could not safely match this number to one active session. Contact staff. STOP=opt out.',
      'RESPONSE:' || p_provider || ':' || p_provider_event_id,
      v_phone
    ) returning * into v_outbox;
    v_outcome := 'AMBIGUOUS_ACTIVE_MATCH';
  else
    select qe.* into v_entry
    from public.queue_entries qe
    join public.sessions s on s.id = qe.session_id
    where qe.phone = v_phone
      and qe.status in ('WAITING', 'READY', 'CHECKED_OUT')
      and s.status = 'ACTIVE';
    perform public.lock_session(v_entry.session_id);

    -- Recheck both session and exact entry after the session lock is held. An
    -- admin close or competing lifecycle mutation may have committed while
    -- this webhook was waiting for the lock.
    select status into v_session_status from public.sessions
    where id = v_entry.session_id for update;
    select * into v_entry from public.queue_entries
    where id = v_entry.id and session_id = v_entry.session_id for update;
    if v_session_status is distinct from 'ACTIVE'
       or v_entry.status not in ('WAITING', 'READY', 'CHECKED_OUT') then
      insert into public.notification_outbox (
        type, body, dedupe_key, destination_phone
      ) values (
        p_command::public.notification_type,
        'Panther Carts: No active queue, reservation, or rental was found. Reply STOP to opt out.',
        'RESPONSE:' || p_provider || ':' || p_provider_event_id,
        v_phone
      ) returning * into v_outbox;
      update public.inbound_sms_events
      set outcome = 'NO_ACTIVE_MATCH', response_outbox_id = v_outbox.id,
          processed_at = now()
      where id = v_event.id;
      return jsonb_build_object(
        'duplicate', false,
        'outcome', 'NO_ACTIVE_MATCH',
        'response_outbox_id', v_outbox.id
      );
    end if;

    if p_command = 'TIME' then
      if v_entry.status = 'WAITING' then
        v_estimate := public.estimated_wait_minutes(
          v_entry.session_id, v_entry.queue_rank
        );
        v_body := public.sms_time_waiting_body(v_entry.queue_rank, v_estimate);
        v_outcome := 'TIME_WAITING';
      elsif v_entry.status = 'READY' then
        v_minutes := greatest(
          0,
          ceil(extract(epoch from (v_entry.pickup_expires_at - now())) / 60.0)::integer
        );
        v_body := format(
          'Panther Carts: Cart ready. Code %s; %s min left to pick up. Reply HOLD once or CANCEL to leave. STOP=opt out.',
          v_entry.pickup_code,
          v_minutes
        );
        v_outcome := 'TIME_READY';
      else
        select r.id, r.due_at, b.bin_number
          into v_rental_id, v_rental_due_at, v_rental_bin_number
        from public.rentals r
        join public.bins b on b.id = r.bin_id and b.session_id = r.session_id
        where r.queue_entry_id = v_entry.id
          and r.session_id = v_entry.session_id
          and r.status = 'OUT'
        for update of r;
        if v_rental_due_at is null then raise exception 'PANTHER_CARTS:NO_ACTIVE_RENTAL'; end if;
        if now() > v_rental_due_at then
          v_minutes := greatest(0, ceil(extract(epoch from (now() - v_rental_due_at)) / 60.0)::integer);
          v_body := format(
            'Panther Carts: Bin %s is %s min overdue. Return it through staff. STOP=opt out.',
            v_rental_bin_number, v_minutes
          );
          v_outcome := 'TIME_OVERDUE';
        else
          v_minutes := greatest(0, ceil(extract(epoch from (v_rental_due_at - now())) / 60.0)::integer);
          v_body := format(
            'Panther Carts: Bin %s has %s min remaining. Return it through staff when done. STOP=opt out.',
            v_rental_bin_number, v_minutes
          );
          v_outcome := 'TIME_CHECKED_OUT';
        end if;
      end if;
      insert into public.notification_outbox (
        session_id, student_id, rental_id, type, body, dedupe_key,
        destination_phone
      ) values (
        v_entry.session_id, v_entry.student_id,
        case when v_entry.status = 'CHECKED_OUT' then v_rental_id else null end,
        'TIME', v_body,
        'TIME:' || p_provider || ':' || p_provider_event_id,
        v_entry.phone
      ) returning * into v_outbox;
    elsif p_command = 'HOLD' then
      if v_entry.hold_used then
        v_body := 'Panther Carts: HOLD was already used. Reply TIME for status or CANCEL to leave. STOP=opt out.';
        v_outcome := 'HOLD_ALREADY_USED';
      elsif v_entry.status <> 'READY' then
        v_body := 'Panther Carts: HOLD is available only after a cart offer. Reply TIME for status. STOP=opt out.';
        v_outcome := 'HOLD_NOT_READY';
      else
        begin
          v_hold := public.hold_reservation(v_entry.session_id, v_entry.id);
          select * into v_outbox from public.notification_outbox
          where id = (v_hold->>'holder_outbox_id')::uuid
            and session_id = v_entry.session_id;
          if v_outbox.id is null then raise exception 'PANTHER_CARTS:HOLD_OUTBOX_MISSING'; end if;
          v_outcome := 'HOLD_CONFIRMED';
        exception when others then
          get stacked diagnostics v_error = message_text;
          if position('PANTHER_CARTS:NOBODY_WAITING' in v_error) > 0 then
            v_body := 'Panther Carts: HOLD is unavailable because nobody is waiting. Reply TIME for status. STOP=opt out.';
            v_outcome := 'HOLD_NOBODY_WAITING';
          elsif position('PANTHER_CARTS:RESERVATION_EXPIRED' in v_error) > 0
             or position('PANTHER_CARTS:RESERVATION_NOT_ACTIVE' in v_error) > 0
             or position('PANTHER_CARTS:ENTRY_NOT_READY' in v_error) > 0 then
            v_body := 'Panther Carts: That pickup offer is no longer active. Reply TIME for status. STOP=opt out.';
            v_outcome := 'HOLD_NOT_ACTIVE';
          else
            raise;
          end if;
        end;
      end if;
      if v_outbox.id is null then
        insert into public.notification_outbox (
          session_id, student_id, type, body, dedupe_key, destination_phone
        ) values (
          v_entry.session_id, v_entry.student_id, 'HOLD', v_body,
          'HOLD_RESPONSE:' || p_provider || ':' || p_provider_event_id,
          v_entry.phone
        ) returning * into v_outbox;
      end if;
    else
      begin
        v_cancel := public.cancel_queue_entry(
          v_entry.session_id,
          v_entry.id,
          p_provider || ':' || p_provider_event_id
        );
        v_outcome := v_cancel->>'outcome';
        select * into v_outbox from public.notification_outbox
        where id = (v_cancel->>'outbox_id')::uuid
          and session_id = v_entry.session_id;
      exception when others then
        get stacked diagnostics v_error = message_text;
        if position('PANTHER_CARTS:RESERVATION_NOT_ACTIVE' in v_error) > 0
           or position('PANTHER_CARTS:NO_ACTIVE_RENTAL' in v_error) > 0
           or position('PANTHER_CARTS:ENTRY_NOT_ACTIVE' in v_error) > 0 then
          v_body := 'Panther Carts: That queue or rental state is no longer active. Reply TIME for status. STOP=opt out.';
          v_outcome := 'CANCEL_NOT_ACTIVE';
        elsif position('PANTHER_CARTS:IDEMPOTENCY_CONFLICT' in v_error) > 0 then
          v_body := 'Panther Carts: CANCEL could not be applied safely. Reply TIME for status or contact staff. STOP=opt out.';
          v_outcome := 'CANCEL_UNAVAILABLE';
        else
          raise;
        end if;
      end;
      if v_outbox.id is null then
        insert into public.notification_outbox (
          session_id, student_id, type, body, dedupe_key, destination_phone
        ) values (
          v_entry.session_id, v_entry.student_id, 'CANCEL', v_body,
          'CANCEL_RESPONSE:' || p_provider || ':' || p_provider_event_id,
          v_entry.phone
        ) returning * into v_outbox;
      end if;
    end if;
  end if;

  update public.inbound_sms_events
  set outcome = v_outcome,
      resolved_session_id = case
        when v_match_count = 1 then v_entry.session_id else null
      end,
      response_outbox_id = v_outbox.id,
      processed_at = now()
  where id = v_event.id;
  return jsonb_build_object(
    'duplicate', false,
    'outcome', v_outcome,
    'response_outbox_id', v_outbox.id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Concurrent outbox claim/lease and bounded delivery completion
-- ---------------------------------------------------------------------------

create or replace function public.claim_notification_outbox(
  p_worker_id text,
  p_limit integer,
  p_lease_seconds integer,
  p_max_attempts integer
)
returns table (
  id uuid,
  destination_phone text,
  body text,
  attempts integer,
  claim_token uuid,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_worker_id is null or btrim(p_worker_id) = ''
     or p_limit is null or p_limit < 1 or p_limit > 3
     or p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 900
     or p_max_attempts is null or p_max_attempts < 1 or p_max_attempts > 20 then
    raise exception 'PANTHER_CARTS:INVALID_OUTBOX_WORKER_INPUT';
  end if;

  with exhausted as (
    select o.id
    from public.notification_outbox o
    where o.attempts >= p_max_attempts
      and (
        o.status = 'PENDING'
        or (o.status = 'PROCESSING' and o.lease_expires_at <= now())
      )
    for update skip locked
  )
  update public.notification_outbox o
  set status = 'FAILED',
      last_error = case
        when o.status = 'PROCESSING'
          then 'DELIVERY_OUTCOME_UNKNOWN_AFTER_FINAL_LEASE'
        else coalesce(o.last_error, 'MAX_ATTEMPTS_REACHED')
      end,
      claimed_at = null,
      lease_expires_at = null,
      claim_token = null
  from exhausted e
  where o.id = e.id;

  return query
  with candidates as (
    select o.id
    from public.notification_outbox o
    where o.attempts < p_max_attempts
      and (
        (o.status = 'PENDING' and o.available_at <= now())
        or (o.status = 'PROCESSING' and o.lease_expires_at <= now())
      )
    order by o.available_at asc, o.created_at asc, o.id asc
    for update skip locked
    limit p_limit
  ), claimed as (
    update public.notification_outbox o
    set status = 'PROCESSING',
        attempts = o.attempts + 1,
        claimed_at = now(),
        lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        claim_token = gen_random_uuid(),
        last_error = null
    from candidates c
    where o.id = c.id
    returning o.id, o.destination_phone, o.body, o.attempts, o.claim_token,
      o.lease_expires_at
  )
  select c.id, c.destination_phone, c.body, c.attempts, c.claim_token,
    c.lease_expires_at
  from claimed c
  order by c.id;
end;
$$;

create or replace function public.complete_notification_outbox_sent(
  p_outbox_id uuid,
  p_claim_token uuid,
  p_provider_message_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_provider_message_id is null or btrim(p_provider_message_id) = ''
     or char_length(p_provider_message_id) > 200 then
    raise exception 'PANTHER_CARTS:INVALID_PROVIDER_MESSAGE_ID';
  end if;
  update public.notification_outbox
  set status = 'SENT', provider_message_id = p_provider_message_id,
      sent_at = now(), claimed_at = null, lease_expires_at = null,
      claim_token = null, last_error = null
  where id = p_outbox_id and status = 'PROCESSING'
    and claim_token = p_claim_token;
  if found then return true; end if;

  -- Provider acceptance happened, but this token no longer owns the row.
  -- Preserve forensic evidence without changing the current owner's state.
  update public.notification_outbox
  set unconfirmed_provider_message_id = coalesce(
        unconfirmed_provider_message_id, p_provider_message_id
      ),
      delivery_outcome_unknown_at = coalesce(
        delivery_outcome_unknown_at, now()
      ),
      last_error = case
        when status = 'SENT' then last_error
        else 'DELIVERY_ACCEPTED_FOR_STALE_CLAIM'
      end
  where id = p_outbox_id;
  return false;
end;
$$;

create or replace function public.complete_notification_outbox_failure(
  p_outbox_id uuid,
  p_claim_token uuid,
  p_retryable boolean,
  p_error text,
  p_max_attempts integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempts integer;
  v_error text;
begin
  if p_max_attempts is null or p_max_attempts < 1 or p_max_attempts > 20 then
    raise exception 'PANTHER_CARTS:INVALID_OUTBOX_WORKER_INPUT';
  end if;
  v_error := left(
    regexp_replace(coalesce(p_error, 'DELIVERY_ERROR'), '[^A-Za-z0-9_:-]', '', 'g'),
    120
  );
  select attempts into v_attempts from public.notification_outbox
  where id = p_outbox_id and status = 'PROCESSING'
    and claim_token = p_claim_token
  for update;
  if v_attempts is null then return false; end if;

  if p_retryable is true and v_attempts < p_max_attempts then
    update public.notification_outbox
    set status = 'PENDING',
        available_at = now() + make_interval(
          secs => least(3600, (15 * power(2, greatest(0, v_attempts - 1)))::integer)
        ),
        claimed_at = null, lease_expires_at = null, claim_token = null,
        last_error = v_error
    where id = p_outbox_id;
  else
    update public.notification_outbox
    set status = 'FAILED', claimed_at = null, lease_expires_at = null,
        claim_token = null, last_error = v_error
    where id = p_outbox_id;
  end if;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on public.inbound_sms_events from public;
revoke execute on all functions in schema public from public;

do $$
declare
  v_role text;
  v_function text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('revoke all on public.inbound_sms_events from %I', v_role);
      execute format(
        'revoke execute on all functions in schema public from %I', v_role
      );
    end if;
  end loop;

  foreach v_function in array array[
    'join_queue(uuid,text,text,text,text,boolean)',
    'cancel_queue_entry(uuid,uuid,text)',
    'handle_inbound_sms(text,text,text,text,text,timestamptz,text,text)',
    'claim_notification_outbox(text,integer,integer,integer)',
    'complete_notification_outbox_sent(uuid,uuid,text)',
    'complete_notification_outbox_failure(uuid,uuid,boolean,text,integer)'
  ] loop
    execute format('revoke execute on function public.%s from public', v_function);
    foreach v_role in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = v_role) then
        execute format('revoke execute on function public.%s from %I', v_function, v_role);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function public.%s to service_role', v_function);
    end if;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on public.inbound_sms_events to service_role';
  end if;
end;
$$;
