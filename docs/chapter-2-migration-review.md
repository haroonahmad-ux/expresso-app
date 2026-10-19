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

## 4. Pre-flight checks and deployment sequence

Everything below is done in the **Supabase Dashboard → SQL Editor**. No command line is
needed, so it works from a phone. Each SQL block is a single statement; select it, press
Run, and read the one-row-per-check table.

Both migrations are additive, idempotent and data-preserving (no `DROP TABLE`, `TRUNCATE` or
`DELETE`). Each is wrapped in `begin`/`commit`, so if anything fails, **nothing is committed**.

### 4.0 Save a way back (do this first)

1. Dashboard → **Database → Backups**. Confirm a recent backup exists, or that
   point-in-time recovery is on. If neither, take a backup now and wait for it to finish.
2. Open a notes app and paste the "before" values you are about to read in 4.2. If you need
   to reconstruct the old state by hand, you will want them.

### 4.1 Pre-flight checks — all must PASS before you continue

Paste this as **one** statement and press Run. It prints one row per check. The same SQL
is saved at `supabase/checks/preflight.sql`, so you can open that file and copy it in one go.

```sql
with admin as (
  select 'bdd8f73c-fd23-4d76-9d23-7f4942300c36'::uuid as id
)
select '1. admin account exists in auth.users' as step,
       case when exists (select 1 from auth.users u join admin a on u.id = a.id)
            then 'PASS' else 'FAIL - check the UUID' end as result
union all
select '2. admin profile role',
       coalesce((select case when p.role = 'RETAILER_ADMIN' then 'PASS'
                             else 'FAIL - role is ' || p.role end
                 from public.profiles p join admin a on p.id = a.id),
                'FAIL - no profiles row yet (will be created)')
union all
select '3. admin is_active',
       coalesce((select case when p.is_active then 'PASS'
                             else 'FAIL - false locks the admin out' end
                 from public.profiles p join admin a on p.id = a.id),
                'FAIL - no profiles row yet (will be created)')
union all
select '4. profiles.id is unique',
       case when exists (
              select 1 from pg_index i
              join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
              where i.indrelid = 'public.profiles'::regclass
                and i.indisunique and i.indnatts = 1 and a.attname = 'id')
            then 'PASS' else 'FAIL - run: ALTER TABLE public.profiles ADD PRIMARY KEY (id);' end
union all
select '5. catalogue authored only by the admin',
       case when exists (select 1 from public.packages p join admin a on true
                         where p.created_by is not null and p.created_by <> a.id)
            then 'FAIL - another account authored a bundle' else 'PASS' end
union all
select '6. role values inside the domain',
       case when exists (select 1 from public.profiles
                         where role is null or role not in ('CUSTOMER','RETAILER_ADMIN'))
            then 'NOTE - odd values are normalised to CUSTOMER' else 'PASS' end
order by step;
```

How to read it:

| Step | PASS means | If it fails |
|---|---|---|
| 1 | the admin UUID exists in `auth.users` | the UUID is wrong for this project. Stop; do not run the migration. |
| 2 | the admin's role is `RETAILER_ADMIN` | usually just "no row yet" — the migration creates it. Any other role is a surprise worth investigating first. |
| 3 | `is_active` is `true` | **`false` locks the admin out.** The migration sets the role but never flips `is_active`. Decide first: see 4.3. |
| 4 | `profiles.id` has a primary key or unique constraint | run the `ALTER TABLE ... ADD PRIMARY KEY (id);` shown in the result, then re-run 4.1. |
| 5 | every bundle was authored by the admin, or `created_by` is `null` | the migration will refuse to run. Do not force it; find out who authored the bundle. |
| 6 | all roles are already in the domain | `NOTE` is fine — the migration normalises odd values to `CUSTOMER`. |

**Do not run the migration unless steps 1, 3, 4 and 5 all say PASS.**

### 4.2 Record the "before" state (read-only, optional but wise)

