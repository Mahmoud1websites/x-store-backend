-- Run this in your Supabase project's SQL Editor (Database > SQL Editor > New query).
-- Requires the pgcrypto extension for gen_random_uuid() — Supabase has this enabled by default.

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  password_hash text not null,
  wallet_balance numeric(12,3) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists products (
  supplier_product_id bigint primary key,
  name text not null,
  category_name text,
  category_img text,
  supplier_price numeric(12,3),
  your_price numeric(12,3),
  product_type text,
  qty_values jsonb,
  params jsonb,
  available boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists orders (
  order_uuid uuid primary key,
  user_id uuid references users(id),
  product_id bigint,
  qty integer not null,
  extra_params jsonb,
  your_price numeric(12,3),
  supplier_price numeric(12,3),
  status text not null,
  supplier_order_id text,
  supplier_response jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists orders_status_idx on orders(status);
create index if not exists orders_user_id_idx on orders(user_id);

-- Row Level Security: your backend talks to Supabase using the SERVICE
-- ROLE key, which bypasses RLS entirely, so this isn't strictly required
-- for the app to work. Still, enabling it with no public policies means
-- that if the anon/public key ever leaked or got used by mistake, no one
-- could read/write these tables directly. Good practice, low cost.
alter table users enable row level security;
alter table products enable row level security;
alter table orders enable row level security;
