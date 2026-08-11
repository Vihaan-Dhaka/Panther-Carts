-- Panther Carts — Ticket 4: authoritative admin dashboard mutations
--
-- Session lifecycle, bulk bin creation, and manual notification enqueueing
-- are trusted server-only RPCs. Every session-bound mutation takes the same
-- advisory lock as the queue engine, and all public execution is revoked.

alter table public.sessions
  add column creation_idempotency_key text,
  add column creation_request_fingerprint text;

create unique index sessions_creation_idempotency_uidx
  on public.sessions (creation_idempotency_key)
  where creation_idempotency_key is not null;

-- Sessions created by the dashboard are the production session lifecycle.
-- Keep exactly one of those sessions open while preserving Ticket 1's ability
-- to exercise independent, directly-seeded sessions concurrently.
create unique index sessions_one_dashboard_open_uidx
  on public.sessions ((true))
  where creation_idempotency_key is not null
    and status in ('DRAFT', 'ACTIVE');

create or replace function public.admin_create_session(
  p_name text,
  p_rental_duration_minutes integer,
  p_pickup_window_minutes integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.sessions;
  v_fingerprint text;
  v_student_code text;
  v_staff_code text;
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    raise exception 'PANTHER_CARTS:IDEMPOTENCY_KEY_REQUIRED';
  end if;
  if p_name is null or btrim(p_name) = ''
     or p_rental_duration_minutes is null or p_rental_duration_minutes <= 0
     or p_pickup_window_minutes is null or p_pickup_window_minutes <= 0 then
    raise exception 'PANTHER_CARTS:INVALID_ADMIN_INPUT';
  end if;

  -- Different browser renders carry different request keys, so creation also
  -- needs a lifecycle-wide lock to make the one-open-session check atomic.
  perform public.lock_idempotency_key('admin_create_session_open', 'singleton');
  perform public.lock_idempotency_key('admin_create_session', p_idempotency_key);
  v_fingerprint := jsonb_build_object(
    'name', btrim(p_name),
    'rental_duration_minutes', p_rental_duration_minutes,
    'pickup_window_minutes', p_pickup_window_minutes
  )::text;

  select * into v_session
  from public.sessions
  where creation_idempotency_key = p_idempotency_key;

  if v_session.id is not null then
    if v_session.creation_request_fingerprint is distinct from v_fingerprint then
      raise exception 'PANTHER_CARTS:IDEMPOTENCY_CONFLICT';
    end if;
    return jsonb_build_object(
      'session', to_jsonb(v_session),
      'idempotent_replay', true
    );
  end if;

  if exists (
    select 1
    from public.sessions
    where creation_idempotency_key is not null
      and status in ('DRAFT', 'ACTIVE')
  ) then
    raise exception 'PANTHER_CARTS:SESSION_ALREADY_OPEN';
  end if;

  -- PostgreSQL's UUID generator is cryptographically random. Generate bearer
  -- credentials only after idempotency replay has been ruled out so retries
  -- return the stored codes without deriving them from the request key.
  v_student_code := 'signup-' || replace(gen_random_uuid()::text, '-', '');
  v_staff_code := 'staff-' || replace(gen_random_uuid()::text, '-', '');

  insert into public.sessions (
    name,
    status,
    student_code,
    staff_code,
    rental_duration_minutes,
    pickup_window_minutes,
    creation_idempotency_key,
    creation_request_fingerprint
  ) values (
    btrim(p_name),
    'DRAFT',
    v_student_code,
    v_staff_code,
    p_rental_duration_minutes,
    p_pickup_window_minutes,
    p_idempotency_key,
    v_fingerprint
  ) returning * into v_session;

  insert into public.audit_events (
    session_id, actor_type, actor_id, action, entity_type, entity_id, metadata
  ) values (
    v_session.id,
    'ADMIN',
    'Admin dashboard',
    'SESSION_CREATED',
    'SESSION',
    v_session.id::text,
    jsonb_build_object(
      'rental_duration_minutes', p_rental_duration_minutes,
      'pickup_window_minutes', p_pickup_window_minutes
    )
  );

  return jsonb_build_object(
    'session', to_jsonb(v_session),
    'idempotent_replay', false
  );
end;
$$;

create or replace function public.admin_configure_session(
  p_session_id uuid,
  p_rental_duration_minutes integer,
  p_pickup_window_minutes integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.sessions;
begin
  perform public.lock_session(p_session_id);

  select * into v_session
  from public.sessions
  where id = p_session_id
  for update;

  if v_session.id is null then
    raise exception 'PANTHER_CARTS:SESSION_NOT_FOUND';
  end if;
  if v_session.status = 'CLOSED' then
    raise exception 'PANTHER_CARTS:SESSION_CLOSED';
  end if;
  if p_rental_duration_minutes is null or p_rental_duration_minutes <= 0
     or p_pickup_window_minutes is null or p_pickup_window_minutes <= 0 then
    raise exception 'PANTHER_CARTS:INVALID_ADMIN_INPUT';
  end if;

  if v_session.rental_duration_minutes = p_rental_duration_minutes
     and v_session.pickup_window_minutes = p_pickup_window_minutes then
    return jsonb_build_object(
      'session', to_jsonb(v_session),
      'idempotent_replay', true
    );
  end if;

  update public.sessions
  set rental_duration_minutes = p_rental_duration_minutes,
      pickup_window_minutes = p_pickup_window_minutes
  where id = p_session_id
  returning * into v_session;

  insert into public.audit_events (
    session_id, actor_type, actor_id, action, entity_type, entity_id, metadata
  ) values (
    p_session_id,
    'ADMIN',
    'Admin dashboard',
    'SESSION_CONFIGURED',
    'SESSION',
    p_session_id::text,
    jsonb_build_object(
      'rental_duration_minutes', p_rental_duration_minutes,
      'pickup_window_minutes', p_pickup_window_minutes
    )
  );

  return jsonb_build_object(
    'session', to_jsonb(v_session),
    'idempotent_replay', false
  );
end;
$$;

create or replace function public.admin_start_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.sessions;
begin
  perform public.lock_session(p_session_id);

  select * into v_session
  from public.sessions
  where id = p_session_id
  for update;

  if v_session.id is null then
    raise exception 'PANTHER_CARTS:SESSION_NOT_FOUND';
  end if;
  if v_session.status = 'ACTIVE' then
    return jsonb_build_object(
      'session', to_jsonb(v_session),
      'idempotent_replay', true
    );
  end if;
  if v_session.status <> 'DRAFT' then
    raise exception 'PANTHER_CARTS:SESSION_NOT_DRAFT';
  end if;

  update public.sessions
  set status = 'ACTIVE', started_at = coalesce(started_at, now()), ended_at = null
  where id = p_session_id
  returning * into v_session;

  insert into public.audit_events (
    session_id, actor_type, actor_id, action, entity_type, entity_id
  ) values (
    p_session_id,
    'ADMIN',
    'Admin dashboard',
    'SESSION_STARTED',
    'SESSION',
    p_session_id::text
  );

  return jsonb_build_object(
    'session', to_jsonb(v_session),
    'idempotent_replay', false
  );
end;
$$;

create or replace function public.admin_end_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.sessions;
begin
  perform public.lock_session(p_session_id);

  select * into v_session
  from public.sessions
  where id = p_session_id
  for update;

  if v_session.id is null then
    raise exception 'PANTHER_CARTS:SESSION_NOT_FOUND';
  end if;
  if v_session.status = 'CLOSED' then
    return jsonb_build_object(
      'session', to_jsonb(v_session),
      'idempotent_replay', true
    );
  end if;
  if v_session.status <> 'ACTIVE' then
    raise exception 'PANTHER_CARTS:SESSION_NOT_ACTIVE';
  end if;

  update public.sessions
  set status = 'CLOSED', ended_at = coalesce(ended_at, now())
  where id = p_session_id
  returning * into v_session;

  insert into public.audit_events (
    session_id, actor_type, actor_id, action, entity_type, entity_id
  ) values (
    p_session_id,
    'ADMIN',
    'Admin dashboard',
    'SESSION_ENDED',
    'SESSION',
    p_session_id::text
  );

  return jsonb_build_object(
    'session', to_jsonb(v_session),
    'idempotent_replay', false
  );
end;
$$;

create or replace function public.admin_add_bins(
  p_session_id uuid,
  p_bin_numbers text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.session_status;
  v_has_invalid boolean;
  v_added text[];
  v_duplicates text[];
begin
  perform public.lock_session(p_session_id);

  select status into v_status
  from public.sessions
  where id = p_session_id
  for update;

  if v_status is null then
    raise exception 'PANTHER_CARTS:SESSION_NOT_FOUND';
  end if;
  if v_status = 'CLOSED' then
    raise exception 'PANTHER_CARTS:SESSION_CLOSED';
  end if;
  if p_bin_numbers is null or cardinality(p_bin_numbers) = 0 then
    raise exception 'PANTHER_CARTS:INVALID_ADMIN_INPUT';
  end if;

  select exists (
    select 1
    from unnest(p_bin_numbers) as input(value)
    where value is null or btrim(value) !~ '^[1-9][0-9]{0,5}$'
  ) into v_has_invalid;
  if v_has_invalid then
    raise exception 'PANTHER_CARTS:INVALID_ADMIN_INPUT';
  end if;

  with normalized as (
    select distinct btrim(value) as bin_number
    from unnest(p_bin_numbers) as input(value)
  ), existing as (
    select n.bin_number
    from normalized n
    join public.bins b
      on b.session_id = p_session_id and b.bin_number = n.bin_number
  ), inserted as (
    insert into public.bins (session_id, bin_number)
    select p_session_id, n.bin_number
    from normalized n
    on conflict (session_id, bin_number) do nothing
    returning bin_number
  )
  select
    coalesce(
      array_agg(i.bin_number order by i.bin_number::integer)
        filter (where i.bin_number is not null),
      array[]::text[]
    ),
    coalesce(
      (select array_agg(e.bin_number order by e.bin_number::integer) from existing e),
      array[]::text[]
    )
  into v_added, v_duplicates
  from inserted i;

  if cardinality(v_added) > 0 then
    insert into public.audit_events (
      session_id, actor_type, actor_id, action, entity_type, metadata
    ) values (
      p_session_id,
      'ADMIN',
      'Admin dashboard',
      'BINS_ADDED',
      'BIN',
      jsonb_build_object('bin_numbers', to_jsonb(v_added))
    );
  end if;

  return jsonb_build_object(
    'added', to_jsonb(v_added),
    'duplicates', to_jsonb(v_duplicates)
  );
end;
$$;

create or replace function public.admin_notify_rental(
  p_session_id uuid,
  p_rental_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rental record;
  v_existing public.notification_outbox;
  v_outbox public.notification_outbox;
  v_dedupe_key text;
  v_minutes integer;
  v_body text;
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    raise exception 'PANTHER_CARTS:IDEMPOTENCY_KEY_REQUIRED';
  end if;

  perform public.lock_session(p_session_id);
  perform public.lock_idempotency_key('admin_notify', p_idempotency_key);

  v_dedupe_key := 'MANUAL:' || p_idempotency_key;
  select * into v_existing
  from public.notification_outbox
  where dedupe_key = v_dedupe_key;

  if v_existing.id is not null then
    if v_existing.session_id <> p_session_id
       or v_existing.rental_id is distinct from p_rental_id then
      raise exception 'PANTHER_CARTS:IDEMPOTENCY_CONFLICT';
    end if;
    return jsonb_build_object(
      'outbox_id', v_existing.id,
      'body', v_existing.body,
      'idempotent_replay', true
    );
  end if;

  select
    r.id,
    r.session_id,
    r.student_id,
    r.due_at,
    b.bin_number
  into v_rental
  from public.rentals r
  join public.bins b
    on b.id = r.bin_id and b.session_id = r.session_id
  where r.id = p_rental_id
    and r.session_id = p_session_id
    and r.status = 'OUT'
  for update of r;

  if v_rental.id is null then
    raise exception 'PANTHER_CARTS:NO_ACTIVE_RENTAL';
  end if;

  if now() > v_rental.due_at then
    v_minutes := greatest(
      0,
      ceil(extract(epoch from (now() - v_rental.due_at)) / 60.0)::integer
    );
    v_body := format(
      'Panther Carts: Bin %s is %s minute%s overdue. Please return it to staff.',
      v_rental.bin_number,
      v_minutes,
      case when v_minutes = 1 then '' else 's' end
    );
  else
    v_minutes := greatest(
      0,
      ceil(extract(epoch from (v_rental.due_at - now())) / 60.0)::integer
    );
    v_body := format(
      'Panther Carts: Bin %s has %s minute%s remaining in the rental.',
      v_rental.bin_number,
      v_minutes,
      case when v_minutes = 1 then '' else 's' end
    );
  end if;

  insert into public.notification_outbox (
    session_id,
    student_id,
    rental_id,
    type,
    body,
    dedupe_key
  ) values (
    p_session_id,
    v_rental.student_id,
    p_rental_id,
    'MANUAL',
    v_body,
    v_dedupe_key
  ) returning * into v_outbox;

  insert into public.audit_events (
    session_id, actor_type, actor_id, action, entity_type, entity_id,
    metadata
  ) values (
    p_session_id,
    'ADMIN',
    'Admin dashboard',
    'RENTAL_NOTIFY_ENQUEUED',
    'RENTAL',
    p_rental_id::text,
    jsonb_build_object('outbox_id', v_outbox.id)
  );

  return jsonb_build_object(
    'outbox_id', v_outbox.id,
    'body', v_outbox.body,
    'idempotent_replay', false
  );
end;
$$;

do $$
declare
  v_role text;
  v_function text;
begin
  foreach v_function in array array[
    'admin_create_session(text,integer,integer,text)',
    'admin_configure_session(uuid,integer,integer)',
    'admin_start_session(uuid)',
    'admin_end_session(uuid)',
    'admin_add_bins(uuid,text[])',
    'admin_notify_rental(uuid,uuid,text)'
  ] loop
    execute format('revoke execute on function public.%s from public', v_function);
    foreach v_role in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = v_role) then
        execute format(
          'revoke execute on function public.%s from %I',
          v_function,
          v_role
        );
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format(
        'grant execute on function public.%s to service_role',
        v_function
      );
    end if;
  end loop;
end;
$$;
