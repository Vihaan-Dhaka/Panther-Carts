# Auth

Ticket 6 authentication is enforced at server-operation boundaries:

- Admins sign in with Supabase Auth email/password accounts whose immutable
  `app_metadata.role` is `admin`. Pages and every Server Action revalidate the
  user through Supabase; the service-role client is created only afterward.
- Staff link tokens and eight-digit access codes are exchanged once at the
  server for a random, 12-hour, HttpOnly `SameSite=Strict` browser session.
  The database stores keyed verifiers for credentials and browser tokens, not
  their plaintext. Ending a rental session revokes its staff browser sessions.
- Staff links/codes are protected with HMAC verifiers. Authenticated ciphertext
  is retained only because the admin product surface must redisplay generated
  links/codes. Legacy plaintext staff links are scrubbed during migration and
  remain verifiable but cannot be redisplayed.
- Student session codes remain opaque public signup locators; they never grant
  PII access and are validated/rate-limited before signup.
- PostgreSQL-backed fixed-window rate limits provide atomic enforcement across
  serverless instances. Stored identities are keyed hashes, never raw IPs,
  emails, codes, or cookies.

`PANTHER_AUTH_SECRET` must be a random server-only value of at least 32
characters and identical on every application instance. Rotating it invalidates
staff credentials/sessions and makes existing protected credentials
undecryptable, so rotation requires issuing new staff access.

`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` must be one stable base64-encoded 32-byte
key shared by all application instances. Provision each administrator through
a trusted Supabase dashboard or Admin API and set `app_metadata.role` to
`admin`; `user_metadata` does not grant access. On non-Vercel deployments, the
front proxy must replace client-supplied forwarding headers with the verified
client IP before requests reach this application.
