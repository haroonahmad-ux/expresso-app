# expresso-app

Expresso Pakistan Telecom & Lifestyle — a static HTML PWA with real Supabase
authentication.

## Authentication

Signup, login, logout and session persistence are handled by Supabase Auth
(email + password). The browser ships only the publishable (anon) key, which is
safe to expose because every authorisation decision is enforced by Postgres
Row Level Security.

Roles are owned by the database and can never be chosen or changed by the
client:

- New accounts always receive `CUSTOMER` via an `auth.users` trigger. Any
  `role` value supplied at signup is ignored.
- `RETAILER_ADMIN` is granted only through privileged SQL.
- `profiles.role`, `profiles.is_active` and `profiles.email` are excluded from
  the client's column-level `UPDATE` grant, so self-promotion is rejected by
  the database even if the client is tampered with.

## Applying the migration

The migration is idempotent and non-destructive — it only creates missing
objects, adds missing columns, and normalises legacy role values. Run it with
the Supabase SQL editor, or:

```sh
psql "$SUPABASE_DB_URL" -f supabase/migrations/20261017120000_auth_profiles_rls.sql
```

It also promotes the authorized retailer-admin account and preserves the
existing bundle catalogue.

### Required dashboard setting

New signups must confirm their email address, so email delivery has to be
configured (or "Confirm email" disabled) in **Authentication → Providers →
Email** before signup is usable end to end.

## Tests

```sh
npm install
npm test
```

- `tests/auth-rls.test.mjs` — applies the migration to an in-process Postgres
  (PGlite) with an `auth` shim and asserts the RLS policies and the signup
  trigger.
- `tests/security-static.test.mjs` — asserts the demo OTP, hardcoded admin PIN
  and client-side role selection are gone.
- `tests/auth-ui.test.mjs` — drives the real client in headless Chromium,
  covering validation, field retention, the live Supabase error path, role
  gating and sign-out.

`tests/auth-ui.test.mjs` needs a Chromium binary (set `PUPPETEER_EXECUTABLE_PATH`
if it is not at `/usr/bin/chromium`).
