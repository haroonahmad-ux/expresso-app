-- Chapter 3: server-enforced monthly OTP SMS budget.
-- Additive only: does not alter profiles, packages, allocations, or existing accounts.
-- Production was applied through Supabase migration name customer_otp_monthly_cap.
create table if not exists private.otp_monthly_usage (
  month_start date not null,
  purpose text not null check (purpose in ('CUSTOMER_LOGIN','RETAILER_LOGIN')),
  reserved_count integer not null default 0 check (reserved_count >= 0),
  hard_limit integer not null check (hard_limit > 0),
  updated_at timestamptz not null default now(),
  primary key (month_start, purpose)
);

alter table private.otp_monthly_usage enable row level security;
revoke all on table private.otp_monthly_usage from public, anon, authenticated;
grant select, insert, update on table private.otp_monthly_usage to service_role;

create or replace function private.reserve_monthly_otp_sms(purpose text)
returns table(allowed boolean, used_count integer, monthly_limit integer, month_start date)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month date := date_trunc('month', now() at time zone 'UTC')::date;
  v_limit integer;
  v_count integer;
begin
  if purpose not in ('CUSTOMER_LOGIN','RETAILER_LOGIN') then
    raise exception 'invalid OTP purpose';
  end if;
  v_limit := case when purpose = 'CUSTOMER_LOGIN' then 300 else 50 end;

  insert into private.otp_monthly_usage(month_start, purpose, reserved_count, hard_limit)
  values (v_month, purpose, 0, v_limit)
  on conflict (month_start, purpose) do nothing;

  update private.otp_monthly_usage u
     set reserved_count = u.reserved_count + 1, updated_at = now()
   where u.month_start = v_month
     and u.purpose = reserve_monthly_otp_sms.purpose
     and u.reserved_count < u.hard_limit
  returning u.reserved_count, u.hard_limit into v_count, v_limit;

  if found then
    return query select true, v_count, v_limit, v_month;
  else
    select u.reserved_count, u.hard_limit into v_count, v_limit
      from private.otp_monthly_usage u
     where u.month_start = v_month
       and u.purpose = reserve_monthly_otp_sms.purpose;
    return query select false, coalesce(v_count, 0), coalesce(v_limit, 300), v_month;
  end if;
end;
$$;

revoke all on function private.reserve_monthly_otp_sms(text) from public, anon, authenticated;
grant execute on function private.reserve_monthly_otp_sms(text) to service_role;
