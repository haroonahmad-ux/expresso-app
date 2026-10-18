# Chapter 2 — Backend Security Design: Audit & Readiness Report

Repository: `haroonahmad-ux/expresso-app`
Audit branch: `chapter-2/audit-report` (branched from `main` @ `47bbc4b`)
Audit type: read-only inspection. No migration executed, no Supabase configuration changed,
no production record modified, no application code changed.

Evidence labels used throughout:

| Label | Meaning |
|---|---|
| `VERIFIED FROM SOURCE` | Read directly from a committed file in this repository. |
| `VERIFIED AGAINST LIVE DATABASE` | Observed through read-only PostgREST/GoTrue requests using the public publishable key. |
| `INFERRED FROM MIGRATION` | Deduced from migration SQL; not confirmed against the live database. |
| `NOT VERIFIED` | Could not be confirmed with the access available. |
| `REQUIRES OWNER DECISION` | Needs a choice or credential that only the owner can supply. |

---

## 1. Repository and file inventory

`VERIFIED FROM SOURCE`

Branches (`git ls-remote --heads origin`):

| Branch | SHA | Role |
|---|---|---|
| `main` | `47bbc4bd4b113c97491518bc1d5876ae838f1445` | Chapter 1 merged (frontend hardening) |
| `chapter-1/final-verification` | `66e1a12a203357385386893f6b6f47813cb1c62b` | Merged into main via PR #1 |
| `feat/supabase-auth-rls` | `2a433cf69c5e7e64ff1d7f6a9581b61f4d806f53` | **All Chapter 2 material lives here** |
| `backup-working-demo` | `5e7b860af452c924ab82eaeadc20e13fdc7f92b9` | Historical backup |

`feat/supabase-auth-rls` merge-base with `main` is `26a760d` — i.e. the auth work branched
**before** Chapter 1. It contains two commits: `877e02c` (feat) and `2a433cf` (hardening).

Chapter 2 inventory:

| Item | Path | Status |
|---|---|---|
| SQL migration | `supabase/migrations/20261017120000_auth_profiles_rls.sql` (16 482 bytes, 413 lines) | **Drafted, not applied live** |
| Migrations 001–005 | — | **Do not exist.** Exactly one migration file. |
| Edge Functions | — | **Missing.** No `supabase/functions/`, no `deno.json`, no `config.toml` anywhere in history. |
| Architecture docs | `README.md` (3 934 bytes, feat branch only) | Drafted; covers auth + migration, **no OTP design** |
| API specification | — | **Missing** |
| Auth frontend | `index.html` (855 lines, feat branch) | Implemented (email + password) |
| RLS test suite | `tests/auth-rls.test.mjs` (22 563 bytes) | Implemented |
| Static security test | `tests/security-static.test.mjs` (5 404 bytes) | Implemented |
| Auth UI test | `tests/auth-ui.test.mjs` (8 086 bytes) | Implemented |

`main` currently holds Chapter 1 artifacts (`sw.js`, `sanitizeState`, SRI pin, 7 test files).
The `feat` branch holds **none** of them.

---

## 2. Schema verification status

`VERIFIED AGAINST LIVE DATABASE` — read-only PostgREST probes with the publishable key
(`sb_publishable_…`). No credentials are reproduced in this report.

| Table | Exists live | Notes |
|---|---|---|
| `public.profiles` | Yes | Anon read returns `[]` |
| `public.packages` | Yes | Anon read returns **all 5 rows** |
| `bundles`, `bundle_history`, `history`, `subscriptions`, `transactions`, `otp_challenges` | **No** (HTTP 404) | None exist |

Live column probes (HTTP 200 = column exists, 400 `42703` = does not):

- `profiles`: `id`, `role`, `full_name`, `msisdn`, `created_at` → **exist**;
  `updated_at`, `email`, `is_active` → **do not exist**.
- `packages`: all of `id, title, category, validity_days, price_pkr, data_mb, minutes,
  sms_count, is_enabled, created_by, created_at` → **exist**.

