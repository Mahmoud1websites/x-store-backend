-- Adds explicit supplier-product selection to an already upgraded X Store database.
-- Safe to rerun. Existing and newly synchronized supplier products start hidden.

alter table public.products
  add column if not exists is_listed boolean not null default false;

create index if not exists products_public_catalog_idx
  on public.products(category_name)
  where is_listed = true and available = true and archived = false;

-- Products become visible only after an administrator selects them in the dashboard.
