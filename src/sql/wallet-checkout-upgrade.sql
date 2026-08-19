-- X Store wallet funding and checkout safety upgrade.
-- Safe to rerun after src/sql/admin-migration.sql.

begin;

alter table public.app_settings
  add column if not exists whish_phone text not null default '+96176345701';

update public.app_settings
set whish_phone = '+96176345701'
where id = 1 and length(trim(coalesce(whish_phone, ''))) = 0;

alter table public.orders
  add column if not exists client_request_id text,
  add column if not exists wallet_debited_at timestamptz,
  add column if not exists refunded_at timestamptz,
  add column if not exists error_message text;

create unique index if not exists orders_user_client_request_unique
  on public.orders(user_id, client_request_id)
  where client_request_id is not null;

create table if not exists public.wallet_topup_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete restrict,
  amount_usd numeric(12,2) not null check (amount_usd >= 1 and amount_usd <= 1000),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  customer_note text not null default '',
  whish_reference text,
  admin_note text,
  reviewed_by uuid references public.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.wallet_topup_requests enable row level security;

create unique index if not exists wallet_topup_one_pending_per_user
  on public.wallet_topup_requests(user_id)
  where status = 'pending';

create index if not exists wallet_topup_status_created_idx
  on public.wallet_topup_requests(status, created_at desc);

create unique index if not exists wallet_ledger_topup_request_unique
  on public.wallet_ledger(reason)
  where entry_type = 'top_up';

create or replace function public.admin_review_wallet_topup(
  p_admin_id uuid,
  p_request_id uuid,
  p_action text,
  p_whish_reference text,
  p_admin_note text
)
returns setof public.wallet_topup_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin public.users;
  v_customer public.users;
  v_request public.wallet_topup_requests;
  v_before numeric;
  v_after numeric;
  v_status text;
  v_ledger_reason text;
begin
  select * into v_admin from public.users where id = p_admin_id;
  if v_admin.id is null or v_admin.role <> 'admin' or v_admin.disabled then
    raise exception 'Administrator access is required';
  end if;

  if p_action not in ('approve', 'reject') then
    raise exception 'Action must be approve or reject';
  end if;

  select * into v_request
  from public.wallet_topup_requests
  where id = p_request_id
  for update;

  if v_request.id is null then
    raise exception 'Wallet request not found';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'Wallet request was already reviewed';
  end if;

  v_status := case when p_action = 'approve' then 'approved' else 'rejected' end;

  if p_action = 'approve' then
    if p_whish_reference is null or length(trim(p_whish_reference)) < 3 then
      raise exception 'Whish transfer reference is required';
    end if;

    select * into v_customer
    from public.users
    where id = v_request.user_id
    for update;

    if v_customer.id is null then raise exception 'Customer not found'; end if;
    if v_customer.disabled then raise exception 'Customer account is disabled'; end if;

    v_before := coalesce(v_customer.wallet_balance, 0);
    v_after := v_before + v_request.amount_usd;
    v_ledger_reason := 'topup:' || v_request.id::text;

    update public.users
    set wallet_balance = v_after, updated_at = now()
    where id = v_customer.id;

    insert into public.wallet_ledger (
      user_id,
      admin_id,
      amount,
      balance_before,
      balance_after,
      entry_type,
      reason
    ) values (
      v_customer.id,
      p_admin_id,
      v_request.amount_usd,
      v_before,
      v_after,
      'top_up',
      v_ledger_reason
    );
  end if;

  update public.wallet_topup_requests
  set status = v_status,
      whish_reference = nullif(trim(coalesce(p_whish_reference, '')), ''),
      admin_note = nullif(trim(coalesce(p_admin_note, '')), ''),
      reviewed_by = p_admin_id,
      reviewed_at = now(),
      updated_at = now()
  where id = p_request_id
  returning * into v_request;

  insert into public.admin_audit_logs (
    admin_id,
    action,
    entity_type,
    entity_id,
    changes,
    reason
  ) values (
    p_admin_id,
    'wallet_topup.' || p_action,
    'wallet_topup_request',
    p_request_id::text,
    jsonb_build_object(
      'user_id', v_request.user_id,
      'amount_usd', v_request.amount_usd,
      'status', v_request.status,
      'whish_reference', v_request.whish_reference
    ),
    coalesce(nullif(trim(coalesce(p_admin_note, '')), ''), 'Whish Money transfer review')
  );

  return next v_request;
end;
$$;

revoke all on function public.admin_review_wallet_topup(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.admin_review_wallet_topup(uuid, uuid, text, text, text)
  to service_role;

commit;