**Conclusion: the migration has NOT been applied to the live project.** The migration
(`L47–L53`) adds `updated_at`, `email`, `is_active` to `profiles`; the live table lacks all
three. `VERIFIED AGAINST LIVE DATABASE`.

Live RLS state (safe, non-mutating probes):

- `INSERT` into `packages` with `{}` → **HTTP 401 `42501` "new row violates row-level security policy"**
  → RLS **is enabled** on `packages`. `VERIFIED AGAINST LIVE DATABASE`
- `UPDATE`/`DELETE` targeting a non-existent UUID → 204 (matched zero rows).
- Anon package count unchanged (`0-4/5`) after every probe. **No data was altered.**
- `public.profiles` anon read → `[]`, `content-range: */0` → no anonymous row exposure.

The live schema matches the migration's *assumed* pre-existing shape (`profiles` with exactly
the five legacy columns) → `INFERRED FROM MIGRATION`, consistent with observation.

`NOT VERIFIED`: grants, policy definitions, `pg_policies` contents, function ownership, and
`auth.users` contents. PostgREST exposes no catalogue views, and no database credential is
available in this environment.

---

## 3. Customer / retailer permission review

`VERIFIED FROM SOURCE` (migration) + `VERIFIED AGAINST LIVE DATABASE` (writes blocked).

| Requirement | Migration mechanism | Assessment |
|---|---|---|
| 1. Customers cannot read/modify other customers' data | `profiles_select_own` / `profiles_update_own` scoped `id = auth.uid()` (L250–L260) | **Met in design.** Test assertions 14, 17. |
| 2. Customers cannot self-grant retailer/admin | Role hard-coded `'CUSTOMER'` in `handle_new_user` (L144); `role`/`is_active`/`email` excluded from column `UPDATE` grant (L284); check constraint (L70–L71) | **Met in design.** Strong: enforced at three layers. |
| 3. Client checkboxes / localStorage never establish authorization | `isAdmin()` reads `state.profile.role` from the `profiles` table; `loadProfile()` falls back to `CUSTOMER` on error | **Met in the feat client.** |
| 4. Retailer operations authorized server-side | `packages_admin_write` policy gates all writes on `is_retailer_admin()` (L268–L271) | **Met in design.** |
| 5. Retailer access limited to authorized accounts | Single id promoted by verified check (L341–L389) | **Met in design**, but see risk C-2. |
| 6. Database stays restricted under direct API calls | RLS + `revoke all` then least-privilege `grant` (L278–L286) | **Met in design.** `revoke` precedes `grant`, so pre-existing broad grants are removed. |
| 7. Historical bundles + admin account preserved | Additive-only DDL; `on conflict do nothing` backfill; no `DROP TABLE`/`TRUNCATE`/`DELETE` | **Met in design.** |

Live check: anon `INSERT` on `packages` is rejected (401/42501), so requirement 6 holds on the
live database **today**, before the migration.

**Client-side gate is correctly treated as UX only.** `isAdmin()` (`feat index.html L281–283`)
hides the admin console; the database is the real boundary. Good separation.

---

## 4. OTP architecture findings and recommendation

**Finding: no OTP architecture exists.** `VERIFIED FROM SOURCE`

- Zero `otp` references in the migration; `otp_challenges` table does not exist (404).
- No Edge Functions in the repository or its history.
- The feat client uses `signInWithPassword` / `signUp` only — the demo OTP was removed.
- The word "OTP" appears in the README only to state that the demo OTP is gone.

**Live auth capability** (`VERIFIED AGAINST LIVE DATABASE`, `/auth/v1/settings`):

| Setting | Value | Consequence |
|---|---|---|
| `external.email` | `true` | Email/password sign-in available |
| `external.phone` | **`false`** | **SMS/phone OTP is not enabled** |
| `sms_provider` | `twilio` | A provider is named but the phone provider is off |
| `disable_signup` | `false` | Open signup |
| `mailer_autoconfirm` | `false` | Email confirmation required (matches README) |

