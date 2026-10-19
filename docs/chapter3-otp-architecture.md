# Expresso Chapter 3 — OTP architecture decision (design, not deployed)

## Recommended approach
Use custom Supabase Edge Functions for eligibility-gated phone OTP because the requirement is to reject ineligible numbers before sending any SMS. Disable direct public phone OTP signups only after confirming app auth migration and recovery paths.

## request-otp
1. Normalize Pakistan mobile numbers to E.164 (+923XXXXXXXXX).
2. Apply IP and phone rate limits before any SMS attempt.
3. Check phone against a private retailer allowlist or an eligible customer record using a server-only database function.
4. Return a generic response to avoid revealing whether a number is registered.
5. Generate a cryptographically random OTP; store only an HMAC using a server secret, plus expiry (2 minutes), attempt count, request ID and consumed state.
6. Send through an SMS provider adapter; keep provider credentials in Edge Function secrets.
7. Enforce resend cooldown, daily caps and per-phone/per-IP limits.

## verify-otp
1. Accept challenge/request ID and OTP; never accept a client-supplied role.
2. Lock challenge row in a transaction; reject expired, consumed, over-attempt and mismatched codes.
3. Constant-time compare expected HMAC where supported; increment attempts on failure.
4. Consume challenge exactly once before issuing a session.
5. Resolve the user and role from trusted database state; never promote admin from a phone number supplied by the client.
6. Audit success/failure without logging OTPs or full secrets.

## Admin provisioning
- Use a private allowlist managed only by service-role/admin-only workflow.
- Never hardcode an assumed profile UUID in a migration.
- Require an explicit existing-user match and fail closed if ambiguous.
- Keep service-role key server-side only.

## Acceptance tests
- Ineligible phone: no SMS sent, no session created.
- Valid eligible phone + correct code: one session; challenge consumed.
- Wrong code: attempt counter increments; rate limit works.
- Expired/replayed code: rejected.
- Concurrent verify requests: only one succeeds.
- Client-supplied CUSTOMER/RETAILER_ADMIN fields do not affect role.
- Logs and responses reveal no OTP or account-existence information.

## Status
Design only. No OTP functions deployed, no Auth settings changed, and no SMS provider selected/configured.
