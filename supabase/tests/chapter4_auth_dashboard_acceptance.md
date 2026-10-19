# Chapter 4 — Authentication & Dashboards Acceptance Tests

Status: checklist prepared; not yet executed end-to-end. Run UI-only tests now where safe; defer real OTP/SMS tests until SendPK activation and the user's controlled test window.

## A. Session lifecycle

- [ ] Initial render shows a neutral loading state until Supabase session restoration resolves.
- [ ] Signed-out user cannot see protected customer or retailer data.
- [ ] A valid session is reused after app reload; app launch does not itself trigger a new OTP.
- [ ] Auth state changes update profile and route exactly once without stale async requests overwriting the latest account state.
- [ ] Sign-out clears profile, role-dependent navigation, private data and user-specific caches.
- [ ] Expired/revoked session returns to signed-out state without exposing stale dashboard data.
- [ ] Offline/network failures show a recoverable error and do not fabricate a successful profile.

## B. Profile and role trust

- [ ] Profile query selects only columns present in the live schema.
- [ ] The current query's `is_active` field is removed unless a reviewed migration adds it.
- [ ] Profile is queried by the authenticated user's `auth.uid()`/user ID; client-supplied IDs are not trusted.
- [ ] CUSTOMER role is taken from the database profile, not localStorage or user metadata.
- [ ] RETAILER_ADMIN UI appears only after trusted profile load; actual privileged actions are independently enforced by RLS/RPC/server.
- [ ] Missing profile, unknown role, permission error or failed query produces a fail-closed recoverable state.
- [ ] A normal customer cannot promote themselves to RETAILER_ADMIN by editing browser storage, metadata, form fields or network payloads.

## C. Customer dashboard

- [ ] Enabled packages display from the database and refresh after data changes.
- [ ] Customer profile shows only the signed-in user's profile.
- [ ] Bundle allocations show only rows belonging to the signed-in customer.
- [ ] Empty allocations render a useful empty state.
- [ ] Loading, database error, empty catalogue and no-network states are distinct and recoverable.
- [ ] Untrusted names/package text are rendered safely; no raw HTML injection.

## D. Retailer-admin dashboard

- [ ] Admin dashboard is hidden until trusted role loading finishes.
- [ ] Non-admin requests to admin operations are denied by database/server authorization even if UI is manipulated.
- [ ] Admin tools expose only approved retailer workflows and do not permit unrestricted customer-data access.
- [ ] Existing authorized admin remains authorized after deployment; no hardcoded UUID assumption.
- [ ] Role/allowlist changes cannot be made by customer-facing client requests.

## E. OTP/SMS — intentionally deferred until controlled test

- [ ] Eligible customer request sends one SMS via approved SendPK route.
- [ ] Correct unexpired OTP creates a normal Supabase Auth session.
- [ ] Wrong, expired, consumed and replayed OTPs fail.
- [ ] Monthly customer cap is enforced at 300 SMS reservations; retailer cap is separately enforced.
- [ ] Cooldown, per-phone and IP limits work; concurrent requests cannot exceed budget.
- [ ] Ineligible phone cannot bypass eligibility by calling Supabase Auth directly.
- [ ] No logs or responses expose OTP, API key, session token or full phone number.

## F. Regression and release

- [ ] Existing profiles, roles, package rows and authorized admin identity remain unchanged.
- [ ] No new console errors or unhandled promise rejections in normal navigation.
- [ ] PWA install/offline shell behavior remains intact.
- [ ] Tests run against a disposable test database where database permissions/policies are changed.
- [ ] Supabase security advisor is reviewed; known Chapter 3 findings are not represented as resolved until verified.
- [ ] Controlled phone OTP/SMS test passes before Chapter 4 is marked complete.