### Options compared

**Option A — Supabase native Phone Auth (`signInWithOtp({ phone })` + `verifyOtp`).**
Supabase issues the session itself, so there is no custom challenge table, no custom rate
limiter, and no OTP material to store. Expiry, attempt limits, and per-phone throttling are
managed by the platform. The official Send SMS Hook lets a project route messages through its
own provider, or fall back between providers, while still letting Supabase mint the OTP and the
session. Requires enabling the Phone provider and configuring an SMS provider.
*Cost:* per-message provider fees; vendor lock-in on the auth surface.

**Option B — Custom OTP endpoints (Edge Function + `otp_challenges` table + own SMS adapter).**
Full control over eligibility gating and message copy. But it requires the project to own
generation, hashing, expiry, attempt counting, replay prevention, rate limiting, race-safe
consumption, and provider-failure handling — and to issue sessions via the admin API with a
**service-role key**, which must never reach the browser.
*Cost:* every one of those concerns becomes a place to get security wrong; needs a server
runtime and secret management.

### Recommendation

**Option A**, with Option B's one advantage — eligibility gating — preserved *inside* Supabase
using the **Before User Created hook**, so an ineligible MSISDN never becomes an account.

Rationale, grounded in this repository:

1. The only credential the project ships is the publishable key, and the README's central claim
   is "every authorisation decision is enforced by Postgres RLS." Option B's session issuance
   would require a service-role key, contradicting that posture and creating the single most
   dangerous secret in the system.
2. `public.profiles.msisdn` already exists, and `handle_new_user` already copies `msisdn` from
   `raw_user_meta_data` (L146). Eligibility is therefore a natural database-side check.
3. The live project already has Twilio configured as `sms_provider`, so Option A is the
   smallest change from the current configuration.
4. Reusing Supabase's OTP handling satisfies the requirement "do not store OTP verification
   material yourself" by construction.

`REQUIRES OWNER DECISION`: whether the phone provider should be enabled, which SMS provider and
credentials to use, and whether WhatsApp (Twilio/Twilio Verify only) is required.

---

## 5. Migration-by-migration compatibility assessment

Only one migration exists: `supabase/migrations/20261017120000_auth_profiles_rls.sql`.
`VERIFIED FROM SOURCE`

| Section | Lines | Purpose | Type |
|---|---|---|---|
| 0 Guard rails | 24–34 | Require `public` and `auth` schemas | Additive |
| 1 `profiles` | 39–75 | Create if absent; add columns; normalise legacy roles; check constraint; index | Additive, one data `UPDATE` |
| 1b `packages` | 81–104 | Create if absent; add columns | Additive |
| 2 `set_updated_at` | 111–127 | `updated_at` trigger, `SECURITY INVOKER`, `search_path=''` | Additive |
| 3 `handle_new_user` | 134–161 | `SECURITY DEFINER`; hard-codes `CUSTOMER`; `on_auth_user_created` on `auth.users` | Additive |
| 4 Backfill | 166–173 | Create profiles for pre-trigger auth users | Additive (`on conflict do nothing`) |
| 5 `is_retailer_admin` | 179–221 | `SECURITY DEFINER` role helper + definer-ownership assertion | Additive |
| 6 RLS | 226–271 | Enable RLS; **drop every existing policy** on both tables; create 4 policies | **Destructive to policies** (by design) |
| 7 Grants | 278–286 | `revoke all` from `public/anon/authenticated`, then least-privilege grants | **Destructive to grants** (by design) |
| 8 Admin preservation | 341–389 | Verify then promote the retailer admin | Additive, one `INSERT … ON CONFLICT DO UPDATE` |
| 9 Final verification | 394–411 | Assert the four intended policies exist | Assertion only |

### Compatibility with the observed live schema

