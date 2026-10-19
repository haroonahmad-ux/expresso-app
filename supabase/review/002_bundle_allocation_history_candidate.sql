-- Expresso Chapter 3 — allocation-history protection candidate
-- REVIEW ONLY. Do not apply to production until tested on isolated schema.
-- Design choice: immutable identity/financial snapshot; only status, usage counters,
-- activated_at and expires_at may change through an authorized server workflow.
-- Direct client UPDATE/DELETE must be revoked separately and writes should go through
-- a narrowly-scoped SECURITY DEFINER RPC after its auth model is reviewed.

create or replace function public.prevent_bundle_allocation_history_rewrite()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Bundle allocation history cannot be deleted'
      using errcode = '42501';
  end if;

  if new.id is distinct from old.id
     or new.customer_id is distinct from old.customer_id
     or new.customer_msisdn is distinct from old.customer_msisdn
     or new.package_id is distinct from old.package_id
     or new.allocated_by is distinct from old.allocated_by
     or new.total_data_mb is distinct from old.total_data_mb
     or new.total_mins is distinct from old.total_mins
     or new.total_sms is distinct from old.total_sms
     or new.price_charged_pkr is distinct from old.price_charged_pkr
     or new.created_at is distinct from old.created_at then
    raise exception 'Immutable bundle allocation history fields cannot be changed'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists protect_bundle_allocation_history
  on public.bundle_allocations;

create trigger protect_bundle_allocation_history
before update or delete on public.bundle_allocations
for each row execute function public.prevent_bundle_allocation_history_rewrite();

-- IMPORTANT: This trigger alone is not complete authorization.
-- Do not ship until client UPDATE/DELETE grants are reviewed and allowed mutable
-- columns are updated only via the intended server-side admin workflow.
