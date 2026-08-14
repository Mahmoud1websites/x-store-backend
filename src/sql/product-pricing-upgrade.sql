-- X Store professional product pricing upgrade
-- Safe to run more than once. Run this in the Supabase SQL Editor.

begin;

alter table public.products
  add column if not exists pricing_mode text not null default 'global',
  add column if not exists custom_markup_percent numeric,
  add column if not exists supplier_price_updated_at timestamptz;

-- Convert old manually overridden prices to the new fixed-price mode.
update public.products
set pricing_mode = 'fixed'
where (price_overridden = true or product_type = 'manual')
  and pricing_mode = 'global';

update public.products
set pricing_mode = 'global'
where pricing_mode not in ('global', 'percentage', 'fixed');

update public.products
set custom_markup_percent = null
where pricing_mode <> 'percentage';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'products_pricing_mode_check'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
      add constraint products_pricing_mode_check
      check (pricing_mode in ('global', 'percentage', 'fixed'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'products_custom_markup_check'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
      add constraint products_custom_markup_check
      check (
        (pricing_mode = 'percentage' and custom_markup_percent between 0 and 1000)
        or (pricing_mode <> 'percentage' and custom_markup_percent is null)
      );
  end if;
end $$;

create index if not exists products_pricing_mode_idx
  on public.products(pricing_mode)
  where archived = false;

-- Atomically updates every product that follows the global markup.
create or replace function public.reprice_global_products(p_markup numeric)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if p_markup is null or p_markup < 0 or p_markup > 1000 then
    raise exception 'Global markup must be between 0 and 1000 percent';
  end if;

  update public.app_settings
  set default_markup_percent = p_markup,
      updated_at = now()
  where id = 1;

  update public.products
  set your_price = round((coalesce(supplier_price, 0) * (1 + p_markup / 100))::numeric, 3),
      custom_markup_percent = null,
      price_overridden = false,
      updated_at = now()
  where pricing_mode = 'global'
    and coalesce(product_type, '') <> 'manual'
    and archived = false;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.reprice_global_products(numeric)
  from public, anon, authenticated;
grant execute on function public.reprice_global_products(numeric)
  to service_role;

commit;
