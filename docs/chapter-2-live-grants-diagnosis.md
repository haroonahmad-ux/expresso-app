# Why the live `public.profiles` grants differ from the migration's intent

**Question:** the committed migration intends `authenticated` to hold `UPDATE` on only
`full_name`, `msisdn`, `phone`. Live shows a table-level `UPDATE` and column-level `UPDATE` on
`created_at, full_name, id, msisdn, role`. Why?

**Answer:** the live database has **not run the migration**. Nothing in the migration is
wrong or ineffective. The five-column list is not a column-level grant at all — it is
`information_schema.column_privileges` *expanding* a single table-level grant.

No migration was applied while producing this. All results come from real PostgreSQL 15.19
and 17.11 containers, plus the PGlite harness.

---

## 1. The mechanism

`information_schema.column_privileges` does not report only explicit column grants. Per the
SQL standard it reports the privileges a role holds *on each column*, which includes
privileges inherited from a table-level grant. So a single

```sql
grant update on public.profiles to authenticated;
```

makes that view list **every** column of the table. The definitive evidence is the raw
catalogue, `pg_attribute.attacl`, which stores only *explicit* column ACLs:

| Observation after one table-level `GRANT UPDATE` | Result |
|---|---|
| `information_schema.table_privileges` UPDATE | 1 row |
| `information_schema.column_privileges` UPDATE | 5 rows (`created_at, full_name, id, msisdn, role`) |
| `pg_attribute.attacl` non-null rows | **0** |

Zero column ACLs, yet five columns reported. Live's list is exactly those five, in exactly
that order, which is the column order of the live table. That is the signature of a
table-level grant being expanded, not of a deliberate five-column grant.

The migration's own comment says the same thing about why it revokes first:

> `revoke all` first: column-level GRANTs are additive, so without this a pre-existing
> table-level UPDATE would keep role/is_active/email writable.

Live still has that pre-existing table-level `UPDATE`. Therefore the migration has not run.

## 2. The latent escalation

This is worth acting on. A table-level grant keeps covering columns that are added *later*.
Adding the four columns the full migration introduces:

| After `ADD COLUMN updated_at, email, is_active, phone` | Result |
|---|---|
| `column_privileges` UPDATE | 9 columns, now including `role` and `is_active` |

So if anyone adds those columns outside the migration — a manual dashboard change, a partial
run — the broad grant silently extends to `role` and `is_active`. That is the escalation the
migration's section 7 exists to prevent.

## 3. The smallest safe corrective

`supabase/migrations/20261019120000_profiles_least_privilege_grants.sql`. It touches
**privileges on `public.profiles` and nothing else** — no schema change, no policies, no data,
no `packages`, no admin account. It is safe to run repeatedly.

```sql
begin;
revoke all on public.profiles from public, anon, authenticated;
grant select on public.profiles to authenticated;
-- grant update (full_name, msisdn, phone) ... but only if `phone` exists yet
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='profiles' and column_name='phone') then
    grant update (full_name, msisdn, phone) on public.profiles to authenticated;
  else
    grant update (full_name, msisdn) on public.profiles to authenticated;
  end if;
end $$;
-- assertions: any surviving broad grant aborts the transaction
...
commit;
```

Two details that matter:

- **`REVOKE ALL ON TABLE` is sufficient.** It clears column-level ACLs as well — verified on
  both PostgreSQL 15 and 17. A separate `REVOKE ... ON TABLE ... FROM ...` per column is not
  needed.
- **`phone` is conditional.** Live has no `phone` column, so an unconditional
  `GRANT UPDATE (…, phone)` would fail with `42703 column "phone" does not exist` and abort.
  The corrective grants `phone` only when the column is present, so it works whether or not
  the full migration has run.

### Verified outcomes

| Starting state | After the corrective |
|---|---|
| live shape (no `phone`) | `full_name, msisdn`; table-level `UPDATE` gone; `attacl` = 2 rows |
| after the full migration (`phone` present) | unchanged — `full_name, msisdn, phone` (no-op) |
| run twice | same state (idempotent) |

Untouched in every case: the `RETAILER_ADMIN` row, the two existing policies, all `packages`
grants, and all package rows.

### Relationship to the full migration

The full migration's section 7 already performs this revoke/grant and converges to the same
state (verified end to end on PostgreSQL 15.19 and 17.11). The corrective is for fixing the
grants on their own, without the schema and policy work. If you intend to run the full
migration anyway, you do not need the corrective — but running it first is harmless and
narrows the window in which the broad grant is live.

## 4. Pre-flight and post-flight

Run in the Supabase SQL Editor. Read-only pre-flight.

### Pre-flight

```sql
select grantee, privilege_type from information_schema.table_privileges
 where table_schema='public' and table_name='profiles' order by grantee, privilege_type;
```
Expect a row `authenticated | UPDATE` while unfixed. That row is the cause.

```sql
select column_name from pg_attribute
 where attrelid='public.profiles'::regclass and attacl is not null order by attname;
```
Expect **no rows**. This is the decisive check: if `attacl` is empty, the reported column
privileges are an expansion of the table-level grant, exactly as diagnosed.

```sql
select column_name from information_schema.columns
 where table_schema='public' and table_name='profiles' and column_name='phone';
```
Tells you which branch the corrective will take. Either outcome is fine.

### Post-flight

```sql
select grantee, privilege_type from information_schema.table_privileges
 where table_schema='public' and table_name='profiles' and privilege_type='UPDATE';
```
Expect only `postgres | UPDATE`. No `authenticated`, `anon` or `PUBLIC` row.

```sql
select column_name from information_schema.column_privileges
 where table_schema='public' and table_name='profiles'
   and grantee='authenticated' and privilege_type='UPDATE' order by column_name;
```
Expect exactly `full_name, msisdn` (or `full_name, msisdn, phone` if the full migration ran).

```sql
select attname from pg_attribute
 where attrelid='public.profiles'::regclass and attacl is not null order by attname;
```
Expect exactly the same two (or three) columns. Now that explicit ACLs exist, this view and
the previous one agree — which is the sign the expansion is gone.

```sql
select id, role, is_active from public.profiles
 where id = 'bdd8f73c-fd23-4d76-9d23-7f4942300c36';
```
Expect `RETAILER_ADMIN`. Unchanged by the corrective.

### Reproduce locally

```bash
npm run test:grants   # 20 checks: the expansion, the escalation, the corrective
npm test              # 255 passed, 0 failed
```

## 5. Honest limitations

- No database credential was available, so the live database was not queried. The live shape
  used here is the one reported; the `attacl`-empty pre-flight above is the check that
  confirms the diagnosis against your actual project.
- `is_active`, `email`, `phone` and `updated_at` are absent live. The corrective does not add
  them; that is the full migration's job. It only fixes the grants.
- The corrective is **not applied**. Nothing here claims otherwise.