**Compatible.** `INFERRED FROM MIGRATION`, corroborated by live column probes. Every DDL
statement is `create table if not exists` / `add column if not exists`, so the five existing
`packages` rows and any existing `profiles` rows survive. Section 1's `update` touches only
rows whose `role` is null or not in the allowed set — on a table where `role` is already
`CUSTOMER`/`RETAILER_ADMIN` this matches nothing.

### Risks to existing data

| Risk | Detail | Severity |
|---|---|---|
| Section 6 drops all policies | Intentional, but it is the one operation that changes an unknown live state. Correct for hardening; must be reviewed as a policy change, not a data change. | Medium |
| Section 7 `revoke all` | Removes table-level grants. If any *legitimate* server-side path relied on a broad grant, it breaks. | Medium |
| Section 1 role normalisation | Any row with an unexpected role (e.g. `ADMIN`, `RETAILER`) is silently rewritten to `CUSTOMER`. Reversible only by re-promotion. | Low–Medium |
| Section 8 promotion | `on conflict do update set role='RETAILER_ADMIN'` overwrites whatever role that row had. | Low |
| `packages` not `NOT NULL` on `title` | The `create table` declares `title text not null`, but `add column if not exists title text` does not. On an existing table, `title` stays nullable. Cosmetic schema drift. | Low |

### Preconditions

1. Target must be a Supabase database (the migration hard-fails otherwise — `auth` schema check, L29–L33). `VERIFIED FROM SOURCE`
2. `auth.users` must contain the authorized admin id `bdd8f73c-fd23-4d76-9d23-7f4942300c36`, or `expresso.retailer_admin_id` must be set first. **`NOT VERIFIED`** — `auth.users` is not readable with the publishable key.
3. No `packages` row may have a `created_by` other than that admin (L371–L377). **`VERIFIED AGAINST LIVE DATABASE`**: all five rows share `created_by = bdd8f73c-…`, so this check passes.
4. Permission to create a trigger on `auth.users` and to `revoke`/`grant` on `public` — i.e. an owner/postgres connection. `REQUIRES OWNER DECISION`

### Post-migration checks

Section 9 asserts the four policies exist. Sections 7 and 5 contain inline post-conditions that
abort the transaction if a client can still `UPDATE` a protected column, if `anon`/`PUBLIC`
retain any privilege, or if a `SECURITY DEFINER` function is owned by a client role. These are
strong, self-verifying guards. `VERIFIED FROM SOURCE`

### Rollback and recovery

- The migration runs in a single `begin; … commit;` (L17, L413). A failure inside any `do $$`
  block rolls the whole thing back — **except** where a `raise warning` is used instead of
  `raise exception` (L380–L383, empty-catalogue case), which continues and promotes on the
  configured id alone.
- There is **no down-migration**. Recovery from a bad apply means restoring from a Supabase
  backup (PITR if enabled) or manually re-granting/re-creating policies.
- Because the DDL is additive, the *data* risk is low; the *policy/grant* risk is the one that
  needs a rollback plan. `REQUIRES OWNER DECISION`: confirm PITR/backup availability and take a
  snapshot before applying.

---

## 6. Frontend / backend API contract review

`VERIFIED FROM SOURCE`. The feat client calls Supabase directly (no custom API layer).

