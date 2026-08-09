-- Panther Carts — Ticket 1: core schema
--
-- Tables, enums, constraints, and indexes for the cart-rental queue engine.
-- Authoritative queue mutations live in PostgreSQL functions (see the
-- functions migration); this file only defines storage and invariants.
--
-- Student personal data (full_name, panther_id, email, phone) is stored in
-- plain columns here. Column-level encryption, retention windows, and the RLS
-- policies that restrict who may read it are Ticket 6 work — see
-- docs/DATABASE.md ("Deferred to Ticket 6"). No real student data is seeded.

-- gen_random_uuid() is provided by core PostgreSQL (pg13+) on Supabase.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.session_status as enum ('DRAFT', 'ACTIVE', 'CLOSED');

create type public.bin_status as enum ('AVAILABLE', 'RESERVED', 'OUT');

create type public.queue_entry_status as enum (
  'WAITING',
  'READY',
  'CHECKED_OUT',
  'CANCELLED',
  'EXPIRED',
  'RETURNED'
);

create type public.reservation_status as enum (
  'ACTIVE',
  'CLAIMED',
  'DEFERRED',
  'EXPIRED',
  'CANCELLED'
);

create type public.rental_status as enum ('OUT', 'RETURNED');

create type public.notification_type as enum (
  'INITIAL',
  'READY',
  'TIME',
  'HOLD',
  'CANCEL',
  'MANUAL'
);

create type public.notification_status as enum (
  'PENDING',
  'PROCESSING',
  'SENT',
  'FAILED'
);

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status public.session_status not null default 'DRAFT',
  student_code text not null unique,
  staff_code text not null unique,
  rental_duration_minutes integer not null,
  pickup_window_minutes integer not null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz,
  constraint sessions_rental_duration_positive check (rental_duration_minutes > 0),
  constraint sessions_pickup_window_positive check (pickup_window_minutes > 0)
);

-- ---------------------------------------------------------------------------
-- students
-- ---------------------------------------------------------------------------
create table public.students (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  full_name text not null,
  panther_id text not null,
  email text not null,
  -- Normalized to E.164 by public.normalize_phone() before insert.
  phone text not null,
  created_at timestamptz not null default now()
);

create index students_session_idx on public.students (session_id);
create index students_session_phone_idx on public.students (session_id, phone);
create index students_session_panther_idx on public.students (session_id, panther_id);

-- ---------------------------------------------------------------------------
-- bins
-- ---------------------------------------------------------------------------
create table public.bins (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  bin_number text not null,
  status public.bin_status not null default 'AVAILABLE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bins_number_unique_per_session unique (session_id, bin_number)
);

create index bins_session_status_idx on public.bins (session_id, status);

-- ---------------------------------------------------------------------------
-- queue_entries
-- ---------------------------------------------------------------------------
-- `phone` is denormalized from students so the "one active entry per phone per
-- session" invariant can be enforced by a partial unique index (a partial
-- unique index cannot span a join). It always mirrors the linked student.
create table public.queue_entries (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  student_id uuid not null references public.students (id) on delete cascade,
  phone text not null,
  status public.queue_entry_status not null default 'WAITING',
  queue_rank integer,
  pickup_code text,
  reserved_bin_id uuid references public.bins (id),
  hold_used boolean not null default false,
  joined_at timestamptz not null default now(),
  ready_at timestamptz,
  pickup_expires_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint queue_entries_pickup_code_format
    check (pickup_code is null or pickup_code ~ '^[0-9]{4}$'),
  constraint queue_entries_ready_fields check (
    status <> 'READY'
    or (
      pickup_code is not null
      and reserved_bin_id is not null
      and pickup_expires_at is not null
    )
  )
);

-- One active queue entry per normalized phone per session. Active = the
-- student currently occupies a slot in the lifecycle (waiting, offered a bin,
-- or holding a cart). Terminal states (CANCELLED, EXPIRED, RETURNED) are
-- excluded so a student may rejoin later.
create unique index queue_entries_active_phone_uidx
  on public.queue_entries (session_id, phone)
  where status in ('WAITING', 'READY', 'CHECKED_OUT');

-- Pickup codes only need to be unique among active READY entries in a session.
create unique index queue_entries_ready_pickup_code_uidx
  on public.queue_entries (session_id, pickup_code)
  where status = 'READY' and pickup_code is not null;

