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

### Authorized retailer-admin verification

The migration does not blindly promote a hardcoded id. Before promoting, it
requires that:

1. the configured account exists in `auth.users`, and
2. the existing `public.packages` rows were authored by that account (no other
   `created_by` value), or the catalogue is empty.

If either check fails the migration raises and rolls back rather than guessing
an identity. The expected id can be supplied explicitly:

```sql
select set_config('expresso.retailer_admin_id', '<verified-uuid>', true);
```

The default id was corroborated against the live project: a read-only request to
`/rest/v1/packages` returned all five catalogue rows with
`created_by = bdd8f73c-fd23-4d76-9d23-7f4942300c36`, so that account is the
catalogue author. The `profiles` row for it cannot be confirmed through the
anon key (RLS hides it), which is why the migration inserts *or* updates.

### Legacy projects

The migration is defensive about an already-provisioned project. It removes any
pre-existing policy on `public.profiles` / `public.packages` (including
permissive `using (true)` policies left by an earlier dashboard setup), revokes
all table-level privileges from `anon`, `authenticated` and `PUBLIC`, and then
re-grants only `select` plus column-level `update (full_name, msisdn)`.
Post-condition assertions inside the migration abort it if a client can still
update `role`, `is_active` or `email`.

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
  (PGlite) starting from a deliberately insecure legacy state (permissive
  policies and broad grants) and asserts the cleanup, the least-privilege
  grants, the RLS policies, the signup trigger, the SECURITY DEFINER hardening
  and the fail-safe admin verification. 54 assertions.
- `tests/security-static.test.mjs` — asserts the demo OTP, hardcoded admin PIN
  and client-side role selection are gone, and that the migration keeps the
  hardening it is supposed to (revoke-then-grant, policy cleanup, empty
  `search_path`, fail-safe admin verification, no destructive DDL). 36 assertions.
- `tests/auth-ui.test.mjs` — drives the real client in headless Chromium,
  covering validation, field retention, the live Supabase error path, role
  gating and sign-out.

`tests/auth-ui.test.mjs` needs a Chromium binary (set `PUPPETEER_EXECUTABLE_PATH`
if it is not at `/usr/bin/chromium`).
