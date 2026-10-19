# Chapter 2 — Migration review against the live schema, and deployment sequence

**Reviewed artefact:** `supabase/migrations/20261017120000_auth_profiles_rls.sql`
at `chapter-2/implementation` (`3466c7c`), plus
`supabase/migrations/20261018120000_packages_anon_select_fix.sql`.
**Status:** review complete. A corrected migration is proposed on
`chapter-2/migration-hardening`. **Not applied. No production change.**
**Method:** every claim below was reproduced by executing the migration against a real
Postgres engine (PGlite, WASM) in a schema shaped exactly like the reported live project.
No database credential was available, so nothing here is a claim about the live database
itself — only about the migration's behaviour against that shape.

---

## 1. Verdict

The migration **is compatible** with the reported live schema and the existing
retailer-admin account. It applies cleanly, twice, over a live-shaped project and preserves
the admin identity, the admin's contact fields and all five bundles. The `packages`
anonymous-access fix is already applied and does not conflict.

Six issues were found. None is fatal; three are real risks worth fixing before deployment,
and the corrected migration fixes all six. Details and evidence follow.

---

## 2. Issues found

### C-1 — `profiles.id` is assumed unique (risk: opaque failure)

Every `on conflict (id)` in the migration — the signup trigger, the backfill, the admin
promotion — requires a unique constraint on `profiles.id`. A Supabase-dashboard project that
created `profiles` without a primary key would fail with:

```
there is no unique or exclusion constraint matching the ON CONFLICT specification
```

The failure is correct but unhelpful, and it happens *after* the role `UPDATE` and the
`NOT NULL` change have already run inside the transaction.

**Fix:** assert a unique/primary-key index on `id` early, with an actionable message naming
the remedy (`ALTER TABLE public.profiles ADD PRIMARY KEY (id);`).

### C-2 — `is_active = false` admin is promoted but silently locked out (real risk)

`is_retailer_admin()` requires `coalesce(p.is_active, true)`. The promotion sets `role` but
never `is_active`. If the authorized admin's row is currently deactivated, the migration
promotes the role and then leaves the account with **no administrative power**, while all
access control behaves as if the migration succeeded. Reproduced:

```
admin row: {"role":"RETAILER_ADMIN","is_active":false}
is_retailer_admin() = false  *** ADMIN LOCKED OUT ***
```

**Fix:** the corrected migration leaves `is_active` untouched (it is an operational flag, and
silently re-activating an account is its own security decision) but the deployment sequence
in section 4 makes the admin's `role` and `is_active` a **pre-flight and post-flight check**,
so this cannot pass unnoticed. This remains an owner decision: re-activate, or accept that
the admin stays disabled.

### C-3 — a wider legacy role `CHECK` under the same name is not replaced (real risk)

The original guarded with `if not exists (...) then add constraint profiles_role_check`.
If the live project already has a `profiles_role_check` with a wider domain (for example
`('CUSTOMER','RETAILER_ADMIN','SUPER_ADMIN')`), the constraint is left in place and the wider
domain survives — so a value such as `SUPER_ADMIN` could be inserted by a privileged actor
and would then fail the `CUSTOMER`/`RETAILER_ADMIN` assumptions elsewhere.

**Fix:** drop `profiles_role_check` if present and re-add the canonical two-value domain.
The preceding `UPDATE` has already normalised every role value, so the re-add cannot fail.
(A differently *named* legacy `CHECK` can only narrow the domain, because `CHECK` constraints
are AND-ed, so it is safe to leave.)

### C-4 — the role guard did not cover `INSERT` (defence in depth)

The guard trigger fired only `before update`. A client role cannot `INSERT` into `profiles`
today (the column grants forbid it), so this was not exploitable — but the guard's stated
purpose is to hold even if grants are later loosened. A reintroduced table-level `INSERT`
grant would have let a client create a profile row with any role.

**Fix:** the guard now also fires `before insert` and forces `role = 'CUSTOMER'`,
`is_active = true` for client roles. Privileged roles are unaffected.

### C-5 — a pre-existing admin row kept a stale placeholder name (cosmetic)

The promotion wrote `full_name = 'Authorized Retailer Admin'` on conflict. For the existing
admin this overwrote the real name with a placeholder, and because `full_name` is
client-writable it could be reverted by the admin anyway — inconsistent state for no benefit.

**Fix:** only `role` is ever set on conflict. Existing contact fields are preserved; a missing
profile is created with null contact fields.

### C-6 — backfill gaps were silent (cosmetic)

Any `auth.users` row without a `profiles` row was left unmentioned. It is still provisioned by
the signup trigger, but the gap is worth surfacing.

**Fix:** raise a warning naming the count.

---

## 3. What was verified as correct (no change)

