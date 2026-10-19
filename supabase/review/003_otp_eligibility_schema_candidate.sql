-- REVIEW ONLY — NOT A DEPLOYED MIGRATION.
-- Requires a disposable Supabase database and security review before promotion.
-- This migration intentionally does not create or enable public OTP endpoints.
begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table if not exists private.retailer_allowlist (
  msisdn text primary key check (msisdn ~ '^\+923[0-9]{9}$'),
  is_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table private.retailer_allowlist enable row level security;
revoke all on private.retailer_allowlist from public, anon, authenticated;
grant select, insert, update, delete on private.retailer_allowlist to service_role;

create table if not exists private.otp_challenges (
  id uuid primary key default gen_random_uuid(),
  msisdn text not null check (msisdn ~ '^\+923[0-9]{9}$'),
  otp_hmac text not null,
  purpose text not null check (purpose in ('CUSTOMER_LOGIN','RETAILER_LOGIN')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  attempts integer not null default 0 check (attempts between 0 and 5),
  consumed_at timestamptz,
  request_ip_hash text,
  check (expires_at > created_at)
);
create index if not exists otp_challenges_msisdn_created_idx
  on private.otp_challenges (msisdn, created_at desc);
create index if not exists otp_challenges_expiry_idx
  on private.otp_challenges (expires_at)
  where consumed_at is null;
alter table private.otp_challenges enable row level security;
revoke all on private.otp_challenges from public, anon, authenticated;
grant select, insert, update, delete on private.otp_challenges to service_role;

-- Eligibility is checked against profiles for customers and the private allowlist
-- for retailer administrators. Do not infer authorization from client-provided role.
-- Keep OTP generation, HMAC key use, rate limiting, SMS delivery and verification
-- in server-side Edge Functions. Never store plaintext OTP or expose this schema.
commit;
