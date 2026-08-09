# Queue engine

Authoritative queue logic lives here as pure, server-side functions:
position assignment, HOLD transfers, cancellation, and estimated-wait
calculation. Implemented in Ticket 1. Never mutate queue state from React
components — see `docs/ARCHITECTURE.md`.