| Operation | Contract present? | Evidence | Gap |
|---|---|---|---|
| Sign-up | Yes | `auth.signUp({ email, password, options.data })` — `feat index.html` L420–L426 | No `emailRedirectTo`; confirm-email flow depends on a dashboard setting the README flags as required |
| Sign-in | Yes | `auth.signInWithPassword` L435 | `describeAuthError` maps errors, but the mapping table is not documented |
| Sign-out | Yes | `auth.signOut()` L474 | Swallows exceptions silently |
| Session bootstrap | Yes | `auth.getSession()` + `onAuthStateChange` L826–L850 | Correctly defers work out of the auth callback via `setTimeout` to avoid deadlock — good |
| Profile read | Yes | `.from("profiles").select("id, role, full_name, msisdn, is_active").eq("id", user.id).maybeSingle()` L326–L329 | **Contract mismatch:** `is_active` is selected but **does not exist live**. Today this query would fail and silently fall back to a `CUSTOMER` profile. |
| Package read | Yes | `.from("packages").select(...).eq("is_enabled", true)` L346–L350 | Consistent with live columns |
| Bundle create | Yes | `.from("packages").insert({...})` L500–L504 | Sends `created_by: state.session.user.id` — **client-supplied**. RLS ignores it, but the column is not validated against `auth.uid()` server-side. |
| Bundle toggle | Yes | `.from("packages").update({ is_enabled }).eq("id", id)` L514 | Fine |
| OTP request | **No** | — | Entire contract missing |
| OTP verify | **No** | — | Entire contract missing |
| Eligibility failure | **No** | — | No code, no shape, no status code |
| Unauthorized customer op | Implicit only | Postgres error surfaced via `error.message` into `alert()` L504/L514 | No defined response shape; raw database text is shown to the user |
| Rate limiting / retry | **No** | — | No `Retry-After` handling, no backoff, no disabled-button-on-429 |
| Validation errors | Partial | Client-side only (email regex, password length) L388–L406 | No server-side contract |
| Server failure | Partial | Generic catch → "Network error" L438–L439 | No distinction between 4xx and 5xx |

**Conflicts found**

1. **`profiles.is_active` is selected but absent live.** `INFERRED FROM MIGRATION` + `VERIFIED AGAINST LIVE DATABASE`. Once the migration is applied this resolves; before then, the client degrades to a CUSTOMER fallback. This is a real ordering dependency: the client must not ship before the migration.
2. **Raw database messages in `alert()`.** Error text from Postgres is shown directly to the user. Acceptable for a demo, but it leaks schema details; Chapter 3 should map errors to safe, stable messages.
3. **`created_by` trusted from the client.** RLS prevents unauthorized inserts, so this is not exploitable, but a `default auth.uid()` or a `with check (created_by = auth.uid())` would make the intent explicit.

---

## 7. Security test matrix

Legend: **Exists** = a committed test covers it. **Run** = executed during this audit with the
recorded result. **Blocked** = cannot run in this environment.

