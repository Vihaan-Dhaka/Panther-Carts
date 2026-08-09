# Panther Carts — Ticket Sequence

Work proceeds strictly in this order. Read `docs/PRODUCT_SPEC.md` before
starting any ticket.

## Ticket 1: Database schema and queue engine

Design the Supabase PostgreSQL schema (`supabase/migrations/`) for sessions,
bins, students, rentals, and the waitlist. Implement the pure queue engine in
`src/lib/queue/`: position assignment, HOLD transfer semantics, cancellation,
and the estimated-wait calculation. Full unit-test coverage of the queue
rules, including every HOLD case in the spec.

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

## Ticket 5: Two-way SMS

Telnyx and Twilio adapters behind the `SmsProvider` interface. Outbound
notifications (signup confirmation with position and estimated wait,
reservation offers, Notify). Inbound webhook handling for TIME, HOLD,
CANCEL, and HELP.

## Ticket 6: Authentication and data protection

Admin authentication, staff link/access-code verification, session-code
validation, RLS policies, and rate limiting. Ensure student personal data is
only visible to authorized staff/admin surfaces.

## Ticket 7: Integration, concurrency, and end-to-end testing

Integration tests for concurrent signup/HOLD/checkout/return races,
Playwright end-to-end coverage of all three interfaces, and a full
session-lifecycle test from setup through late returns.
