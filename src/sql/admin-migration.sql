-- X Store / RechargeLB admin backend migration
-- Safe to rerun. It extends the existing users, products and orders tables.

begin;

create extension if not exists pgcrypto;

alter table public.users
  add column if not exists role text not null default 'customer',
  add column if not exists disabled boolean not null default false,
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'users_role_check' and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      add constraint users_role_check check (role in ('customer', 'support', 'admin'));
  end if;
end $$;

alter table public.products
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists image_url text,
  add column if not exists price_overridden boolean not null default false,
  add column if not exists image_overridden boolean not null default false,
  add column if not exists is_listed boolean not null default false,
  add column if not exists archived boolean not null default false,
  add column if not exists pricing_mode text not null default 'global',
  add column if not exists custom_markup_percent numeric,
  add column if not exists supplier_price_updated_at timestamptz,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists products_id_unique on public.products(id);
create unique index if not exists products_supplier_product_id_unique
  on public.products(supplier_product_id);
create index if not exists products_public_catalog_idx
  on public.products(category_name)
  where is_listed = true and available = true and archived = false;

alter table public.orders
  add column if not exists admin_note text,
  add column if not exists updated_at timestamptz not null default now();

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  description text not null default '',
  image_url text,
  visible boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_settings (
  id smallint primary key default 1 check (id = 1),
  exchange_rate numeric not null default 89500 check (exchange_rate > 0),
  default_markup_percent numeric not null default 0 check (default_markup_percent >= 0),
  maintenance_mode boolean not null default false,
  allow_orders boolean not null default true,
  support_phone text not null default '',
  last_supplier_sync_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (id)
values (1)
on conflict (id) do nothing;

create table if not exists public.admin_audit_logs (
  id bigint generated always as identity primary key,
  admin_id uuid references public.users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  changes jsonb not null default '{}'::jsonb,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists admin_audit_logs_created_at_idx
  on public.admin_audit_logs(created_at desc);

create table if not exists public.wallet_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users(id) on delete restrict,
  admin_id uuid references public.users(id) on delete set null,
  amount numeric not null,
  balance_before numeric not null,
  balance_after numeric not null,
  entry_type text not null default 'admin_adjustment',
  reason text not null,
  created_at timestamptz not null default now()
);

create index if not exists wallet_ledger_user_created_idx
  on public.wallet_ledger(user_id, created_at desc);

create unique index if not exists wallet_ledger_order_event_unique
  on public.wallet_ledger(entry_type, reason)
  where entry_type in ('order_debit', 'order_refund');

create or replace function public.wallet_debit(
  p_user_id uuid,
  p_amount numeric,
  p_reason text
)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user public.users;
  v_after numeric;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Debit amount must be positive';
  end if;
  if p_reason is null or length(trim(p_reason)) < 3 then
    raise exception 'Debit reason is required';
  end if;

  select * into v_user from public.users where id = p_user_id for update;
  if v_user.id is null then raise exception 'User not found'; end if;
  if v_user.disabled then raise exception 'Account is disabled'; end if;

  if exists (
    select 1 from public.wallet_ledger
    where entry_type = 'order_debit' and reason = trim(p_reason)
  ) then
    return coalesce(v_user.wallet_balance, 0);
  end if;

  if coalesce(v_user.wallet_balance, 0) < p_amount then
    raise exception 'Insufficient wallet balance';
  end if;
  v_after := coalesce(v_user.wallet_balance, 0) - p_amount;

  update public.users
  set wallet_balance = v_after, updated_at = now()
  where id = p_user_id;

  insert into public.wallet_ledger (
    user_id, amount, balance_before, balance_after, entry_type, reason
  ) values (
    p_user_id, -p_amount, v_user.wallet_balance, v_after, 'order_debit', trim(p_reason)
  );
  return v_after;
end;
$$;

create or replace function public.wallet_credit(
  p_user_id uuid,
  p_amount numeric,
  p_reason text
)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user public.users;
  v_after numeric;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Credit amount must be positive';
  end if;
  if p_reason is null or length(trim(p_reason)) < 3 then
    raise exception 'Credit reason is required';
  end if;

  select * into v_user from public.users where id = p_user_id for update;
  if v_user.id is null then raise exception 'User not found'; end if;

  if exists (
    select 1 from public.wallet_ledger
    where entry_type = 'order_refund' and reason = trim(p_reason)
  ) then
    return coalesce(v_user.wallet_balance, 0);
  end if;

  v_after := coalesce(v_user.wallet_balance, 0) + p_amount;
  update public.users
  set wallet_balance = v_after, updated_at = now()
  where id = p_user_id;

  insert into public.wallet_ledger (
    user_id, amount, balance_before, balance_after, entry_type, reason
  ) values (
    p_user_id, p_amount, v_user.wallet_balance, v_after, 'order_refund', trim(p_reason)
  );
  return v_after;
end;
$$;

revoke all on function public.wallet_debit(uuid, numeric, text)
  from public, anon, authenticated;
revoke all on function public.wallet_credit(uuid, numeric, text)
  from public, anon, authenticated;
grant execute on function public.wallet_debit(uuid, numeric, text) to service_role;
grant execute on function public.wallet_credit(uuid, numeric, text) to service_role;

create or replace function public.admin_update_user(
  p_admin_id uuid,
  p_user_id uuid,
  p_wallet_balance numeric,
  p_disabled boolean,
  p_reason text
)
returns setof public.users
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin public.users;
  v_target public.users;
  v_before numeric;
  v_after numeric;
begin
  select * into v_admin from public.users where id = p_admin_id;
  if v_admin.id is null or v_admin.role <> 'admin' or v_admin.disabled then
    raise exception 'Administrator access is required';
  end if;

  if p_reason is null or length(trim(p_reason)) < 3 then
    raise exception 'An audit reason is required';
  end if;

  select * into v_target
  from public.users
  where id = p_user_id
  for update;

  if v_target.id is null then
    raise exception 'User not found';
  end if;

  if p_admin_id = p_user_id and p_disabled is true then
    raise exception 'An administrator cannot disable their own account';
  end if;

  v_before := coalesce(v_target.wallet_balance, 0);
  v_after := coalesce(p_wallet_balance, v_before);
  if v_after < 0 then
    raise exception 'Wallet balance cannot be negative';
  end if;

  update public.users
  set wallet_balance = v_after,
      disabled = coalesce(p_disabled, disabled),
      updated_at = now()
  where id = p_user_id
  returning * into v_target;

  if v_after is distinct from v_before then
    insert into public.wallet_ledger (
      user_id, admin_id, amount, balance_before, balance_after, reason
    ) values (
      p_user_id, p_admin_id, v_after - v_before, v_before, v_after, trim(p_reason)
    );
  end if;

  insert into public.admin_audit_logs (
    admin_id, action, entity_type, entity_id, changes, reason
  ) values (
    p_admin_id,
    'user.update',
    'user',
    p_user_id::text,
    jsonb_build_object('wallet_balance', v_after, 'disabled', v_target.disabled),
    trim(p_reason)
  );

  return next v_target;
end;
$$;

revoke all on function public.admin_update_user(uuid, uuid, numeric, boolean, text)
  from public, anon, authenticated;
grant execute on function public.admin_update_user(uuid, uuid, numeric, boolean, text)
  to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'x-store-images',
  'x-store-images',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

commit;

-- Bootstrap the first administrator after registering through the app:
-- update public.users
-- set role = 'admin', disabled = false
-- where lower(email) = lower('YOUR_ADMIN_EMAIL');
