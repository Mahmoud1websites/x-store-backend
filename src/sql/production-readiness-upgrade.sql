-- X Store production readiness upgrade.
-- Adds email verification/password recovery, in-app notifications,
-- supplier synchronization history and operational error logs.
-- Run after admin-migration.sql and wallet-checkout-upgrade.sql.
-- Safe to run more than once.

begin;

create extension if not exists pgcrypto;

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'users'
      and column_name = 'email_verified'
  ) then
    alter table public.users add column email_verified boolean;
    -- Accounts created before this feature are preserved as verified.
    update public.users set email_verified = true;
    alter table public.users alter column email_verified set default false;
    alter table public.users alter column email_verified set not null;
  end if;
end $$;

alter table public.users
  add column if not exists email_verified_at timestamptz,
  add column if not exists password_changed_at timestamptz;

update public.users
set email_verified_at = coalesce(email_verified_at, created_at, now())
where email_verified = true;

create table if not exists public.auth_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  purpose text not null check (purpose in ('email_verification', 'password_reset')),
  token_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  created_at timestamptz not null default now()
);

create unique index if not exists auth_tokens_hash_unique
  on public.auth_tokens(token_hash);
create index if not exists auth_tokens_user_purpose_idx
  on public.auth_tokens(user_id, purpose, created_at desc);
create index if not exists auth_tokens_expiry_idx
  on public.auth_tokens(expires_at)
  where used_at is null;

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  type text not null check (
    type in (
      'wallet_approved',
      'wallet_rejected',
      'order_submitted',
      'order_completed',
      'order_rejected',
      'order_status',
      'security',
      'system'
    )
  ),
  title text not null,
  body text not null,
  data jsonb not null default '{}'::jsonb,
  dedupe_key text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

-- A regular unique index still allows multiple NULL values and can be used by
-- PostgREST/Supabase upsert with onConflict: 'dedupe_key'.
drop index if exists public.notifications_dedupe_unique;
create unique index notifications_dedupe_unique
  on public.notifications(dedupe_key);
create index if not exists notifications_user_created_idx
  on public.notifications(user_id, created_at desc);
create index if not exists notifications_user_unread_idx
  on public.notifications(user_id, created_at desc)
  where read_at is null;

create table if not exists public.supplier_sync_logs (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references public.users(id) on delete set null,
  status text not null default 'running'
    check (status in ('running', 'success', 'failed')),
  imported_count integer not null default 0,
  updated_count integer not null default 0,
  processed_count integer not null default 0,
  duration_ms integer,
  error_code text,
  error_message text,
  details jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists supplier_sync_logs_started_idx
  on public.supplier_sync_logs(started_at desc);
create index if not exists supplier_sync_logs_status_idx
  on public.supplier_sync_logs(status, started_at desc);

create table if not exists public.operational_logs (
  id bigint generated always as identity primary key,
  level text not null check (level in ('warning', 'error', 'critical')),
  source text not null,
  code text,
  message text not null,
  request_id text,
  method text,
  path text,
  status_code integer,
  metadata jsonb not null default '{}'::jsonb,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists operational_logs_created_idx
  on public.operational_logs(created_at desc);
create index if not exists operational_logs_open_errors_idx
  on public.operational_logs(level, created_at desc)
  where resolved_at is null;

alter table public.auth_tokens enable row level security;
alter table public.notifications enable row level security;
alter table public.supplier_sync_logs enable row level security;
alter table public.operational_logs enable row level security;

-- These tables are backend-only. The service role bypasses RLS; clients
-- must use the authenticated Express API instead of reading them directly.
revoke all on table public.auth_tokens from anon, authenticated;
revoke all on table public.notifications from anon, authenticated;
revoke all on table public.supplier_sync_logs from anon, authenticated;
revoke all on table public.operational_logs from anon, authenticated;

-- Keep the production Whish fallback consistent everywhere.
update public.app_settings
set whish_phone = '+96176345701', updated_at = now()
where id = 1
  and trim(coalesce(whish_phone, '')) in ('', '+96179306701');

commit;
