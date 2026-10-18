# Chapter 2 — Backend Security Design: Final Readiness Report

Repository: `haroonahmad-ux/expresso-app`
Report branch: `chapter-2/final-report` (branched from `chapter-2/audit-report` @ `00a6f19`)
Supersedes: `docs/chapter-2-audit.md` (kept unchanged; this is the updated companion)
Report type: read-only design review. No migration executed, no Supabase configuration
changed, no production record modified, no application code changed, nothing merged to `main`.

Revision 2 (finalisation). This revision records one **approved owner decision** — the
`public.packages` access rule — and completes the design documentation for phone OTP,
eligibility, database-backed authorization, RLS policies, API access, migration safety and the
security test matrix. The decision is **approved but not implemented**: it is a Chapter 3 change.
Nothing in this revision alters code, policies, migrations or production state.

> **Companion — implementation.** The design in this document is now implemented on this branch.
> See `docs/chapter-2-implementation-report.md` for the code changes, the exact commands run and
> the recorded results (195 automated checks pass; the live C-1 probe still fails until the
> migration is applied, because no database credential is available).

Evidence labels:

| Label | Meaning |
|---|---|
| `VERIFIED FROM SOURCE` | Read directly from a committed file in this repository. |
| `VERIFIED AGAINST LIVE DATABASE` | Observed through read-only PostgREST/GoTrue requests using the public publishable key. |
| `INFERRED FROM MIGRATION` | Deduced from migration SQL; not confirmed against the live database. |
| `NOT VERIFIED` | Could not be confirmed with the access available. |
| `OWNER DECISION REQUIRED` | Needs a choice or credential that only the owner can supply. |

---

## 0. Scope note and a correction to the task premise

This chapter was requested as a continuation of "the existing Chapter 2 audit report" and an
"existing 31-case matrix". The report **does exist** — `docs/chapter-2-audit.md` on branch
`chapter-2/audit-report` (`00a6f19`) — and this document continues from it.

Two premise details do not match the repository, and are corrected here rather than repeated:

1. **The test matrix is a 31-case matrix.** It is exactly as the earlier report left it
   (T-01 … T-31). This report reuses that numbering. The *separate* feat-branch regression
   suites are 122 assertions (54 + 36 + 32) and the Chapter 1 suite is 105 assertions
   (6 + 50 + 17 + 16 + 16); those are implementation tests, not the design matrix.