create index queue_entries_waiting_order_idx
  on public.queue_entries (session_id, queue_rank, joined_at, id)
  where status = 'WAITING';

create index queue_entries_session_status_idx
  on public.queue_entries (session_id, status);

-- ---------------------------------------------------------------------------
-- reservations
-- ---------------------------------------------------------------------------
create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  queue_entry_id uuid not null references public.queue_entries (id) on delete cascade,
  bin_id uuid not null references public.bins (id) on delete cascade,
  status public.reservation_status not null default 'ACTIVE',
  reserved_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz
);

-- At most one ACTIVE reservation per bin, and at most one per queue entry.
create unique index reservations_one_active_per_bin_uidx
  on public.reservations (bin_id)
  where status = 'ACTIVE';

create unique index reservations_one_active_per_entry_uidx
  on public.reservations (queue_entry_id)
  where status = 'ACTIVE';

create index reservations_session_status_idx
  on public.reservations (session_id, status);

-- ---------------------------------------------------------------------------
-- rentals
-- ---------------------------------------------------------------------------
-- There is deliberately no bin-condition column and no mutable LATE status.
-- "Currently late" is derived at read time (due_at < now()); `was_late` is
-- only the frozen outcome recorded when the rental is returned.
create table public.rentals (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  bin_id uuid not null references public.bins (id) on delete cascade,
  student_id uuid not null references public.students (id) on delete cascade,
  queue_entry_id uuid not null references public.queue_entries (id) on delete cascade,
  status public.rental_status not null default 'OUT',
  checked_out_at timestamptz not null default now(),
  due_at timestamptz not null,
  returned_at timestamptz,
  was_late boolean not null default false,
  panthercard_collected_at timestamptz,
  panthercard_returned_at timestamptz,
  checkout_staff_label text not null,
  return_staff_label text,
  -- Idempotency keys make checkout/return safe to retry (see docs/DATABASE.md).
  checkout_idempotency_key text not null,
  return_idempotency_key text,
  constraint rentals_returned_has_return_ts
    check (status <> 'RETURNED' or returned_at is not null),
  -- A normally completed return must record PantherCard return.
  constraint rentals_returned_has_card
    check (status <> 'RETURNED' or panthercard_returned_at is not null)
);

-- At most one OUT rental per bin.
create unique index rentals_one_out_per_bin_uidx
  on public.rentals (bin_id)
  where status = 'OUT';

create unique index rentals_checkout_idem_uidx
  on public.rentals (checkout_idempotency_key);

create unique index rentals_return_idem_uidx
  on public.rentals (return_idempotency_key)
  where return_idempotency_key is not null;

create index rentals_session_status_idx
  on public.rentals (session_id, status);

create index rentals_due_idx
  on public.rentals (session_id, due_at)
  where status = 'OUT';

-- ---------------------------------------------------------------------------
-- notification_outbox
-- ---------------------------------------------------------------------------
-- Ticket 1 only writes rows here. No SMS provider is contacted; delivery is
-- Ticket 5. `dedupe_key` makes notification creation idempotent.
create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  student_id uuid not null references public.students (id) on delete cascade,
  rental_id uuid references public.rentals (id) on delete set null,
  type public.notification_type not null,
  body text not null,
  status public.notification_status not null default 'PENDING',
  dedupe_key text not null unique,
  provider_message_id text,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  last_error text
);

create index notification_outbox_status_idx
  on public.notification_outbox (status, created_at);

-- ---------------------------------------------------------------------------
-- audit_events
-- ---------------------------------------------------------------------------
create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  actor_type text not null,
  actor_id text,
  action text not null,
  entity_type text not null,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_events_session_idx
  on public.audit_events (session_id, created_at);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- RLS is enabled on every application table with NO policies. With RLS on and
-- no policy, anon/authenticated roles are denied all access by default; only
-- the service-role key (used by trusted server operations) bypasses RLS.
-- Scoped policies for staff/admin surfaces are Ticket 6.
alter table public.sessions enable row level security;
alter table public.students enable row level security;
alter table public.bins enable row level security;
alter table public.queue_entries enable row level security;
alter table public.reservations enable row level security;
alter table public.rentals enable row level security;
alter table public.notification_outbox enable row level security;
alter table public.audit_events enable row level security;
