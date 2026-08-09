-- Panther Carts — Ticket 1: read views
--
-- Reporting views for the admin/staff surfaces (built in later tickets).
-- "Currently late" is always derived from database time (due_at < now()); it
-- never depends on a stored status. There is no LATE column anywhere.
--
-- Every view is security_invoker so Row Level Security on the base tables is
-- enforced against the querying role (only the service-role key, which
-- bypasses RLS, can read the underlying student data). SELECT is additionally
-- revoked from anon/authenticated as defense in depth. Scoped read policies
-- are Ticket 6.

-- Current OUT rentals (checked out, not yet returned).
create view public.v_current_out_rentals
with (security_invoker = true) as
select
  r.id as rental_id,
  r.session_id,
  r.bin_id,
  b.bin_number,
  r.student_id,
  s.full_name,
  s.panther_id,
  s.email,
  s.phone,
  r.checked_out_at,
  r.due_at,
  (now() > r.due_at) as is_currently_late,
  r.checkout_staff_label
from public.rentals r
join public.bins b on b.id = r.bin_id
join public.students s on s.id = r.student_id
where r.status = 'OUT';

-- Rentals that are late right now (OUT and past due). Uses database time.
create view public.v_current_late_rentals
with (security_invoker = true) as
select
  r.id as rental_id,
  r.session_id,
  r.bin_id,
  b.bin_number,
  r.student_id,
  s.full_name,
  s.panther_id,
  s.email,
  s.phone,
  r.checked_out_at,
  r.due_at,
  (now() - r.due_at) as overdue_by
from public.rentals r
join public.bins b on b.id = r.bin_id
join public.students s on s.id = r.student_id
where r.status = 'OUT' and r.due_at < now();

-- Everything that is currently late OR was returned late (includes history).
create view public.v_all_late_rentals
with (security_invoker = true) as
select
  r.id as rental_id,
  r.session_id,
  r.bin_id,
  b.bin_number,
  r.student_id,
  s.full_name,
  s.panther_id,
  r.status,
  r.checked_out_at,
  r.due_at,
  r.returned_at,
  r.was_late,
  (r.status = 'OUT' and r.due_at < now()) as is_currently_late
from public.rentals r
join public.bins b on b.id = r.bin_id
join public.students s on s.id = r.student_id
where (r.status = 'OUT' and r.due_at < now())
   or (r.status = 'RETURNED' and r.was_late);

-- Total inventory with current status, plus occupant info for OUT bins.
create view public.v_inventory
with (security_invoker = true) as
select
  b.id as bin_id,
  b.session_id,
  b.bin_number,
  b.status,
  b.updated_at,
  r.id as current_rental_id,
  r.due_at as current_due_at,
  case when r.id is not null then (now() > r.due_at) else false end as is_currently_late
from public.bins b
left join public.rentals r
  on r.bin_id = b.id and r.status = 'OUT';

-- All rentals in a session (full history).
create view public.v_session_rentals
with (security_invoker = true) as
select
  r.id as rental_id,
  r.session_id,
  r.bin_id,
  b.bin_number,
  r.student_id,
  s.full_name,
  s.panther_id,
  r.status,
  r.checked_out_at,
  r.due_at,
  r.returned_at,
  r.was_late,
  (r.status = 'OUT' and r.due_at < now()) as is_currently_late,
  r.checkout_staff_label,
  r.return_staff_label
from public.rentals r
join public.bins b on b.id = r.bin_id
join public.students s on s.id = r.student_id;

-- Current waitlist ordered by rank (stable tie-breaker).
create view public.v_current_waitlist
with (security_invoker = true) as
select
  qe.id as queue_entry_id,
  qe.session_id,
  qe.student_id,
  qe.queue_rank,
  qe.joined_at,
  qe.phone,
  s.full_name,
  s.panther_id,
  s.email
from public.queue_entries qe
join public.students s on s.id = qe.student_id
where qe.status = 'WAITING'
order by qe.queue_rank asc nulls last, qe.joined_at asc, qe.id asc;

-- Defense in depth: keep views off the anon/authenticated roles; only the
-- service role reads them (and RLS on base tables backs this up).
do $$
declare
  v_role text;
  v_view text;
begin
  foreach v_view in array array[
    'v_current_out_rentals',
    'v_current_late_rentals',
    'v_all_late_rentals',
    'v_inventory',
    'v_session_rentals',
    'v_current_waitlist'
  ] loop
    execute format('revoke all on public.%I from public', v_view);
    foreach v_role in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = v_role) then
        execute format('revoke all on public.%I from %I', v_view, v_role);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant select on public.%I to service_role', v_view);
    end if;
  end loop;
end;
$$;
