# Chapter 3 — Supabase Foundation Release Acceptance

Status: **not release-ready**. This is a test plan, not a claim that tests passed. Production data must remain untouched during validation.

## Hard safety gates

- [ ] Work remains on `chapter-3/supabase-foundation`; do not merge or edit `main`.
- [ ] No SQL is applied to production as a substitute for an isolated test database.
- [ ] Capture schema, migration history, table/column grants, RLS policies, functions, triggers, and row counts before testing.
- [ ] Test on a disposable project/database with synthetic data only.
- [ ] Stop if existing roles, policies, constraints, profile rows or authorized admin identity would be altered unexpectedly.
- [ ] Apply one migration at a time; run postflight and regression tests before continuing.
- [ ] Verify rollback/restore procedure before any production promotion.

## SQL authorization matrix

| Surface | anon | authenticated customer | retailer admin |
|---|---|---|---|
| profiles | no access | own profile only; protected role/id fields immutable | only explicitly approved admin scope |
| packages | no access unless catalogue is deliberately public | enabled catalogue read only | manage only through server-authorized workflow |
| bundle_allocations | no access | own allocations read only | permitted retailer workflow; no unrestricted customer data |
| private.otp_challenges | no access | no direct access | no direct access; service role only |
| private.retailer_allowlist | no access | no direct access | no direct access; server-side management only |
| private.otp_monthly_usage | no access | no direct access | no direct access; server-side reservation only |

This is the target, not a claim about current grants. RLS does not protect against TRUNCATE; verify SQL privileges as well as policies.

## OTP monthly budget and abuse controls

Production database inspection on 2026-10-19 found `private.reserve_monthly_otp_sms(text)` with a 300-per-UTC-month customer-login reservation cap and a separate 50-per-month retailer-login cap. This is not yet integrated into a live OTP endpoint.

Required tests in an isolated database:
1. Customer reservation calls 1–300 return allowed; call 301 returns denied.
2. Retailer reservation calls 1–50 return allowed; call 51 returns denied.
3. Concurrent reservations cannot exceed the hard cap.
4. Month boundary uses UTC consistently and starts a fresh bucket.
5. Invalid purpose is rejected.
6. Budget reservation is called at the correct point in the send flow; provider timeouts/rejections have documented accounting and retry behavior.
7. Cooldown, per-phone limits, IP/device abuse limits, and generic responses for ineligible numbers are enforced server-side.
8. Existing valid sessions are reused; opening the app does not trigger OTP every time.

## Required positive tests

1. Eligible customer can request an OTP through the server endpoint and verify it before expiry.
2. Authorized retailer can authenticate only through server-side allowlist eligibility.
3. Customer can read only their own profile and bundle allocations.
4. Enabled package catalogue is returned only to the intended audience.
5. Approved allocation workflow records correct customer and immutable price/package snapshots.
6. A valid OTP creates a normal Supabase Auth session using a supported Auth flow.

## Required negative tests

1. Unknown/ineligible phone receives a generic rejection and no SMS/OTP challenge is issued.
2. Direct Supabase Auth OTP/signup path cannot bypass eligibility controls.
3. Wrong OTP increments attempts; fifth failed attempt locks the challenge.
4. Expired, consumed, replayed and concurrently redeemed OTPs fail.
5. Client-supplied role, profile ID, price, package snapshot or customer ID cannot elevate privileges or forge allocation data.
6. Customer A cannot read or mutate customer B's profile or allocations.
7. anon/authenticated cannot INSERT/UPDATE/DELETE/TRUNCATE protected tables unless explicitly required.
8. Non-admin cannot invoke privileged RPCs or change roles/allowlists.
9. Allocation identity/financial snapshots cannot be rewritten or deleted; only documented usage/status fields can change.
10. XSS payloads, malformed MSISDNs, rate-limit abuse and duplicate OTP requests are rejected safely.
11. Send SMS hook rejects invalid signatures, malformed event payloads, missing configuration and provider failures without logging OTPs, phone numbers, API keys, or raw provider responses.
12. Only a provider-confirmed send counts as delivered; retry logic does not create uncontrolled duplicate SMS sends.

## Current verified blockers (2026-10-19)

- Supabase development branches are unavailable on the current plan (API returned PaymentRequiredException: Pro plan or above).
- Live migration history: `20261017101359 / harden_auth_helpers_and_add_fk_indexes`, `20261019180912 / otp_private_foundation`, `20261019181449 / customer_otp_monthly_cap`.
- No Edge Functions are deployed.
- SendPK account exists, but purchase/activation form, approved OTP template, API credentials and Supabase Auth Send SMS Hook secret/configuration are still pending.
- Existing production schema has no `profiles.is_active` column; migration drafts must not assume it exists.
- Security advisor reports `public.is_retailer_admin()` executable by authenticated users, leaked-password protection disabled, and private OTP tables with RLS/no policies (expected only if direct client access stays revoked).
- Broad client grants including TRUNCATE remain on existing public tables. Must reconcile and test a least-privilege fix on an isolated database.
- Existing profile/admin identity and customer data must be preserved.
- Files under `supabase/review/` are candidates only, not applied migrations. Do not apply the duplicate branch OTP foundation file again.

## Definition of done

Chapter 3 is not complete until the migration source and live history are reconciled, schema/grants/policies are safely hardened and tested in isolation, the OTP/session flow is integrated, the monthly cap and rate limits pass tests, controlled SMS delivery and login succeed, advisors are rechecked, and a human explicitly approves any production promotion.
