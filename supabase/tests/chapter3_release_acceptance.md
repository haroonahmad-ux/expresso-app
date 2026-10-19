# Chapter 3 — Supabase Foundation Release Acceptance

Status: test plan added; live execution is **blocked** until a disposable database is available. Nothing in this file asserts that tests passed.

## Hard safety gates
- [ ] Work remains on `chapter-3/supabase-foundation`; do not merge or edit `main`.
- [ ] No SQL is applied to production as a substitute for an isolated test database.
- [ ] Capture schema, migration history, table grants, RLS policies and auth trigger definitions before testing.
- [ ] Test on a disposable project/database with synthetic data only.
- [ ] Run the preflight checks; stop if existing roles, policies, constraints, profile rows or authorized admin identity would be altered unexpectedly.
- [ ] Apply one migration at a time; run its postflight and regression tests before continuing.
- [ ] Verify rollback or restore procedure before any production promotion.

## SQL authorization matrix
| Surface | anon | authenticated customer | retailer admin |
|---|---|---|---|
| profiles | no row access | select own profile only | only explicitly approved admin scope |
| packages | no access unless product explicitly chooses public catalogue | select enabled packages | manage packages only via server-authorized policy |
| bundle_allocations | no access | select own allocations only | permitted retailer workflow only; never unrestricted customer data |
| private.otp_challenges | no access | no direct access | no direct access; service role only |
| private.retailer_allowlist | no access | no access | no direct client access; service role only |

The matrix is a target, not a claim about current grants. Verify SQL privileges as well as RLS; RLS does not protect against TRUNCATE.

## Required positive tests
1. Eligible customer can request an OTP through the server endpoint and verify it before expiry.
2. Authorized retailer can authenticate only through server-side allowlist eligibility.
3. Customer can read only their own profile and bundle allocations.
4. Enabled package catalogue is returned only to the intended audience.
5. Approved allocation workflow records the correct customer and immutable price/package snapshots.

## Required negative tests
1. Unknown/ineligible phone receives a generic rejection and no SMS/OTP challenge is issued.
2. Direct Supabase Auth OTP/signup path cannot bypass the eligibility gate.
3. Wrong OTP increments attempts; the fifth failed attempt locks the challenge.
4. Expired, consumed, replayed and concurrently redeemed OTPs fail.
5. Client-supplied role, profile ID, price, package snapshot or customer ID cannot elevate privileges or forge allocation data.
6. Customer A cannot read or mutate customer B's profile or allocations.
7. anon/authenticated cannot INSERT/UPDATE/DELETE/TRUNCATE protected tables unless explicitly required.
8. Non-admin cannot invoke privileged RPCs or change roles/allowlists.
9. Allocation identity/financial snapshots cannot be rewritten or deleted; only documented usage/status fields can change.
10. XSS payloads, malformed MSISDNs, rate-limit abuse and duplicate OTP requests are rejected safely.

## Release blockers known at audit time
- Supabase development branches are unavailable on the current plan (API returned PaymentRequiredException: Pro plan or above).
- No Edge Functions were deployed at the last inspection.
- No SMS provider was configured.
- Existing production schema has no `profiles.is_active` column; drafts must not assume it exists.
- Existing migration history contains only `20261017101359 / harden_auth_helpers_and_add_fk_indexes`.
- Existing profile and package data/admin identity must be preserved.
- The SQL files under `supabase/review/` are candidates only, not applied migrations.

## Definition of done
Chapter 3 is not complete until the schema and deployed functions are implemented, the tests above execute successfully in an isolated environment, migration history and security advisors are rechecked, and a human explicitly approves any production promotion.
