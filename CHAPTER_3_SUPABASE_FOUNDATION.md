# Expresso Chapter 3 — Supabase Foundation

Status: **in progress / not release-ready**. All source changes remain on `chapter-3/supabase-foundation`; do not merge to `main` without isolated tests and explicit release approval.

## Live production state verified 2026-10-19

- `public.profiles`: 2 rows; `id`, `full_name`, `msisdn`, `role`, `created_at`; roles constrained to `CUSTOMER` / `RETAILER_ADMIN`. Do not assume `is_active` exists.
- `public.packages`: 5 rows; `is_enabled` exists.
- `public.bundle_allocations`: 0 rows; existing table and foreign keys preserved.
- Migration history: `20261017101359 / harden_auth_helpers_and_add_fk_indexes`, `20261019180912 / otp_private_foundation`, `20261019181449 / customer_otp_monthly_cap`.
- Private OTP tables exist: `private.otp_challenges`, `private.otp_rate_limits`, `private.retailer_allowlist`, `private.otp_monthly_usage`. These tables were empty at inspection.
- `private.consume_otp_challenge(uuid,text,text,text)` and `private.reserve_monthly_otp_sms(text)` exist. The monthly reservation function has a customer cap of 300 per UTC month and a separate retailer-login cap of 50. The cap is a database reservation counter, not proof that an SMS was delivered. Integration must reserve only immediately before a send attempt and define how failed provider deliveries are accounted for.
- No Supabase Edge Functions are deployed.
- The SMS hook code is committed on this branch only. SendPK credentials/template and the Supabase Auth Send SMS Hook are not configured, so no live OTP delivery or login has been tested.
- Development database branching is unavailable on the current Supabase plan (API returned PaymentRequiredException: Pro plan or above). Do not use production as a substitute for isolated migration tests.

## Confirmed production security findings (read-only inspection)

- `public.is_retailer_admin()` is SECURITY DEFINER and executable by `authenticated`; review its exposure and replace direct client invocation with a tightly scoped policy helper design before release.
- Supabase security advisor reports leaked-password protection disabled.
- Broad table grants remain on `public.packages` and `public.bundle_allocations`, including client INSERT/UPDATE/DELETE/TRUNCATE privileges; RLS is not a defence against TRUNCATE. The existing policy set also includes permissive overlapping policies.
- Private OTP tables have RLS enabled with no policies; this is expected only while direct client access is revoked. Keep them server-only and verify schema usage/table grants in regression tests.
- Existing profile/admin identity and customer data must be preserved. Do not apply `20261017120000_auth_profiles_rls.sql` blindly: it assumes schema details not present in production and includes a hardcoded admin UUID assumption.

## Work on this branch

- `supabase/review/001_client_privilege_hardening_candidate.sql`: review candidate only; not production-approved.
- `supabase/tests/chapter3_privilege_postflight.sql`: read-only postflight checks.
- `supabase/tests/chapter3_release_acceptance.md`: release gate and authorization matrix.
- `supabase/functions/request-otp/index.ts` and `verify-otp/index.ts`: intentionally fail closed; incomplete drafts, do not deploy as working login endpoints.
- `supabase/functions/send-sms-hook/index.ts`: SendPK delivery adapter draft. Needs validation against actual approved SendPK template/API response and signed hook configuration before deployment.
- `docs/otp-sendpk-setup.md`: provider setup and safety checklist.
- Review migrations are not applied unless explicitly listed in the live migration history above. Do not apply the duplicate branch OTP foundation file: the equivalent foundation is already applied under the live migration version `20261019180912`.

## Remaining release blockers

1. Create a reproducible migration source for the already-applied monthly-cap migration and reconcile its name/content with live history; do not reapply it.
2. Verify all production client grants, policies, functions and triggers in a disposable matching database before selecting a least-privilege migration.
3. Add automated regression tests for customer self-access, cross-customer denial, retailer-admin scope, role escalation denial, and no client TRUNCATE.
4. Design allocation history and protect financial/package snapshots while permitting only documented usage/status updates.
5. Verify authorized retailer-admin identity and seed `private.retailer_allowlist` through a secure server-side operation; never hardcode the account UUID.
6. Complete the OTP flow using Supabase Auth's supported session lifecycle, eligibility gating, SendPK hook, signature validation, monthly budget enforcement, cooldowns, and provider error handling.
7. Configure Auth hooks/secrets only after the SendPK account and approved OTP template are ready; never put secrets in GitHub or chat.
8. Enable leaked-password protection in Supabase Auth settings when appropriate for the chosen authentication configuration.
9. Run the full release test suite in an isolated environment, re-run advisors, and obtain explicit human approval before production promotion.

## Safety rules

- Never merge to `main` or promote to production without isolated verification and explicit approval.
- Never disable or replace production auth triggers, policies, role constraints, or existing admin access as a shortcut.
- Never claim SMS delivery or end-to-end authentication is verified until a controlled test succeeds and a normal Supabase Auth session is confirmed.
