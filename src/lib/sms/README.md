# SMS module

Provider-independent SMS contracts, inbound dispatch, delivery telemetry, and
outbox delivery live here. Authoritative message bodies remain in PostgreSQL so
they are created atomically with queue mutations. `telnyx.ts` and `twilio.ts`
contain all provider-specific HTTP/signature behavior; application code depends
only on `SmsProvider`.

Panther Carts commands are exactly TIME, HOLD, and CANCEL. HELP, STOP, and
START/UNSTOP are carrier-managed compliance keywords and bypass queue dispatch.
All files that touch provider configuration or database access are server-only.