| ID | Preconditions | Action | Expected | Endpoint / table / policy | Exists | Run | Evidence |
|---|---|---|---|---|---|---|---|
| T-01 | Fresh DB + legacy permissive state | Apply migration twice | Clean, idempotent | migration | Yes | **Yes — pass** | `auth-rls.test.mjs` #1 (54/54) |
| T-02 | Migration applied | New `auth.users` row | Profile created, role `CUSTOMER` | `on_auth_user_created` | Yes | **Yes — pass** | #4, #5 |
| T-03 | Customer session | `UPDATE profiles SET role='RETAILER_ADMIN'` | Rejected / unchanged | `profiles` column grant | Yes | **Yes — pass** | #8 |
| T-04 | Customer session | Set `is_active=false`, change `email` | Unchanged | `profiles` column grant | Yes | **Yes — pass** | #9, #10 |
| T-05 | Customer session | Update own `full_name`/`msisdn` | Allowed | `profiles_update_own` | Yes | **Yes — pass** | #11, #12 |
| T-06 | Two customers | Read other's profile | Empty | `profiles_select_own` | Yes | **Yes — pass** | #14, #17 |
| T-07 | Anon key | Read `profiles` | Empty | `profiles_select_own` | Yes | **Yes — pass** | #15; also live probe `[]` |
| T-08 | Anon key | Read `packages` | Rejected | `packages_select_authenticated` | Yes | **Yes — pass** | #18 |
| T-09 | Customer session | Insert/update `packages` | Rejected | `packages_admin_write` | Yes | **Yes — pass** | #19, #20 |
| T-10 | Retailer session | Read all profiles / all packages | Allowed | `is_retailer_admin()` | Yes | **Yes — pass** | #21, #22 |
| T-11 | Retailer session | Create/update packages | Allowed | `packages_admin_write` | Yes | **Yes — pass** | #23, #24 |
| T-12 | Any role | Execute helpers from `PUBLIC`/`anon` | Denied | function grants | Yes | **Yes — pass** | #25–#27 |
| T-13 | Any session | Insert invalid role | Check violation | `profiles_role_check` | Yes | **Yes — pass** | #30 |
| T-14 | Pre-existing data | Apply migration | Rows preserved | migration | Yes | **Yes — pass** | #31, #32 |
| T-15 | Client in browser | Validation, retention, error path, role gating, sign-out | As specified | client | Yes | **Yes — pass** | `auth-ui.test.mjs` 32/32 |
| T-16 | Source scan | Demo OTP / PIN / checkbox / service-role key absent | Absent | client | Yes | **Yes — pass** | `security-static.test.mjs` 36/36 |
| T-17 | Live anon key | Read `packages` | **Rejected** | `packages_select_authenticated` | **No** | **Yes — FAILS** | Live: HTTP 200, 5 rows returned |
| T-18 | Live anon key | Insert `packages` | Rejected | `packages_admin_write` | **No** | **Yes — pass** | Live: 401 `42501` |
| T-19 | Live anon key | Read `profiles` | Empty | `profiles_select_own` | **No** | **Yes — pass** | Live: `[]`, `*/0` |
| T-20 | Unregistered phone | Request OTP | Eligibility refusal | not implemented | **No** | **Blocked** | No endpoint exists |
| T-21 | Registered phone | Request OTP | SMS dispatched | not implemented | **No** | **Blocked** | No endpoint exists |
| T-22 | OTP issued | Verify wrong code | Rejected, attempt counted | not implemented | **No** | **Blocked** | No endpoint exists |
| T-23 | OTP issued | Verify after expiry | Rejected | not implemented | **No** | **Blocked** | No endpoint exists |
| T-24 | OTP consumed | Replay same code | Rejected | not implemented | **No** | **Blocked** | No endpoint exists |
| T-25 | OTP issued | Exceed attempt limit | Locked out | not implemented | **No** | **Blocked** | No endpoint exists |
| T-26 | Any client | Exceed request rate limit | 429 + `Retry-After` | not implemented | **No** | **Blocked** | No endpoint exists |
| T-27 | Any client | Concurrent verify of one challenge | Exactly one success | not implemented | **No** | **Blocked** | No endpoint exists |
| T-28 | SMS provider down | Request OTP | Clean failure, no session | not implemented | **No** | **Blocked** | No endpoint exists |
| T-29 | Any client | Trigger error, inspect response/logs | No OTP, key, or PII leak | not implemented | **No** | **Blocked** | No endpoint exists |
| T-30 | Retailer session | Duplicate/concurrent bundle create | No duplicate corruption | `packages` | **No** | **Blocked** | No uniqueness constraint or test exists |
| T-31 | Migration applied | Post-apply column/ grant audit | Matches intent | live DB | **No** | **Blocked** | No DB credential available |

**Honest statement:** T-01 through T-16 **ran and passed**. T-17 **ran and failed** (a real
finding). T-18 and T-19 ran and passed. T-20 through T-31 **did not run**; they are blocked, and
are not claimed as passing.

Reproduction of the feat-branch suites (isolated git worktree at `2a433cf`):

| Command | Result | Exit |
|---|---|---|
| `npm install` | 85 packages | 0 |
| `npm test` (→ `test:rls`, `test:static`, `test:ui`) | 54 + 36 + 32 = **122 passed, 0 failed** | 0 |

This reproduces the README's claim of 54 / 36 assertions, plus 32 UI assertions.

---

## 8. Data-preservation and rollback requirements

`VERIFIED FROM SOURCE` + `VERIFIED AGAINST LIVE DATABASE`

