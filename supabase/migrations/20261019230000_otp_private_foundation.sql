-- Expresso Chapter 3 OTP foundation — additive, data-preserving migration.
-- This creates private OTP storage and atomic challenge-consumption primitives only.
-- It does NOT enable OTP login until a real SMS adapter and supported Auth session flow are configured.
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
  purpose text not null check (purpose in ('CUSTOMER_LOGIN','RETAILER_LOGIN')),
  otp_hmac text not null,
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
  on private.otp_challenges (expires_at) where consumed_at is null;
alter table private.otp_challenges enable row level security;
revoke all on private.otp_challenges from public, anon, authenticated;
grant select, insert, update, delete on private.otp_challenges to service_role;

create table if not exists private.otp_rate_limits (
  bucket_key text primary key,
  window_started_at timestamptz not null,
  request_count integer not null check (request_count >= 0),
  updated_at timestamptz not null default now()
);
alter table private.otp_rate_limits enable row level security;
revoke all on private.otp_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on private.otp_rate_limits to service_role;

create or replace function private.consume_otp_challenge(
  p_challenge_id uuid,
  p_msisdn text,
  p_purpose text,
  p_expected_hmac text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v private.otp_challenges%rowtype;
begin
  select * into v
  from private.otp_challenges
  where id = p_challenge_id and msisdn = p_msisdn and purpose = p_purpose
  for update;

  if not found or v.consumed_at is not null or v.expires_at <= now() or v.attempts >= 5 then
    return false;
  end if;

  if v.otp_hmac <> p_expected_hmac then
    update private.otp_challenges set attempts = least(attempts + 1, 5) where id = v.id;
    return false;
  end if;

  update private.otp_challenges set consumed_at = now() where id = v.id;
  return true;
end;
$$;
revoke all on function private.consume_otp_challenge(uuid,text,text,text) from public, anon, authenticated;
grant execute on function private.consume_otp_challenge(uuid,text,text,text) to service_role;

commit;