| Area | Result |
|---|---|
| Applies over live-shaped schema | OK, and idempotent (ran twice) |
| `full_name`/`msisdn` `NOT NULL` on live | Handled — the `DROP NOT NULL` is what makes creating a missing admin profile possible; without it the migration fails with `null value in column "full_name" ... violates not-null constraint` |
| Admin identity | Preserved; promoted to `RETAILER_ADMIN`; `is_active` and contact fields kept |
| Existing profiles and 5 bundles | Row-for-row preserved |
| Admin promotion verification | Fails safely when the account is absent from `auth.users`, and when the catalogue was authored by another account |
| RLS policies | The four intended policies exist; every legacy policy is dropped first |
| Grants | `revoke all` precedes grants; no table-level `UPDATE` survives; client update limited to `full_name, msisdn, phone` |
| `SECURITY DEFINER` helpers | Owned by the migration role, `search_path` pinned, `EXECUTE` revoked from `PUBLIC` |
| Anonymous access | `packages` and `profiles` unreadable and unwritable by `anon` after the base migration, in either order with the anon-fix |

---

## 4. Deployment sequence

Both migrations are additive, idempotent and data-preserving (no `DROP TABLE`, `TRUNCATE` or
`DELETE`). They are wrapped in `begin`/`commit`, so a failure rolls the whole script back.

### 4.1 Before you start (owner, read-only)

1. Take a backup / confirm point-in-time recovery on the project.
2. Record the pre-state:
   ```sql
   select id, role, is_active, full_name, msisdn from public.profiles;
   select count(*) from public.packages;
   select policyname from pg_policies where schemaname = 'public';
   select grantee, privilege_type from information_schema.table_privileges
     where table_schema = 'public' and table_name in ('profiles','packages');
   select conname, pg_get_constraintdef(oid) from pg_constraint
     where conrelid = 'public.profiles'::regclass;
   ```
3. **Pre-flight checks** (the migration will also check these, but confirm now):
   - `public.profiles.id` has a primary key or unique constraint.
   - `auth.users` contains `bdd8f73c-fd23-4d76-9d23-7f4942300c36`.
   - That account's `profiles.role` **and** `profiles.is_active` are what you intend. If
     `is_active` is `false`, decide whether to re-activate it; the migration will not.
   - No bundle in `public.packages` has a `created_by` other than that account (a `null`
     `created_by` is fine).

### 4.2 Apply

Order does not matter — both orderings were tested. The sequence below matches what has
already happened live.

1. `20261018120000_packages_anon_select_fix.sql` — **already applied.**
2. `20261017120000_auth_profiles_rls.sql` — apply this next, via the Supabase SQL editor or
   `psql "$SUPABASE_DB_URL" -f supabase/migrations/20261017120000_auth_profiles_rls.sql`.
3. Re-run `20261018120000_packages_anon_select_fix.sql` if you want the explicit
   `packages_anon_no_select` policy restored (the base migration removes it, because it drops
   every policy on the table before installing its own). It is optional: anonymous access is
   denied by the `REVOKE` either way. Re-running it is safe.

If the migration aborts, nothing is committed. Read the exception message; each one names the
exact remedy.

### 4.3 After applying (owner, read-only)

```sql
select id, role, is_active from public.profiles
  where id = 'bdd8f73c-fd23-4d76-9d23-7f4942300c36';   -- expect RETAILER_ADMIN, is_active true
select count(*) from public.packages;                    -- unchanged
select policyname from pg_policies
  where schemaname = 'public' and tablename in ('profiles','packages');
select grantee, privilege_type, column_name
  from information_schema.column_privileges
  where table_schema = 'public' and table_name = 'profiles'
    and grantee = 'authenticated' and privilege_type = 'UPDATE';  -- full_name, msisdn, phone only
```

Then re-run the live probe, which should still report 9/9:

```bash
npm run test:api-authz
```

### 4.4 Rollback

There is nothing to roll back in the data sense — no row is deleted and no column is dropped.
To revert the access rules only, re-grant as needed and drop the four policies; but note that
doing so re-opens the anonymous-read finding. Prefer fixing forward.

---

## 5. Reproducing this review

```bash
git checkout chapter-2/migration-hardening
npm install
npm run test:live-schema   # 26 checks: live-shaped schema compatibility
npm test                   # 235 passed, 0 failed
```

`tests/migration-live-schema.test.mjs` builds the live-shaped project (primary key,
`NOT NULL` contact fields, an existing `RETAILER_ADMIN`, the five bundles, a permissive
anonymous policy) and asserts every finding above, including the three failure modes the
corrected migration now catches with a clear message.

---

## 6. Honest limitations

- No database credential was available, so the live database was **not** inspected. The
  schema used here is the one reported in the task; if the live schema differs, these results
  do not carry over.
- The corrected migration is **not applied**. Nothing here claims otherwise.
- C-2 remains an owner decision: the migration deliberately does not re-activate a disabled
  admin account.
