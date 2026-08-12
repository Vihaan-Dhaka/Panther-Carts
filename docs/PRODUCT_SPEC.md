# Panther Carts — Product Specification

This document is the authoritative product requirements reference. Read it in
full before making any product change.

## Stack

- Standard Next.js App Router
- TypeScript
- Tailwind CSS
- Supabase PostgreSQL
- Supabase Realtime only where useful
- Zod
- Vitest
- Playwright
- Vercel-compatible deployment
- A provider-independent SMS module with Telnyx (recommended) and Twilio

## Overview

Panther Carts manages rental of numbered cart bins to students during staffed
sessions. The finished product has three interfaces: student, staff, and
admin.

## Student interface

- Students open a session-specific signup link.
- They enter full name, Panther ID, student email, and phone number.
- After signup, all student interaction occurs through SMS.
- Student signup requires explicit consent to Panther Carts transactional
  rental messages. Frequency varies; message/data rates may apply. The
  disclosure explains carrier-managed STOP and HELP behavior. No marketing
  consent or marketing messages are collected.
- The first SMS is one combined signup message. It includes queue position and
  estimated wait (or a clear unavailable estimate), or the immediate pickup
  offer when a cart is ready. It also includes TIME, CANCEL, conditional HOLD,
  required disclosures, and STOP instructions.
- Panther Carts application commands are exactly `TIME`, `HOLD`, and `CANCEL`.
  `HELP`, `STOP`, and `START`/`UNSTOP` are provider-managed compliance keywords,
  never queue commands. A forwarded compliance webhook is acknowledged without
  a queue mutation or a duplicate application response. If a provider labels
  an application command as compliance, the event records a distinct
  misconfiguration outcome without executing that command.
- `CANCEL` leaves the Panther Carts queue/reservation. It is not carrier opt-out.
- All normal Panther Carts messages fit in one GSM-7 SMS segment.
- Students do not create accounts.
- Students do not receive personal QR codes.

### HOLD behavior

- A student with an active reservation can use HOLD once.
- HOLD transfers the current reservation to the first waiting student.
- The student who used HOLD moves to actual position two in the remaining
  waitlist.
- Example: A has a reservation and B, C, D are waiting. A uses HOLD. B
  receives the reservation. The new waitlist becomes C, A, D.
- If only B is waiting, B receives the reservation and A becomes position
  one.
- If nobody is waiting, HOLD is rejected.
- A second HOLD is rejected.

### Estimated wait

- Each checked-out bin has an expected return time calculated from checkout
  time plus the session's rental duration.
- Expected return times are sorted from earliest to latest.
- Queue position one maps to the earliest return, position two to the second
  return, and so on.
- When the queue exceeds the number of bins, add an additional
  rental-duration cycle.
- Estimates are informational and never determine queue order.

### SMS providers and delivery

- Telnyx is the recommended/default production provider. Twilio is a fully
  functional configurable alternative. `SMS_PROVIDER` selects one; there is no
  automatic cross-provider failover.
- Use a local 10DLC sender. Do not use a toll-free sender whose carrier keyword
  rules prevent `CANCEL` from reaching Panther Carts.
- Provider Advanced Opt-Out must remove `CANCEL` from opt-out aliases while
  retaining STOP, START/UNSTOP, and HELP provider handling.
- Provider webhooks are signature-verified before parsing. Inbound event/message
  identifiers are provider-scoped and idempotent.
- Outbound messages use a database-backed claim/lease outbox with bounded
  attempts and retry backoff. Simultaneous healthy workers cannot claim the
  same row. Provider requests time out before the lease expires, and a rejected
  completion is reported as unconfirmed rather than sent. A crash after
  provider acceptance but before the SENT commit can still cause a duplicate
  on lease recovery; the system does not claim perfect exactly-once delivery
  across that network boundary.

## Staff interface

- Staff access a session through a generated link or access code.
- Checkout begins by entering the student's four-digit pickup code.
- Staff see the student's full name and Panther ID.
- Staff collect the physical PantherCard.
- Staff select the existing numbered bin being issued.
- Staff confirm PantherCard collection and checkout.
- The PantherCard is placed in a physical numbered slot matching the bin
  number.
- Return begins by entering the bin number.
- Staff see the student's name and Panther ID again.
- Staff retrieve the PantherCard from the matching slot.
- Staff confirm PantherCard return and complete check-in.
- Do not add bin-condition reporting.
- Do not require QR codes on bins.

## Admin interface

- Start and end sessions.
- Configure rental duration and pickup-window duration.
- Generate student signup links.
- Generate staff links and access codes.
- Add bins individually, by number range, or by pasted list.
- Display information in tables.
- Select the table using a dropdown.
- Required views are:
  - Overview
  - Current late rentals
  - All late rentals in the session, including returned rentals
  - Currently checked out
  - Total inventory
  - All rentals in the session
  - Current waitlist
- Tables show all relevant student details.
- Use red for currently late rentals.
- Use green for checked-out rentals that are on time.
- Use orange for rentals that were returned late.
- Use grey for rentals returned on time.
- Use white for available bins.
- Every active rental has a Notify button.
- Notify sends either the remaining rental time or the amount of time
  overdue.

## Explicit non-goals

- No student accounts.
- No personal QR codes for students.
- No QR codes on bins.
- No bin-condition reporting.