| Asset | Must survive | Mechanism | Confidence |
|---|---|---|---|
| 5 `packages` rows (incl. `created_by`) | Yes | Additive DDL only; no `DELETE`/`TRUNCATE`/`DROP TABLE` anywhere in the migration | High |
| Existing `profiles` rows | Yes | `on conflict do nothing` backfill; additive columns | High |
| Authorized admin account | Yes | Explicit verify-then-promote block (L341–L389) | High, conditional on precondition 2 |
| Existing RLS policies | **No — intentionally replaced** | Section 6 drops all policies on both tables, then creates 4 | By design |
| Existing grants | **No — intentionally replaced** | Section 7 `revoke all`, then least-privilege grants | By design |

Requirements before applying:

1. Confirm `auth.users` contains `bdd8f73c-fd23-4d76-9d23-7f4942300c36`, **or** set
   `expresso.retailer_admin_id` to a verified id. `REQUIRES OWNER DECISION`
2. Take a database snapshot / confirm PITR, because there is no down-migration.
3. Have an owner-level connection (`auth.users` trigger creation + `revoke`/`grant`).
4. Re-run the four post-conditions and the policy assertion (they self-check, but record the output).
5. After applying, re-run the client's `profiles` query, since `is_active` will then exist.

---

## 9. Risk register

### Critical

- **C-1 — The deployed/live database is unhardened and anon-readable for `packages`.**
  Live anon read of `public.packages` returns all five rows (HTTP 200), while the intended policy
  `packages_select_authenticated` grants reads only to `authenticated`. The migration that would
  fix this **has not been applied**. Severity is bounded because the catalogue is not
  confidential, and anon *writes* are already blocked (401). `VERIFIED AGAINST LIVE DATABASE`.
- **C-2 — Merging `feat/supabase-auth-rls` into `main` would revert Chapter 1 and break the PWA.**
  Confirmed by `git merge-tree`: conflicts in `.gitignore`, `index.html`, `package-lock.json`,
  `package.json`, `tests/security-static.test.mjs`. Worse, the feat branch **does not contain
  `sw.js` at all**, has no `sanitizeState`, and has no SRI pin — a naive merge would delete the
  service worker, drop the untrusted-state validation, and un-pin the CDN script.
  `VERIFIED FROM SOURCE`. **This must be resolved by rebasing/merging Chapter 1 into the auth
  work, never by merging the branch as-is.**

### High

- **H-1 — No OTP implementation exists.** Every requirement in the assignment's Phase 4 is
  currently unaddressed: no endpoint, no challenge storage, no rate limiting, no expiry, no
  provider adapter. `VERIFIED FROM SOURCE`.
- **H-2 — Phone auth is disabled live** (`external.phone: false`), so a phone-OTP design cannot
  be tested end to end until the owner enables it and configures an SMS provider.
  `VERIFIED AGAINST LIVE DATABASE`.
- **H-3 — `profiles.is_active` is queried by the client but does not exist live.** Until the
  migration runs, the profile read fails and the client silently falls back to `CUSTOMER`.
  `VERIFIED AGAINST LIVE DATABASE`. Ordering dependency: migration before client deploy.

### Medium

- **M-1 — Section 6/7 are the only state-changing operations and act on unknown live state.**
  Correct in intent, but they should be reviewed as a policy/grant change with a snapshot taken.
- **M-2 — Section 1 silently rewrites unexpected role values to `CUSTOMER`.** Any legitimate
  non-standard role in the live table would be lost.
- **M-3 — No uniqueness constraint or concurrency test for bundle creation** (test T-30 blocked).
- **M-4 — Raw Postgres error text is surfaced to users** via `alert(error.message)`.
- **M-5 — `created_by` is supplied by the client** rather than defaulted server-side.

### Low

- **L-1 — `packages.title` is `NOT NULL` only on the create path**, so an existing table keeps a
  nullable `title`.
