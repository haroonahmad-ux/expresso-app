# Expresso Chapter 4 — Authentication & Dashboards

Status: **preparation in progress; live secure integration unverified**.
This work is on `chapter-3/supabase-foundation` because a separate Chapter 4 database branch is unavailable on the current Supabase plan. Do not merge to `main` or change production Auth settings as part of preparation.

## Scope

Chapter 4 covers:
1. Supported authentication and persistent session lifecycle.
2. Server-trusted profile and role loading.
3. Customer dashboard data and customer-only navigation.
4. Retailer-admin dashboard and server-enforced admin authorization.
5. Loading, signed-out, expired-session, network-error, and permission-denied states.
6. Logout, refresh, cross-account cleanup, and mobile PWA behavior.
7. Automated acceptance tests and release evidence.

Real OTP/SMS delivery and controlled phone verification are intentionally deferred until the user completes SendPK activation and the next controlled test window. Do not mark authentication end-to-end complete before then.

## Verified baseline

- The PWA is a single-file vanilla HTML/CSS/JS app in `index.html`; Supabase JS v2 is used in the frontend.
- Existing UI currently implements email/password sign-up and sign-in. It is not yet the requested verified phone-OTP login flow.
- The current `loadProfile()` query selects `id, role, full_name, msisdn, is_active`, but the verified production `public.profiles` schema does **not** contain `is_active`. That query therefore needs correction before real dashboard authorization can be trusted.
- When profile loading fails, the current UI creates a client-side fallback profile with role `CUSTOMER`. This is fail-low for admin UI visibility, but it hides schema/query errors; Chapter 4 should show a safe unavailable state rather than pretending the profile was successfully loaded.
- `public.profiles` has two rows, `public.packages` has five rows, and `public.bundle_allocations` is empty at the last verified inspection. Preserve all existing data.
- Current production grants and RLS policies still need isolated review. A hidden admin button is never a security boundary.
- No Edge Functions are deployed; SendPK and Supabase Auth hooks are not configured. Do not pretend OTP login works yet.

## Authentication decisions

### Target

Use Supabase Auth's supported session lifecycle and use the verified Auth user ID to load the profile. The frontend must not mint JWTs, assign roles, trust client metadata for admin status, or use localStorage as an authorization source.

Phone OTP delivery should use Supabase Auth's native OTP/session flow with the SendPK delivery hook, once the account/template/configuration are ready and the eligibility gate is implemented and tested. Avoid a parallel custom JWT flow.

### Session lifecycle

- On initial app load, call the Supabase Auth session API and wait for resolution before rendering protected dashboard data.
- Subscribe to Auth state changes; reload the profile when the user changes.
- Reuse a valid persisted session; do not request OTP every app launch.
- On sign-out, clear in-memory profile, role-derived menus, private data and cached customer-specific state before rendering signed-out UI.
- If profile loading fails, do not assume a successful profile or silently grant privileged features.
- Handle expired sessions and network errors without wiping unrelated non-sensitive preferences.
- Never log access/refresh tokens, OTPs, API keys or full phone numbers.

## Role and dashboard rules

- The profile's database `role` is authoritative for presentation, but database policies and server-side authorization must independently enforce all permissions.
- CUSTOMER: enabled package catalogue, own profile, own bundle allocations and customer-safe activity only.
- RETAILER_ADMIN: retailer tools only after the trusted profile is loaded and the server confirms authorization; actions still require database/RPC authorization.
- Never accept a role from form fields, URL parameters, localStorage, user metadata, or a client-supplied profile ID.
- On unknown role, missing profile, or authorization error, fail closed and show a recoverable error state.
- Admin-only data/actions must not be fetched before the role check.

## Data access rules

- Query profile by the signed-in Auth user's ID.
- Query only columns verified to exist in the live schema; do not select `is_active` until an approved migration adds and verifies it.
- Query packages using explicit selected columns and the intended enabled-catalogue policy.
- Query allocations filtered by the signed-in user; RLS must independently enforce ownership.
- Do not expose other customers' allocations to retailer UI unless the specific admin workflow is explicitly approved and covered by tests.
- Avoid rendering untrusted database text as raw HTML; use text nodes or the existing HTML-escaping helper.

## Safe implementation sequence

1. Correct the profile query/schema mismatch and make profile-load failure visible, without changing database data.
2. Extract/test pure client helpers where practical: MSISDN normalization, role routing, safe error mapping and sign-out cleanup.
3. Add explicit auth states: `initializing`, `signed_out`, `loading_profile`, `customer`, `retailer_admin`, `profile_unavailable`.
4. Wire session restoration and Auth state-change handling; avoid duplicate hydration and race conditions.
5. Add server/RLS-backed customer dashboard reads and role-gated retailer dashboard reads.
6. Implement final OTP UI only against the supported Supabase Auth flow after eligibility and provider configuration are ready.
7. Run the Chapter 4 acceptance checklist, then perform the controlled OTP/SMS test when the user is available.
8. Re-check Chapter 3 release gates before calling the combined auth stack production-ready.

## Do not do during preparation

- Do not send real SMS, change Auth provider settings, or configure production hooks without the provider setup being ready.
- Do not apply the risky existing auth/profile migration.
- Do not alter existing profile rows, role constraints, or retailer-admin identity.
- Do not claim that the dashboards or login are production-secure solely because UI controls render.
