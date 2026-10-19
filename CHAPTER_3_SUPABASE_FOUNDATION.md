# Expresso Chapter 3 — Supabase Foundation

Status: in progress. This branch is isolated from main.

## Verified baseline (2026-10-19)
- public.profiles: 2 rows; role check permits CUSTOMER and RETAILER_ADMIN.
- public.packages: 5 rows; is_enabled column exists.
- public.bundle_allocations: 0 rows; table and foreign keys exist.
- Supabase migration history contains 20261017101359 / harden_auth_helpers_and_add_fk_indexes.
- No deployed Edge Functions were listed during audit.
- Live schema and permissions were inspected. No production migration was applied.

## Work in this branch
- 001_client_privilege_hardening_candidate.sql is a review candidate, NOT a production-ready approved migration.
- tests/chapter3_privilege_postflight.sql contains read-only postflight queries.

## Required before production
1. Run candidate only against an isolated disposable database with matching schema.
2. Verify all assertions and compare before/after row counts and policies.
3. Add regression tests for customer self-access and retailer-admin access.
4. Design immutable allocation history while allowing only explicitly permitted status/usage updates.
5. Finalize server-side retailer allowlist and admin promotion without hardcoded user UUIDs.
6. Finalize OTP backend (eligibility, HMAC/hash storage, TTL, attempt limits, replay protection, rate limits, SMS adapter).
7. Reconcile migration source files with live migration history.
8. Re-run Supabase security advisor and tests before opening a pull request.

Do not merge to main or apply to production before isolated verification and review.
