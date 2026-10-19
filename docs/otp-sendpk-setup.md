# Expresso OTP — SendPK + Supabase Auth setup

Status: implementation prepared; NOT live-enabled. No SendPK account, API key, approved OTP template, or Supabase Auth Send SMS Hook secret was available.

## Provider recommendation
Use SendPK Short Code / OTP SMS, not its semi-branded or marketing route. Published pricing currently starts at Rs 10,000 for 2,083 OTP SMS (Rs 4.80/SMS); confirm current rates and activation requirements before purchasing.

Official pages:
- https://sendpk.com/price.php
- https://sendpk.com/api.php
- https://supabase.com/docs/guides/auth/auth-hooks/send-sms-hook

## Architecture
Use Supabase Auth's native phone OTP lifecycle to generate and verify codes and issue normal access/refresh sessions. The custom send-sms-hook function is only a delivery adapter. It receives the Auth-generated OTP through a signed Supabase Send SMS Hook event and sends it through SendPK. Never create a parallel custom JWT or expose the service-role key.

## Setup
1. Create a SendPK account and complete identity/business verification.
2. Activate the Short Code / OTP route (not semi-branded SMS).
3. Create and get approval for a Fixed-SMS/OTP template, e.g. Your Expresso verification code is #otp#. It expires shortly. Do not share it.
4. Obtain the approved template ID and API key from SendPK.
5. Configure these server-side Supabase Edge Function secrets using the Supabase dashboard or authorized CLI, never GitHub or chat:
   - SEND_SMS_HOOK_SECRET: exact Standard Webhooks secret from Supabase Auth Send SMS Hook (format v1,whsec_...).
   - SENDPK_API_KEY: SendPK API key.
   - SENDPK_OTP_TEMPLATE_ID: approved template ID.
   - SENDPK_SENDER: sender identifier approved for the account/route.
6. In Supabase Dashboard > Authentication > Hooks, configure the Send SMS HTTP hook to the deployed send-sms-hook function. The endpoint must verify the Standard Webhooks signature.
7. Enable phone auth, keep auto-confirm disabled, configure a short OTP expiry and SMS send frequency.
8. Use Supabase client signInWithOtp({ phone }) and verifyOtp({ phone, token, type: 'sms' }). Use the returned session; never mint JWTs yourself.

## Eligibility and retailer safeguards
The SMS hook only transports OTPs; it is not an eligibility gate. Before production login is enabled, configure a supported before-user-created eligibility hook or equivalent server-side restriction to prevent direct Auth API signup bypasses. Never derive retailer-admin role from user metadata or frontend state. Verify the existing authorized admin identity before any role migration.

## Acceptance tests
- Valid signed hook event sends through SendPK and returns HTTP 200 only when provider confirms acceptance.
- Invalid signature, malformed phone/OTP, provider failure and timeout are rejected safely.
- Logs never include OTP, phone number, API key or raw provider response.
- Controlled phone receives OTP and correct OTP yields a normal Supabase Auth session.
- Wrong, expired and reused OTPs fail; rate limits work.
- Unauthorized phone cannot sign up through direct Auth endpoints.
- Retailer privileges cannot be assigned through client metadata.

## Current limitation
This adapter cannot send real SMS until the account, approved OTP route/template, credentials and Supabase Auth hook are configured. Do not claim successful delivery or end-to-end login until those steps are executed and verified.