- **L-2 — No down-migration**, so rollback depends on backups.
- **L-3 — `signOut()` swallows errors**, so a failed sign-out is indistinguishable from success.
- **L-4 — No `emailRedirectTo`** on sign-up, so the confirmation link target is a dashboard default.

---

## 10. Unresolved questions and external dependencies

| # | Question | Needs |
|---|---|---|
| Q-1 | Is `bdd8f73c-fd23-4d76-9d23-7f4942300c36` still a live `auth.users` account? | Owner confirmation, or a verified replacement id |
| Q-2 | Should phone/SMS auth be enabled, and with which provider and credentials? | Owner decision + provider secrets |
| Q-3 | Is WhatsApp OTP required? (Twilio / Twilio Verify only) | Owner decision |
| Q-4 | Which MSISDNs are eligible, and where does that list live? | Owner decision — the eligibility source of truth |
| Q-5 | Are PITR/backups enabled for the Supabase project? | Owner confirmation |
| Q-6 | Will an owner-level DB connection be available to apply the migration? | Owner action |
| Q-7 | Should the migration be applied before or after the Chapter 1 frontend? | Owner decision — recommended: migration first, then client |
| Q-8 | What is the intended production SMS vs staging/mock separation? | Owner decision |

---

## 11. Recommended implementation order for Chapter 3

1. **Reconcile the branches first.** Merge/forward-port Chapter 1 (`main` @ `47bbc4b`) into the
   auth line, or rebase the auth commits onto `main`, so `sw.js`, `sanitizeState`, and the SRI
   pin survive. Resolve the five conflicting files deliberately. **Do not merge `feat` as-is** (C-2).
2. **Resolve Q-1, Q-5, Q-6.** Verify the admin id, confirm backups, obtain an owner connection.
3. **Apply the existing migration** to a staging project first; run the feat RLS suite against
   the applied result; then apply to production with a snapshot taken.
4. **Re-run the client against the migrated schema** to confirm the `is_active` query now succeeds (H-3).
5. **Decide and enable the OTP channel** (Q-2, Q-3): enable the phone provider and configure the
   SMS provider, or wire the Send SMS Hook.
6. **Implement OTP on Option A**, adding eligibility gating via the Before User Created hook and
   a `msisdn` uniqueness constraint on `profiles`.
7. **Add the missing contracts**: OTP request/verify, eligibility failure, rate-limit response,
   and safe error mapping (replacing raw `alert(error.message)`).
8. **Extend the test matrix** to cover T-20–T-31, including concurrency and replay.
9. **Harden `created_by`** to `default auth.uid()` with a matching `with check`.

---

## 12. Chapter 2 readiness checklist

| Criterion | Status |
|---|---|
| Repository fully inventoried, all branches and SQL located | **Done** |
| Live schema facts separated from migration-derived assumptions | **Done** |
| Migration compatibility assessed section by section | **Done** |
| Data-preservation and rollback requirements documented | **Done** |
| Customer/retailer authorization design reviewed against all 7 requirements | **Done** |
| OTP options compared and one recommended | **Done** |
| API contract gaps enumerated | **Done** |
| Security test matrix produced, with honest run status | **Done** |
| Critical merge-regression risk (C-2) identified | **Done** |
| Live `packages` anon-read exposure identified (C-1) | **Done** |
| Admin-account existence verified | **Not verified — needs owner** |
| Live RLS policy/grant/function catalogue inspected | **Not verified — no DB credential** |
| OTP implementation present | **Not implemented — Chapter 3** |
| Migration applied to production | **Not applied — by design, out of scope** |

**Chapter 2 status: PARTIAL PASS — audit complete, design blocked on owner decisions.**
Every repository-inspection and compatibility-review task was completed. The chapter cannot be
declared complete because critical questions (Q-1, Q-2, Q-5, Q-6) require owner input, no live
database credential was available for catalogue-level verification, and the branch-reconciliation
risk C-2 must be resolved before any auth work can be merged.

No application code, migration, policy, or production record was modified by this audit.