2. **`main` has moved since the earlier baseline.** The earlier report recorded `main` at
   `26a760d`. It is now `47bbc4b` (PR #1, Chapter 1 merged). This is a change made by the
   owner through GitHub, not by this work. It is recorded here as fact.

3. **One previously-open decision is now approved.** The `public.packages` access rule (Q-8) was
   resolved by the owner in Revision 2: **authenticated-only; anonymous access is prohibited.**
   See §5.2. It is recorded as an approved decision, not as an implemented or verified change.

---

## 1. Executive summary

Chapter 2 is a **design and readiness review**, and that work is now complete. Every
repository-inspection, compatibility, contract and test-inventory task is done, and the
remaining items are decisions or credentials that only the owner can supply.

What is solid:

- The database-enforced authorization design is sound and was independently re-verified.
  Role escalation is blocked at three layers (hard-coded `CUSTOMER` on signup, column-level
  `UPDATE` grants, and a check constraint). `VERIFIED FROM SOURCE` + `VERIFIED AGAINST LIVE DATABASE`.
- The migration is additive, non-destructive to data, and self-verifying (inline
  post-conditions plus a final policy assertion). `VERIFIED FROM SOURCE`.
- 122 feat-branch assertions and 105 Chapter 1 assertions pass in this environment.
- The authorized admin UUID is corroborated by live catalogue authorship. `VERIFIED AGAINST LIVE DATABASE`.

What blocks a PASS:

- **C-1** — the live `packages` table is anonymously readable (5 rows). Confirmed again. The
  fixing migration is **not applied**.
- **C-2** — merging `feat/supabase-auth-rls` into `main` as-is would revert Chapter 1 and break
  the PWA. Re-confirmed with `git merge-tree`.
- **H-1/H-2** — no OTP implementation exists and phone auth is disabled live, so the OTP design
  cannot be tested end to end.
- **Q-1 … Q-7** — seven owner decisions remain open (admin id, OTP channel/provider,
  eligibility source, backups, owner-level DB access, deployment ordering).

What was decided this revision:

- **Q-8 (approved):** `public.packages` is readable by `authenticated` users only; anonymous
  access is prohibited. **Approved but not implemented** — it closes C-1 only when the
  migration is applied.

**Chapter 2 status: PARTIAL PASS (design complete).** The design work is finished, but
implementation and live verification are out of scope here and are **not** claimed as done. Seven
owner decisions remain open, C-1 is still live, and every OTP test is still **NOT RUN**.

### 1.1 Design completion vs implementation vs live verification

Chapter 2 is a design chapter. These three states must not be conflated:

| State | Meaning | What is in this state |
|---|---|---|
| **Design complete** | The approach is specified well enough to build and test | OTP architecture, eligibility model, authorization model, RLS catalogue, API access rules, migration safety principles, test matrix, decision register |
| **Implemented** | Code, policies or config exist in a branch or project | Only the *existing* auth client and migration draft (from earlier chapters). The OTP design, eligibility hook and the Q-8 policy change are **not implemented** |
| **Live verified** | Confirmed against the running production project | Live schema probes and anon-access probes only. No OTP flow, no migration apply, no post-migration audit |

**Not claimed anywhere in this report:** that Chapter 2 implementation is complete, or that any
live security test has passed. Tests marked **NOT RUN** (T-20…T-31) remain not run; T-17
remains a live **FAIL**. The approved Q-8 decision is a *decision*, not a deployed control.

---

## 2. Verified repository and database findings

### 2.1 Branch inventory `VERIFIED FROM SOURCE`

| Branch | SHA | Role |
|---|---|---|
| `main` | `47bbc4bd4b113c97491518bc1d5876ae838f1445` | Chapter 1 merged via PR #1 |
| `chapter-1/final-verification` | `66e1a12a203357385386893f6b6f47813cb1c62b` | Source of PR #1 |
| `chapter-2/audit-report` | `00a6f19305e81006247e5e7f85d1c296a20ef1c9` | Existing Chapter 2 report |
| `chapter-2/final-report` | *(this branch)* | This updated report |
| `feat/supabase-auth-rls` | `2a433cf69c5e7e64ff1d7f6a9581b61f4d806f53` | All auth + RLS material |
| `backup-working-demo` | `5e7b860af452c924ab82eaeadc20e13fdc7f92b9` | Historical backup |

`feat/supabase-auth-rls` merge-base with `main` is `26a760d` — the auth line branched **before**
Chapter 1. `VERIFIED FROM SOURCE`.

### 2.2 Live schema `VERIFIED AGAINST LIVE DATABASE`

Read-only PostgREST probes with the publishable key. No credentials are reproduced.

| Observation | Result |
|---|---|
| `GET /rest/v1/packages` (anon) | **HTTP 200, 5 rows**, `content-range: 0-4/*` |
| `GET /rest/v1/profiles` (anon) | HTTP 200, `[]` |
| `POST /rest/v1/packages` (anon) | HTTP 401 `42501` RLS violation → RLS **enabled** |
| `external.email` | `true` |
| `external.phone` | **`false`** |
| `sms_provider` | `twilio` (configured but inactive) |
| `disable_signup` | `false` |

Live package titles observed (public catalogue, not confidential): `Social WhatsApp & YT`,
`Weekly Mega Pro`, `Weekly Voice Plus`, `Monthly Supreme 40GB`, `Daily Super Internet`.

The migration is **not applied**: live `profiles` still lacks `updated_at`, `email`, `is_active`.
`VERIFIED AGAINST LIVE DATABASE`.

`NOT VERIFIED`: grants, `pg_policies`, function ownership, `auth.users` contents — no database
credential is available in this environment.

---

## 3. Customer / retailer permission matrix

Legend: `SRC` = VERIFIED FROM SOURCE · `LIVE` = VERIFIED AGAINST LIVE DATABASE ·
`INF` = INFERRED FROM MIGRATION · `N/V` = NOT VERIFIED · `ODR` = OWNER DECISION REQUIRED.

| # | Actor | Operation | Intended result | Enforcement | Status |
|---|---|---|---|---|---|
| 1 | anon | read `packages` | per policy | `packages_select_authenticated` | **Currently allowed live (C-1)** `LIVE` |
| 2 | anon | write `packages` | denied | `packages_admin_write` | Denied `LIVE` |
| 3 | anon | read `profiles` | denied | `profiles_select_own` | Denied `LIVE` |
| 4 | customer | read own profile | allowed | `profiles_select_own` | `SRC` (test T-06/T-07) |
| 5 | customer | read another profile | denied | `profiles_select_own` | `SRC` (T-06) |
| 6 | customer | update own `full_name`/`msisdn` | allowed | column grant | `SRC` (T-05) |
| 7 | customer | set own `role` | denied | column grant + check | `SRC` (T-03) |
| 8 | customer | set own `is_active`/`email` | denied | column grant | `SRC` (T-04) |
| 9 | customer | write `packages` | denied | `packages_admin_write` | `SRC` (T-09) |
| 10 | retailer | read all `profiles` | allowed | `is_retailer_admin()` | `SRC` (T-10) |
| 11 | retailer | read all `packages` | allowed | `is_retailer_admin()` | `SRC` (T-10) |
| 12 | retailer | create/update/delete `packages` | allowed | `packages_admin_write` | `SRC` (T-11) |
| 13 | anon/`PUBLIC` | execute helper functions | denied | function grants | `SRC` (T-12) |
| 14 | any | insert invalid role | denied | `profiles_role_check` | `SRC` (T-13) |
| 15 | owner | apply migration | — | — | `ODR` (Q-6) |
| 16 | retailer | duplicate bundle create | no corruption | no constraint today | `N/V` (T-30 blocked) |
| 17 | client | choose its own role | impossible | DB-only roles | `SRC` (T-16) |
| 18 | unregistered phone | request OTP | eligibility refusal | not implemented | `ODR` (Q-4) |

**Design conclusion:** authorization is correctly centralised in the database. The client gate
(`isAdmin()`) is UX only, which is the right separation. `VERIFIED FROM SOURCE`.

### 3.1 Database-backed authorization model (design) `VERIFIED FROM SOURCE`

Authorization is a function of database state only. The client never holds a role it can assert.

| Element | Definition | Where it lives |
|---|---|---|
| Role vocabulary | `CUSTOMER`, `RETAILER_ADMIN` | `profiles.role` + `profiles_role_check` |
| Default role | `CUSTOMER` on every signup | `handle_new_user()` trigger |
| Admin predicate | `is_retailer_admin()` returns true iff the caller's `profiles.role = 'RETAILER_ADMIN'` and `is_active` | `public.is_retailer_admin()`, `SECURITY DEFINER` |
| Identity | `auth.uid()` from the JWT | Supabase Auth |
| Role source | `profiles` row keyed by `auth.uid()` | `profiles` table |

Three independent enforcement layers block self-promotion (all `VERIFIED FROM SOURCE`):

1. **Provisioning** — `handle_new_user()` hard-codes `role = 'CUSTOMER'` and ignores any
   client-supplied `role` in `raw_user_meta_data`. (Test T-02.)
2. **Column privileges** — `authenticated` holds column-level `UPDATE` on `full_name` and
   `msisdn` only; `role`, `is_active` and `email` are excluded. (Tests T-03, T-04.)
3. **Domain constraint** — `profiles_role_check` rejects any value outside the vocabulary.
   (Test T-13.)

### 3.2 RLS policy catalogue (design) `VERIFIED FROM SOURCE`

| Policy | Table | Command | Roles | Using / With check |
|---|---|---|---|---|
| `profiles_select_own` | `profiles` | `SELECT` | `authenticated` | `id = auth.uid() OR public.is_retailer_admin()` |
| `profiles_update_own` | `profiles` | `UPDATE` | `authenticated` | `using id = auth.uid()` / `with check id = auth.uid()` |
| `packages_select_authenticated` | `packages` | `SELECT` | `authenticated` | `is_enabled OR public.is_retailer_admin()` |
| `packages_admin_write` | `packages` | `ALL` | `authenticated` | `using public.is_retailer_admin()` / `with check public.is_retailer_admin()` |

RLS is **enabled** on both tables. Every pre-existing policy is dropped before these four are
created, because RLS policies are OR-ed and one surviving permissive policy defeats the set.
Table privileges are revoked from `public`, `anon` and `authenticated`, then re-granted at least
privilege (`SELECT`, plus column-scoped `UPDATE(full_name, msisdn)`). `anon` holds **no** policy
and **no** privilege, which is exactly the state the approved Q-8 decision requires.

### 3.3 Authorization decision flow (design)

```
request -> Supabase Auth (JWT with auth.uid())
        -> PostgREST -> table privilege check (column-level)
                     -> RLS policy evaluation (profiles / packages)
                        -> is_retailer_admin() (SECURITY DEFINER, search_path='')
```

A denial can occur at the privilege layer (no column grant) or the policy layer (row predicate),
and both are enforced by Postgres, not by the client.

---

## 4. Recommended OTP architecture and API contracts

### 4.1 Comparison

| Criterion | A — Supabase native Phone Auth | B — Custom OTP endpoints |
|---|---|---|
| Session issuance | Supabase Auth issues it | Must be issued via admin API with a **service-role key** |
| OTP storage | None (platform-managed) | `otp_challenges` table you must hash and guard |
| Expiry / attempts / throttling | Built in (60 s resend, 1 h expiry, configurable rate limits) | All built by hand |
| Replay prevention | Platform-enforced single use | Hand-built, easy to get wrong |
| Provider choice | Twilio / Twilio Verify / MessageBird / Vonage / TextLocal; Send SMS Hook for custom or WhatsApp | Fully custom |
| Secrets in scope | None in the browser | Service-role key — the most dangerous secret in the system |
| Fit to this repo | Matches "publishable key only" posture | Contradicts it |

Sources: Supabase Phone sign-in, Rate limits, Send SMS Hook, Before User Created Hook (see
references at the end). `VERIFIED FROM SOURCE` (external documentation).

### 4.2 Recommendation

**Option A — Supabase native phone OTP**, with eligibility enforced server-side using the
**Before User Created hook** (Postgres function or HTTP endpoint) so an ineligible MSISDN never
becomes an account, and — only if WhatsApp is required — the **Send SMS Hook** (WhatsApp is
supported only for Twilio / Twilio Verify).

Rationale grounded in this repository:

1. The only shipped credential is the publishable key; Option B's session issuance would require
   a service-role key, contradicting the project's stated posture. `VERIFIED FROM SOURCE`.
2. `profiles.msisdn` already exists and `handle_new_user` already copies `msisdn` from
   `raw_user_meta_data`. `VERIFIED FROM SOURCE`.
3. The live project already names Twilio as `sms_provider`, so Option A is the smallest change.
   `VERIFIED AGAINST LIVE DATABASE`.
4. Platform-managed OTP means the project never stores verification material.

### 4.3 Design requirements this architecture must satisfy

| Concern | How it is addressed | Status |
|---|---|---|
| Eligibility check | Before User Created hook rejects ineligible MSISDN | Design only |
| Direct-endpoint bypass | Supabase Auth is the only issuer; no custom endpoint to bypass | Design only |
| Replay prevention | Supabase marks an OTP used; single-use semantics | Platform |
| Expiry | 1 h default, configurable | Platform |
| Attempt limits | Platform attempt limits + `rate_limit_verify` | Platform |
| Request rate limit | 60 s resend default + `rate_limit_sms_sent`; add CAPTCHA | Platform + ODR |
| Concurrent requests | Platform serialises per-user challenge state | Platform |
| Provider failure | Surfaced as an Auth error; no session issued | Platform |
| Logging | Auth logs; must never log OTP, keys, or PII | Chapter 3 |

### 4.4 Proposed API contracts (design only — NOT implemented)

**Request OTP** — `POST /auth/v1/otp`
- Request: `{ "phone": "+92XXXXXXXXXX" }`
- Success: HTTP 200, no session, `{}`.
- Errors: `422` invalid phone; `429` rate limited with `Retry-After`; `403` eligibility refusal
  (via Before User Created hook).
- Session: none.
- Logging: phone in masked form; never the OTP.

**Verify OTP** — `POST /auth/v1/verify`
- Request: `{ "phone": "+92XXXXXXXXXX", "token": "123456", "type": "sms" }`
- Success: HTTP 200 with `access_token`, `refresh_token`, `expires_in`.
- Errors: `401` invalid/expired token; `429` too many attempts.
- Session: issued on success; single use.
- Logging: outcome only; never the token.

`NOT VERIFIED`: none of these contracts exist in the repository — there is no `supabase/functions/`,
no `config.toml`, and no OTP code. `VERIFIED FROM SOURCE`.

### 4.5 Eligibility check design (design only)

Eligibility decides whether an MSISDN may obtain an account at all.

| Aspect | Design |
|---|---|
| Enforcement point | **Before User Created hook** (Postgres function or HTTP endpoint), so an ineligible number never becomes an `auth.users` row |
| Source of truth | Owner-supplied eligibility list (Q-4). Not present in the repository |
| Candidate storage | A dedicated table (e.g. `eligible_msisdn`) or a column on a retailer-managed table, read by the hook with `SECURITY DEFINER` |
| Normalisation | E.164 format (`+92…`) before comparison; reject malformed numbers as `422` |
| Failure mode | Hook returns an error object → signup denied, no user created, no OTP sent |
| Bypass resistance | Supabase Auth is the only issuer; there is no custom endpoint to call directly |
| Uniqueness | A unique constraint on `profiles.msisdn` prevents one number mapping to many accounts |

**Important:** `profiles.msisdn` is currently client-writable (it is in the `UPDATE` grant). If it
is ever used as an eligibility key, that write path must be revisited — recorded here as a
design note, not a change.

### 4.6 API access design (design only)

| Surface | Base | Auth | Notes |
|---|---|---|---|
| Data (profiles, packages) | `/rest/v1/` | `apikey` + `Authorization: Bearer <access_token>` | RLS + column privileges decide access |
| OTP request | `/auth/v1/otp` | `apikey` only | No session required |
| OTP verify | `/auth/v1/verify` | `apikey` only | Returns a session on success |
| Token refresh | `/auth/v1/token?grant_type=refresh_token` | `apikey` + refresh token | Single-use refresh token |
| Settings (read) | `/auth/v1/settings` | `apikey` only | Used by this audit |

Rules: the browser ships the publishable key only; the `service_role` key is never used in the
client; `anon` reaches no table (Q-8). Session tokens are held by the Supabase client with
`persistSession` and `autoRefreshToken`. Error surfaces must map database errors to safe messages
rather than echoing raw Postgres text (see M-4).

---

## 5. Public packages finding and recommended resolution

### 5.1 Reconfirmation `VERIFIED AGAINST LIVE DATABASE`

Read-only, non-mutating: `GET /rest/v1/packages` with the publishable key returned
**HTTP 200 and 5 rows** (`content-range: 0-4/*`). No write was attempted; the row count is
unchanged from the earlier audit. This reconfirms C-1.

### 5.2 Is the catalogue intended to be public?

**APPROVED OWNER DECISION (Revision 2): `public.packages` must be readable by `authenticated`
users only. Anonymous access is prohibited.**

This resolves the earlier contradiction in favour of the migration's own policy
(`packages_select_authenticated`) and test T-08. The evidence previously pointed both ways:

- **Suggests public by design:** the catalogue is marketing content; the live anon read works; the
  earlier report characterises it as non-confidential; the products are consumer bundles.
- **Suggests private by design:** the migration's own policy `packages_select_authenticated`
  grants reads to `authenticated` only, and a test (T-08) asserts anon reads are rejected. So the
  author's *intent* was authenticated-only.

The owner has now chosen **authenticated-only**. Consequences recorded for Chapter 3:

- The pre-login marketing page can no longer read the catalogue through the `anon` key. Any
  marketing surface that needs bundle data must fetch it after authentication, or through a
  separate owner-approved, column-limited public endpoint (a new decision, not covered here).
- The intended end state **matches the migration as written**, so no additional policy work is
  required — the fix for C-1 is simply to apply the existing migration.
- **Status: APPROVED — NOT IMPLEMENTED.** Production is unchanged and anonymous reads still
  succeed today (see §5.1). Applying it needs the owner-level connection (Q-6) and a backup
  confirmation (Q-5).

### 5.3 Security impact, and why package data differs from customer data

- **Public package information** (title, price, validity, data allowance) is non-sensitive. Anon
  read is a *confidentiality* concern of low severity and mainly a business/relevance question.
- **Private customer/retailer data** (`profiles`: identity, `msisdn`, `role`, `is_active`) is
  sensitive. Anon reads there are correctly blocked today (`[]`).
- **Writes are already blocked** for anon (HTTP 401), so there is no integrity exposure today.

The distinction matters: C-1 is not the same class of risk as exposing customer rows. It should
not be ranked Critical on confidentiality grounds alone.

### 5.4 Options and trade-offs

| Option | Change | Trade-off |
|---|---|---|
| A — keep authenticated-only **SELECTED** | Apply the migration as written | Catalogue hidden from the pre-login marketing page |
| B — make it intentionally public | A `for select using (is_enabled)` policy for `anon`, restrict columns via a view | Simplest UX; needs a column-limiting view to avoid future leaks |
| C — public via a read-only view/API | Expose only safe columns (`title`, `price_pkr`, `validity_days`, …) | Cleanest separation; a small amount of extra schema work |

**Decision:** the owner selected **Option A — authenticated-only**. Anonymous access to
`public.packages` is prohibited. Options B and C are rejected; a column-limited public surface
would require a new, separate owner decision if one is ever needed.

### 5.5 Status

**DECISION APPROVED; IMPLEMENTATION PENDING.** No policy was changed and no production data was
touched in this revision — the live anonymous read still succeeds (see §5.1). Because the
approved end state equals the drafted migration, the fix is to apply it in Chapter 3 once Q-5 and
Q-6 are resolved. Risk C-1 therefore stays **open until the migration is applied**, and test T-17
stays **FAILING** until then.

---

## 6. Security test matrix — actual recorded results

Legend: **Ran/Pass** = executed this session with the recorded result · **Ran/FAIL** = executed
and failed · **Not run** = blocked, not claimed as passing.

| ID | Case | Exists | Status | Evidence |
|---|---|---|---|---|
| T-01 | Migration idempotent, legacy state cleaned | Yes | Ran/Pass | `auth-rls.test.mjs` 54/54 |
| T-02 | Signup provisions `CUSTOMER` | Yes | Ran/Pass | ditto |
| T-03 | Customer cannot self-promote | Yes | Ran/Pass | ditto |
| T-04 | Customer cannot change `is_active`/`email` | Yes | Ran/Pass | ditto |
| T-05 | Customer can update own `full_name`/`msisdn` | Yes | Ran/Pass | ditto |
| T-06 | Customer cannot read another profile | Yes | Ran/Pass | ditto |
| T-07 | Anon cannot read `profiles` | Yes | Ran/Pass | ditto + live `[]` |
| T-08 | Anon cannot read `packages` | Yes | Ran/Pass | in-migration harness |
| T-09 | Customer cannot write `packages` | Yes | Ran/Pass | ditto |
| T-10 | Retailer reads all profiles/packages | Yes | Ran/Pass | ditto |
| T-11 | Retailer can write `packages` | Yes | Ran/Pass | ditto |
| T-12 | Helpers not executable by `PUBLIC`/`anon` | Yes | Ran/Pass | ditto |
| T-13 | Invalid role rejected | Yes | Ran/Pass | ditto |
| T-14 | Existing data preserved | Yes | Ran/Pass | ditto |
| T-15 | Client validation/role gating/sign-out | Yes | Ran/Pass | `auth-ui.test.mjs` 32/32 |
| T-16 | Demo OTP/PIN/role selection absent | Yes | Ran/Pass | `security-static.test.mjs` 36/36 |
| T-17 | **Live** anon read `packages` rejected | No | **Ran/FAIL** | Live HTTP 200, 5 rows (C-1) |
| T-18 | Live anon write `packages` rejected | No | Ran/Pass | Live 401 `42501` |
| T-19 | Live anon read `profiles` empty | No | Ran/Pass | Live `[]` |
| T-20 | Unregistered phone OTP refused | No | **Not run** | No endpoint exists |
| T-21 | Registered phone OTP dispatched | No | **Not run** | No endpoint exists |
| T-22 | Wrong code rejected | No | **Not run** | No endpoint exists |
| T-23 | Expired OTP rejected | No | **Not run** | No endpoint exists |
| T-24 | Replay rejected | No | **Not run** | No endpoint exists |
| T-25 | Attempt limit enforced | No | **Not run** | No endpoint exists |
| T-26 | Request rate limit → 429 | No | **Not run** | No endpoint exists |
| T-27 | Concurrent verify → one success | No | **Not run** | No endpoint exists |
| T-28 | Provider failure handled cleanly | No | **Not run** | No endpoint exists |
| T-29 | No OTP/key/PII leak in errors/logs | No | **Not run** | No endpoint exists |
| T-30 | Duplicate bundle create safe | No | **Not run** | No uniqueness constraint |
| T-31 | Post-apply column/grant audit | No | **Not run** | No DB credential |

### Blocker classification

- **Design blocker:** T-17 (C-1) and T-31 — both are about the unhardened live database.
- **Implementation tests (Chapter 3, not design blockers):** T-20 … T-30 — they require the OTP
  work and the migration to exist first.
- **Passing but conditional:** T-01 … T-16 pass in the harness; T-08 in particular asserts anon
  reads are rejected, which is *false live* until the migration is applied (see T-17).

### Evidence needed to close each remaining test

| Test(s) | Required evidence |
|---|---|
| T-17 | Owner decision on public/private, then a live re-probe after the policy change |
| T-18, T-19 | Re-probe after migration (currently passing) |
| T-20–T-29 | Implemented OTP endpoints + phone provider enabled + provider test credentials |
| T-30 | A uniqueness constraint plus a concurrency test |
| T-31 | An owner-level DB connection to run the post-apply catalogue audit |

### Suites actually executed this session

| Command | Environment | Result |
|---|---|---|
| `npm test` (feat branch) | `2a433cf` | **54 + 36 + 32 = 122 passed, 0 failed** |
| `npm test` (main, isolated worktree) | `47bbc4b` | **6 + 50 + 17 + 16 + 16 = 105 passed, 0 failed** |
| `npm run test:live` (main) | live GitHub Pages | **16 passed, 0 failed** |

No destructive test was run against production.

---

## 7. Migration compatibility and data-preservation plan

### 7.1 Dependencies and risks `VERIFIED FROM SOURCE`

The single migration `supabase/migrations/20261017120000_auth_profiles_rls.sql` is additive except
for two intentional state changes:

| Section | Operation | Type |
|---|---|---|
| 0 | Guard rails (`public`, `auth` must exist) | Additive |
| 1 / 1b | Create/add columns; normalise legacy roles | Additive + one `UPDATE` |
| 2 / 3 / 5 | Triggers and `SECURITY DEFINER` helpers | Additive |
| 4 | Backfill profiles for pre-trigger users | Additive (`on conflict do nothing`) |
| **6** | **Drop every policy on `profiles`/`packages`, create 4** | **Drops policies (by design)** |
| **7** | **`revoke all` then least-privilege grants** | **Changes grants (by design)** |
| 8 | Verify-then-promote the admin | Additive + `on conflict do update` |
| 9 | Final policy assertion | Assertion only |

### 7.2 Why the branch cannot be merged into `main` as-is

Re-confirmed with `git merge-tree origin/main origin/feat/supabase-auth-rls`:
conflicts in `.gitignore`, `index.html`, `package-lock.json`, `package.json`,
`tests/security-static.test.mjs`. Critically, `sw.js` is **absent** on the feat branch, and its
`index.html` has **no** `sanitizeState` and **no** SRI `integrity=`. A naive merge would delete the
service worker, drop the untrusted-state validation, and un-pin the CDN script — i.e. revert
Chapter 1. `VERIFIED FROM SOURCE`. This is C-2.

### 7.3 Future safe migration sequence (not executed)

1. Rebase or forward-port Chapter 1 (`main` @ `47bbc4b`) into the auth line, resolving the five
   files deliberately; confirm `sw.js`, `sanitizeState` and the SRI pin survive.
2. Resolve Q-1, Q-5, Q-6 (admin id, backups, owner connection).
3. Apply to a **staging** project first; run the feat RLS suite against the applied result.
4. Snapshot production, then apply to production.
5. Re-run the four inline post-conditions and the section 9 assertion; record the output.
6. Re-run the client `profiles` query (the `is_active` dependency, H-3).
7. Decide and implement the public-packages policy (C-1).
8. Implement OTP (Chapter 3), then extend the matrix to T-20 … T-30.

### 7.4 Backup, recovery and pre/post checks

- **Backup/PITR:** `OWNER DECISION REQUIRED` (Q-5). There is **no down-migration**, so recovery
  from a bad apply depends on a Supabase snapshot or PITR. `VERIFIED FROM SOURCE`.
- **Pre-checks:** admin id present in `auth.users` (or `expresso.retailer_admin_id` set);
  no `packages.created_by` other than the admin (passes live); owner-level connection available.
- **Post-checks:** inline assertions in sections 5, 7 and 9; live re-probe of `packages`/`profiles`.
- **Data preservation:** 5 `packages` rows and existing `profiles` rows survive — no `DELETE`,
  `TRUNCATE`, or `DROP TABLE` anywhere in the migration. `VERIFIED FROM SOURCE`.

### 7.5 Migration safety design principles (design)

| Principle | How the migration satisfies it |
|---|---|
| Additive by default | `create table if not exists`, `add column if not exists` |
| Idempotent | Re-running is a no-op for schema; policies and grants are re-created deterministically |
| Self-verifying | Inline `raise exception` post-conditions (sections 5, 7, 9) abort on failure |
| Atomic | Single `begin; … commit;`; any `raise exception` rolls the whole file back |
| Non-destructive to data | No `DELETE` / `TRUNCATE` / `DROP TABLE` |
| Fails safe on identity | Admin promotion aborts if the account is unverifiable |
| Reversible-in-plan | No down-migration; recovery is by snapshot/PITR (Q-5) |

Known limitations to carry into Chapter 3: sections 6 and 7 intentionally replace unknown live
policy/grant state (M-1); section 1 rewrites unexpected role values to `CUSTOMER` (M-2); and the
empty-catalogue branch uses `raise warning` and continues rather than aborting.

---

## 8. Owner decisions still required

| # | Question | Repo evidence answers it? | Status | Consequence if unresolved |
|---|---|---|---|---|
| Q-1 | Is `bdd8f73c-…` a live `auth.users` account? | Partly: it authored all 5 packages `LIVE`; `auth.users` is `N/V` | **OWNER DECISION REQUIRED** | Migration aborts (fails safe) rather than promoting a wrong id |
| Q-2 | Enable phone/SMS auth? Which provider? | No. Live shows `external.phone:false`, `sms_provider:twilio` | **OWNER DECISION REQUIRED** | OTP cannot be built or tested; T-20…T-29 stay blocked |
| Q-3 | Is WhatsApp required? | No. Docs: WhatsApp only via Twilio/Twilio Verify | **OWNER DECISION REQUIRED** | Determines whether the Send SMS Hook is needed |
| Q-4 | Which MSISDNs are eligible, and where does the list live? | No | **OWNER DECISION REQUIRED** | Eligibility gating cannot be implemented |
| Q-5 | Are backups/PITR enabled? | No | **OWNER DECISION REQUIRED** | No rollback path if the migration goes wrong |
| Q-6 | Owner-level DB connection available to apply the migration? | No | **OWNER DECISION REQUIRED** | Migration cannot be applied; C-1/H-3 persist |
| Q-7 | Migration before or after the Chapter 1 frontend? | Partly: H-3 shows the client needs `is_active` | **OWNER DECISION REQUIRED** | Wrong order leaves the client falling back to `CUSTOMER` |
| Q-8 | Public or authenticated-only catalogue? | **Resolved in Revision 2** — see §5.2 | **APPROVED (not implemented)** | None; C-1 closes when the migration is applied |

**Decision recorded:** Q-8 — *`public.packages` is readable by `authenticated` users only;
anonymous access is prohibited.* Approved by the owner, **not yet implemented** (Chapter 3).

**Still open: Q-1, Q-2, Q-3, Q-4, Q-5, Q-6, Q-7** (seven decisions).

### Minimum access needed, and how to grant it safely

- **To apply the migration:** an owner/postgres connection able to create a trigger on
  `auth.users` and to `revoke`/`grant` on `public`. The safe way is the Supabase SQL editor while
  signed in as the project owner, or a short-lived connection string the owner keeps out of the
  repository. Do not paste a service-role key or database password into chat or a commit.
- **To verify the admin id:** the owner can read `select id from auth.users where id = 'bdd8f73c-…'`
  in the SQL editor and report only whether a row exists (no other columns).
- **To enable phone OTP:** the owner configures Auth → Providers → Phone and the SMS provider in
  the dashboard. Provider credentials go into the dashboard, never into the repository.

---

## 9. Risk register

### Critical
- **C-1 — Live `packages` is anonymously readable (5 rows).** Reconfirmed. The owner has now
  approved authenticated-only access (Q-8), but the fixing migration is **not applied**, so the
  exposure is still live today. Confidentiality impact is bounded (marketing data; writes already
  blocked). Closes when the migration is applied. `LIVE`
- **C-2 — Merging the feat branch into `main` would revert Chapter 1 and break the PWA.**
  Reconfirmed via `git merge-tree`; `sw.js` absent, no `sanitizeState`, no SRI. `SRC`

### High
- **H-1 — No OTP implementation exists.** `SRC`
- **H-2 — Phone auth disabled live.** `LIVE`
- **H-3 — Client queries `profiles.is_active`, which does not exist live yet.** Ordering
  dependency: migration before client deploy. `LIVE`

### Medium
- **M-1 — Sections 6/7 change unknown live policy/grant state.** Snapshot required. `SRC`
- **M-2 — Section 1 rewrites unexpected role values to `CUSTOMER`.** `SRC`
- **M-3 — No uniqueness constraint / concurrency test for bundle creation** (T-30). `SRC`
- **M-4 — Raw Postgres error text surfaced via `alert(error.message)`.** `SRC`
- **M-5 — `created_by` supplied by the client** (RLS mitigates). `SRC`

### Low
- **L-1 — `packages.title` nullable on the existing table** (schema drift). `SRC`
- **L-2 — No down-migration.** `SRC`
- **L-3 — `signOut()` swallows errors.** `SRC`
- **L-4 — No `emailRedirectTo` on sign-up.** `SRC`

---

## 10. Chapter 2 acceptance checklist

| Criterion | Status |
|---|---|
| Repository fully inventoried; all branches and SQL located | **Done** |
| Live facts separated from migration-derived assumptions | **Done** |
| Migration compatibility assessed section by section | **Done** |
| Data-preservation and rollback requirements documented | **Done** |
| Permission matrix finalised with evidence labels | **Done** |
| OTP options compared; one recommended with contracts | **Done** |
| Test matrix reported with honest run status | **Done** |
| C-1 (public packages) reconfirmed and scoped | **Done** |
| C-2 (merge regression) reconfirmed | **Done** |
| Owner decision register produced | **Done** |
| Design documented: phone OTP, eligibility, authorization, RLS, API access, migration safety | **Done (design)** |
| Q-8 packages access rule decided | **Approved — not implemented** |
| Admin-account existence verified in `auth.users` | **Not verified — Q-1** |
| Live policy/grant/function catalogue inspected | **Not verified — no DB credential** |
| OTP implemented | **Not implemented — Chapter 3** |
| Migration applied to production | **Not applied — out of scope** |

**Chapter 2 status: PARTIAL PASS (design complete).**

All Chapter 2 **design** work is complete, including the one approved decision (Q-8). The chapter
is not PASS because implementation and live verification are explicitly out of scope here:

(a) C-2 must be resolved before any auth merge; (b) C-1 is still an open live exposure until the
approved policy is applied; (c) seven owner decisions (Q-1–Q-7) remain open; (d) no live
database credential was available for catalogue-level verification; and (e) the OTP design,
eligibility checks and API contracts are documented but **not implemented**, so every OTP test
(T-20…T-29) is still **NOT RUN**.

A committed report is not proof that the backend is secure. No live security test is claimed to
have passed. The live database remains unhardened.

---

## 11. Recommended next actions for Chapter 3 (not executed)

1. Reconcile branches: forward-port Chapter 1 into the auth line; preserve `sw.js`,
   `sanitizeState`, SRI. Never merge the feat branch as-is (C-2).
2. Obtain owner answers to Q-1 … Q-7 and an owner-level connection.
3. Apply the migration to staging, then production with a snapshot; record post-conditions.
4. C-1 is decided (Q-8: authenticated-only). Applying the migration in step 3 enforces it, which
   closes C-1 and turns T-17 from FAIL to pass. No extra policy work is required.
5. Enable the chosen OTP channel (Q-2/Q-3) and implement Option A with a Before User Created
   eligibility hook; add a `msisdn` uniqueness constraint.
6. Add the OTP request/verify contracts and replace raw `alert(error.message)` with safe mapping.
7. Extend the matrix to T-20 … T-31, including replay, concurrency and rate-limit cases.
8. Harden `created_by` to `default auth.uid()` with a matching `with check`.

---

## References (external documentation, `VERIFIED FROM SOURCE`)

- Supabase Phone sign-in — https://supabase.com/docs/guides/auth/phone-login
- Supabase Rate limits — https://supabase.com/docs/guides/auth/rate-limits
- Supabase Send SMS Hook — https://supabase.com/docs/guides/auth/auth-hooks/send-sms-hook
- Supabase Before User Created Hook — https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook

---

*This report changed documentation only. No application code, migration, policy, or production
record was modified. `main` was not merged or modified by this work.*
