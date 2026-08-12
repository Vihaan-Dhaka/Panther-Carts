# Panther Carts — Ticket Sequence

Work proceeds strictly in this order. Read `docs/PRODUCT_SPEC.md` before
starting any ticket.

## Ticket 1: Database schema and queue engine — **complete**

Supabase PostgreSQL schema (`supabase/migrations/`) for sessions, students,
bins, queue entries, reservations, rentals, the notification outbox, and audit
events. The authoritative queue engine is implemented as PostgreSQL functions
invoked via RPC (`join_queue`, `allocate_bins`, `hold_reservation`, `checkout`,
`return_rental`, `expire_reservations`, plus the `estimated_wait_minutes`
calculation), each atomic and idempotent and serialized per session by a
transaction-scoped advisory lock. Reporting views back the admin/staff tables.
A deterministic estimated-wait mirror and phone/validation helpers live in
`src/lib/queue/` and `src/lib/validation/` with unit tests; database
integration and concurrency tests (including every HOLD case) run against a
local Supabase instance. Full design: `docs/DATABASE.md`.

Deferred to later tickets by design: RLS policies and PII protection
(Ticket 6), SMS delivery of outbox rows (Ticket 5), and the UI surfaces
(Tickets 2–4).

## Ticket 2: Student signup

Session-specific signup page at `/student/[sessionCode]` collecting full
name, Panther ID, student email, and phone number. Zod validation, queue
placement via the Ticket 1 engine, and generation of the four-digit pickup
code. No accounts, no QR codes.

## Ticket 3: Staff checkout and return

Staff station at `/staff/[staffCode]`. Checkout: pickup code → student name
and Panther ID → bin selection → confirm PantherCard collection. Return: bin
number → student details → confirm PantherCard return and check-in. No
bin-condition reporting.

## Ticket 4: Admin dashboard

Session start/end, rental and pickup-window duration configuration, signup
and staff link/code generation, bin management (individual, range, pasted
list), and the seven dropdown-selected table views with the specified
red/green/orange/grey/white status colors and per-rental Notify buttons.

## Ticket 5: Two-way SMS - **complete**

Telnyx (recommended) and Twilio adapters behind the `SmsProvider` interface,
selected explicitly without cross-provider failover. Signed inbound webhooks
dispatch the exact Panther Carts commands `TIME`, `HOLD`, and `CANCEL` into
authoritative PostgreSQL operations. HELP, STOP, and START/UNSTOP remain
provider-managed compliance keywords and never enter the queue dispatcher.

Ticket 5 also adds required transactional-SMS signup consent evidence, atomic
idempotent cancellation, provider-scoped inbound replay protection, combined
single-segment signup/pickup messages, GSM-7 analysis, and a leased,
retry-bounded notification outbox worker. Manual provider setup must use a
local 10DLC sender and Advanced Opt-Out with CANCEL removed from opt-out aliases.

## Ticket 6: Authentication and data protection

Admin authentication, staff link/access-code verification, session-code
validation, RLS policies, and rate limiting. Ensure student personal data is
only visible to authorized staff/admin surfaces.

## Ticket 7: Integration, concurrency, and end-to-end testing

Integration tests for concurrent signup/HOLD/checkout/return races,
Playwright end-to-end coverage of all three interfaces, and a full
session-lifecycle test from setup through late returns.