```sql
select id, role, is_active, full_name, msisdn from public.profiles order by role;
```

```sql
select count(*) as package_count from public.packages;
```

Write both results down. `package_count` should be the same after the migration.

### 4.3 The `is_active` decision (only if step 3 failed)

The migration deliberately does **not** re-activate a disabled account: turning an account
back on is an access decision, not a schema change. If step 3 reported
`FAIL - false locks the admin out`, choose one:

- **Intended to be active** — run this one statement, then re-run 4.1:
  ```sql
  update public.profiles set is_active = true
   where id = 'bdd8f73c-fd23-4d76-9d23-7f4942300c36';
  ```
- **Intended to stay disabled** — continue anyway. The migration still succeeds and sets the
  role, but the account stays locked out, and step 3 of 4.5 will keep failing until you
  change it. This is a real state, not an error in the migration.

### 4.4 Apply the migration

1. Confirm `20261018120000_packages_anon_select_fix.sql` is already applied. (It is, per the
   live check that all nine authorization probes pass.)
2. In the SQL Editor, open the file
   `supabase/migrations/20261017120000_auth_profiles_rls.sql` from the branch, copy the
   **whole** file, paste it, and press Run.
3. The script runs inside one transaction. If it aborts, **nothing was changed**. The error
   message names the exact remedy — the three possible ones are the checks in 4.1.
4. Optional: re-run `20261018120000_packages_anon_select_fix.sql`. The base migration removes
   the explicit `packages_anon_no_select` policy (it drops every policy on the table before
   installing its own), so this restores that visible deny policy. Anonymous access is denied
   by the `REVOKE` either way, so this is cosmetic. Re-running it is safe.

### 4.5 Verify after applying

```sql
select id, role, is_active from public.profiles
 where id = 'bdd8f73c-fd23-4d76-9d23-7f4942300c36';
```
Expect `RETAILER_ADMIN` and `is_active = true`. If `is_active` is still `false`, revisit 4.3.

```sql
select count(*) as package_count from public.packages;
```
Must equal the 4.2 value.

```sql
select policyname from pg_policies
 where schemaname = 'public' and tablename in ('profiles','packages') order by policyname;
```
Expect exactly `packages_admin_write`, `packages_select_authenticated`, `profiles_select_own`,
`profiles_update_own` (plus `packages_anon_no_select` if you re-ran the anon-fix).

```sql
select column_name from information_schema.column_privileges
 where table_schema = 'public' and table_name = 'profiles'
   and grantee = 'authenticated' and privilege_type = 'UPDATE'
 order by column_name;
```
Expect exactly `full_name`, `msisdn`, `phone`.

The verification statements above are also saved together at `supabase/checks/postflight.sql`.

Finally, from a machine with the repo, re-run the live probe — it should still report 9/9:

```bash
npm run test:api-authz
```

### 4.6 Rollback — read this before you start

**There is no data rollback, and that is by design — but it is also a one-way door for the
access rules.**

- Nothing is deleted or dropped, so there is no data to restore. Your 4.2 values are for
  verification, not recovery.
- The migration is **not** reversible with a "down" script. To undo it you would have to
  hand-write the reverse: drop the four policies, drop the two triggers, drop the three
  helper functions, re-grant the old table privileges, and re-add `NOT NULL` on
  `full_name`/`msisdn`.
- **The `NOT NULL` change is the sharpest edge.** Re-adding `NOT NULL` will fail if any row
  now has a `null` `full_name` or `msisdn` — which is exactly what happens if the admin
  profile had to be created. Reverting is therefore not guaranteed to be possible once the
  migration has run.
- Undoing the access rules also **re-opens the anonymous-read finding** on `public.packages`.
  That is the vulnerability the earlier fix closed.

Because of that, treat this as **fix-forward**: if something is wrong afterwards, correct it
with a new migration rather than reverting. Rehearse the whole sequence on a staging project
first if you can, since the SQL Editor offers no dry run.

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
