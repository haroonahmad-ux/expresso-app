# Expresso OTP budget and persistent sessions

## Customer SMS budget
- Target: about 250 customer OTP SMS per calendar month.
- Hard server-side ceiling: 300 reserved customer OTP SMS per UTC calendar month.
- The reservation is atomic in PostgreSQL through `private.reserve_monthly_otp_sms('CUSTOMER_LOGIN')`; concurrent requests cannot reserve above the configured limit.
- The function returns `allowed=false` after the cap. The OTP request handler MUST stop before calling Supabase Auth or the SMS provider when it is denied.
- A reservation is deliberately consumed before delivery. Provider failures may count against the cap; this conservative behavior prevents retries from exceeding the SMS budget.
- The database also has a separate 50/month reservation ceiling for `RETAILER_LOGIN`. This is a provisional safety limit, not a customer budget.

## Avoid repeated OTPs
- Use Supabase Auth native phone OTP and persistent sessions. After a successful login, keep the returned session and refresh it with the official Supabase client; do not call `signInWithOtp` on every app launch.
- Request OTP only when there is no valid/refreshable session, the customer explicitly signs out, or re-authentication is required.
- Check eligibility server-side before sending any OTP: the phone must match a permitted customer allocation or retailer allowlist entry. Unknown numbers must receive no SMS.
- Apply per-number/IP cooldowns and OTP verification attempt limits in addition to the monthly ceiling.
- Never store OTP plaintext, expose service-role credentials, or let the browser increment/reset monthly usage.

## Production state and limitations
The additive `customer_otp_monthly_cap` migration has been applied to Supabase project `ryimialrkhmnceupzptg`. The table/function are a budget-enforcement primitive, not a complete login flow. The current OTP request handler must call this function before dispatch; the native Supabase Auth SMS hook must also be configured and signature-verified. Do not enable customer OTP until eligibility checks, the reservation call, hook configuration, and end-to-end tests are verified.
