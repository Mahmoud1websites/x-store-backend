const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');
const supabase = require('../db/supabaseClient');
const catalogService = require('./catalogService');
const supplierApi = require('./supplierApi');
const pricingService = require('./pricingService');
const authService = require('./authService');
const operationsService = require('./operationsService');
const notifications = require('./notificationService');

const SETTINGS_ID = 1;
const IMAGE_BUCKET = process.env.SUPABASE_IMAGE_BUCKET || 'x-store-images';

function fail(error, context) {
  if (!error) return;
  const wrapped = new Error(`${context}: ${error.message}`);
  wrapped.code = 'DATABASE_ERROR';
  throw wrapped;
}

function cleanSearch(value) {
  return String(value || '').trim().toLowerCase();
}

function slugify(value) {
  return String(value || 'category')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'category';
}

async function writeAudit(adminId, action, entityType, entityId, changes = {}, reason = null) {
  const { error } = await supabase.from('admin_audit_logs').insert({
    admin_id: adminId,
    action,
    entity_type: entityType,
    entity_id: entityId == null ? null : String(entityId),
    changes,
    reason,
  });
  fail(error, 'write audit log');
}

async function getAdminMe(admin) {
  return admin;
}

async function loadDashboardData() {
  const [usersResult, productsResult, ordersResult] = await Promise.all([
    supabase.from('users').select('id,email,phone_e164,display_name,auth_provider,wallet_balance,role,customer_type,disabled,created_at'),
    supabase.from('products').select('*'),
    supabase.from('orders').select('*').order('created_at', { ascending: false }),
  ]);
  fail(usersResult.error, 'load users');
  fail(productsResult.error, 'load products');
  fail(ordersResult.error, 'load orders');
  return {
    users: usersResult.data || [],
    products: productsResult.data || [],
    orders: ordersResult.data || [],
  };
}

function enrichOrders(orders, users, products) {
  const usersById = new Map(users.map((user) => [String(user.id), user]));
  const productsById = new Map();
  for (const product of products) {
    if (product.id != null) productsById.set(String(product.id), product);
    if (product.supplier_product_id != null) {
      productsById.set(String(product.supplier_product_id), product);
    }
  }
  return orders.map((order) => {
    const user = usersById.get(String(order.user_id));
    const product = productsById.get(String(order.product_id));
    return {
      ...order,
      email: user?.email || user?.phone_e164 || null,
      customer_email: user?.email || user?.phone_e164 || null,
      customer_type: order.customer_type || user?.customer_type || 'retail',
      product_name: product?.name || null,
      product_type: product?.product_type || null,
    };
  });
}

async function getOverview() {
  const { users, products, orders } = await loadDashboardData();
  const { count: pendingWalletRequests, error: walletError } = await supabase
    .from('wallet_topup_requests')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending');
  fail(walletError, 'count pending wallet requests');
  const fulfilledStatuses = new Set(['accept', 'completed', 'fulfilled']);
  const revenue = orders
    .filter((order) => fulfilledStatuses.has(String(order.status).toLowerCase()))
    .reduce((sum, order) => sum + Number(order.your_price || order.total || 0), 0);
  const supplierCost = orders
    .filter((order) => fulfilledStatuses.has(String(order.status).toLowerCase()))
    .reduce((sum, order) => sum + Number(order.supplier_price || 0), 0);
  const grossProfit = pricingService.roundPrice(revenue - supplierCost);
  const daily = new Map();
  for (let offset = 13; offset >= 0; offset -= 1) {
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() - offset);
    const key = day.toISOString().slice(0, 10);
    daily.set(key, { date: key, revenue: 0, cost: 0, profit: 0, orders: 0 });
  }
  for (const order of orders) {
    const point = daily.get(String(order.created_at || '').slice(0, 10));
    if (!point) continue;
    point.orders += 1;
    if (fulfilledStatuses.has(String(order.status).toLowerCase())) {
      point.revenue += Number(order.your_price || order.total || 0);
      point.cost += Number(order.supplier_price || 0);
      point.profit = pricingService.roundPrice(point.revenue - point.cost);
    }
  }
  const orderStatuses = orders.reduce((counts, order) => {
    const key = cleanSearch(order.status) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});

  let supplier;
  try {
    const profile = await supplierApi.getProfile();
    supplier = { connected: true, message: 'Supplier API connected', profile };
  } catch (error) {
    supplier = { connected: false, message: error.message };
  }

  return {
    revenue,
    supplierCost,
    grossProfit,
    grossMarginPercent: revenue > 0
      ? pricingService.roundPrice((grossProfit / revenue) * 100)
      : 0,
    orders: orders.length,
    users: users.length,
    products: products.filter((product) => product.is_listed && !product.archived).length,
    pendingWalletRequests: pendingWalletRequests || 0,
    recentOrders: enrichOrders(orders.slice(0, 8), users, products),
    daily: Array.from(daily.values()),
    orderStatuses,
    supplier,
  };
}

function reportWindow(value) {
  const days = Math.min(Math.max(Number(value) || 30, 1), 365);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  since.setUTCHours(0, 0, 0, 0);
  return { days, since: since.toISOString() };
}

async function getReports(rangeDays = 30) {
  const { days, since } = reportWindow(rangeDays);
  const [ordersResult, ledgerResult, productsResult, syncResult] = await Promise.all([
    supabase.from('orders').select('*').gte('created_at', since).order('created_at'),
    supabase.from('wallet_ledger').select('*').gte('created_at', since).order('created_at'),
    supabase.from('products').select('id,supplier_product_id,name,category_name,supplier_price,your_price'),
    supabase.from('supplier_sync_logs').select('*').gte('started_at', since).order('started_at', { ascending: false }),
  ]);
  fail(ordersResult.error, 'load report orders');
  fail(ledgerResult.error, 'load wallet report');
  fail(productsResult.error, 'load report products');
  fail(syncResult.error, 'load supplier report');

  const orders = ordersResult.data || [];
  const ledger = ledgerResult.data || [];
  const products = productsResult.data || [];
  const syncs = syncResult.data || [];
  const completed = orders.filter((order) => ['accept', 'completed', 'fulfilled'].includes(cleanSearch(order.status)));
  const revenue = completed.reduce((sum, order) => sum + Number(order.your_price || 0), 0);
  const supplierCost = completed.reduce((sum, order) => sum + Number(order.supplier_price || 0), 0);
  const grossProfit = pricingService.roundPrice(revenue - supplierCost);
  const walletCredits = ledger.filter((row) => Number(row.amount) > 0)
    .reduce((sum, row) => sum + Number(row.amount), 0);
  const walletDebits = Math.abs(ledger.filter((row) => Number(row.amount) < 0)
    .reduce((sum, row) => sum + Number(row.amount), 0));

  const productsById = new Map();
  for (const product of products) {
    if (product.id != null) productsById.set(String(product.id), product);
    if (product.supplier_product_id != null) productsById.set(String(product.supplier_product_id), product);
  }
  const topProductMap = new Map();
  for (const order of completed) {
    const product = productsById.get(String(order.product_id));
    const key = String(order.product_id);
    const current = topProductMap.get(key) || {
      product_id: order.product_id,
      name: product?.name || `Product ${order.product_id}`,
      category: product?.category_name || 'Other',
      orders: 0,
      revenue: 0,
      supplier_cost: 0,
      profit: 0,
    };
    current.orders += 1;
    current.revenue += Number(order.your_price || 0);
    current.supplier_cost += Number(order.supplier_price || 0);
    current.profit = pricingService.roundPrice(current.revenue - current.supplier_cost);
    topProductMap.set(key, current);
  }

  const dailyMap = new Map();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() - offset);
    const key = day.toISOString().slice(0, 10);
    dailyMap.set(key, { date: key, revenue: 0, cost: 0, profit: 0, orders: 0 });
  }
  for (const order of orders) {
    const key = String(order.created_at || '').slice(0, 10);
    const day = dailyMap.get(key);
    if (!day) continue;
    day.orders += 1;
    if (['accept', 'completed', 'fulfilled'].includes(cleanSearch(order.status))) {
      day.revenue += Number(order.your_price || 0);
      day.cost += Number(order.supplier_price || 0);
      day.profit = pricingService.roundPrice(day.revenue - day.cost);
    }
  }

  const statusCounts = orders.reduce((counts, order) => {
    const key = cleanSearch(order.status) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  const successfulSyncs = syncs.filter((item) => item.status === 'success').length;
  const latestSync = syncs[0] || null;

  return {
    range_days: days,
    since,
    revenue: pricingService.roundPrice(revenue),
    supplier_cost: pricingService.roundPrice(supplierCost),
    gross_profit: grossProfit,
    gross_margin_percent: revenue > 0 ? pricingService.roundPrice((grossProfit / revenue) * 100) : 0,
    orders: orders.length,
    completed_orders: completed.length,
    average_order_value: completed.length ? pricingService.roundPrice(revenue / completed.length) : 0,
    wallet_credits: pricingService.roundPrice(walletCredits),
    wallet_debits: pricingService.roundPrice(walletDebits),
    order_statuses: statusCounts,
    daily: Array.from(dailyMap.values()),
    top_products: Array.from(topProductMap.values())
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10),
    supplier_performance: {
      synchronizations: syncs.length,
      successful: successfulSyncs,
      failed: syncs.filter((item) => item.status === 'failed').length,
      success_rate: syncs.length ? pricingService.roundPrice((successfulSyncs / syncs.length) * 100) : 0,
      last_status: latestSync?.status || null,
      last_sync_at: latestSync?.completed_at || latestSync?.started_at || null,
      last_error: latestSync?.status === 'failed' ? latestSync.error_message || null : null,
    },
  };
}

async function listProducts(search) {
  const term = cleanSearch(search);
  const [productsResult, settings] = await Promise.all([
    supabase.from('products').select('*').order('updated_at', { ascending: false }),
    getSettings(),
  ]);
  fail(productsResult.error, 'list products');
  return (productsResult.data || []).filter((product) => {
    if (product.archived) return false;
    if (!term) return true;
    return [product.name, product.category_name, product.supplier_product_id]
      .some((value) => String(value || '').toLowerCase().includes(term));
  }).map((product) => pricingService.enrichProductPricing(
    product,
    settings.default_markup_percent,
  ));
}

async function findProduct(identifier) {
  const byId = await supabase.from('products').select('*').eq('id', identifier).maybeSingle();
  if (!byId.error && byId.data) return { product: byId.data, column: 'id' };

  const bySupplierId = await supabase
    .from('products')
    .select('*')
    .eq('supplier_product_id', identifier)
    .maybeSingle();
  fail(bySupplierId.error, 'find product');
  if (!bySupplierId.data) {
    const error = new Error('Product not found');
    error.status = 404;
    error.code = 'PRODUCT_NOT_FOUND';
    throw error;
  }
  return { product: bySupplierId.data, column: 'supplier_product_id' };
}

function productPatch(input) {
  const patch = {};
  const fields = [
    'name',
    'category_name',
    'available',
    'is_listed',
    'supplier_product_id',
    'supplier_category_id',
  ];
  for (const field of fields) {
    if (input[field] !== undefined) patch[field] = input[field];
  }
  if (input.image_url !== undefined) {
    patch.image_url = input.image_url || null;
    patch.image_overridden = true;
  }
  if (input.reseller_price !== undefined) {
    patch.reseller_price = Number(input.reseller_price);
  }
  patch.updated_at = new Date().toISOString();
  return patch;
}











async function createProduct(adminId, input) {
  const productType = input.product_type || 'manual';
  const isManual = productType === 'manual';
  const supplierSource = isManual ? null : (input.supplier_source || 'kamal_cell');
  // Manual products get a synthetic negative id (no real provider behind
  // them). Non-manual products (e.g. TopUpApp) must use the provider's
  // own product id so orderService can call their API with it directly.

// supplier_product_id is the table's PRIMARY KEY, shared across every
// supplier. Kamal Cell and TopUpApp each hand out their own small
// integer IDs independently, so trusting either supplier's raw ID
// directly as the PK risks collisions (e.g. both suppliers may have
// a product "654"). Manual products already avoid this with a
// synthetic negative ID; TopUpApp products get the same treatment —
// a large, distinct synthetic PK — while the real TopUpApp ID needed
// to call their API is kept separately in provider_product_id.
const supplierProductId = isManual
  ? (input.supplier_product_id || -Date.now())
  : supplierSource === 'topupapp'
    ? 9_000_000_000_000 + Date.now()
    : input.supplier_product_id; // Kamal Cell IDs are trusted as-is (unchanged)
const providerProductId = supplierSource === 'topupapp'
  ? String(input.supplier_product_id)
  : null;

  // TopUpApp direct-recharge products are always quantity-locked to 1
  // (qty_values: null enforces exactly qty=1 in catalogService.validateQty)
  // and always collect a phone number, unless the admin specified other
  // required fields explicitly.
  const params = Array.isArray(input.params) && input.params.length
    ? input.params
    : (supplierSource === 'topupapp' ? ['Phone Number'] : []);

  const row = {
    supplier_product_id: supplierProductId,
    provider_product_id: providerProductId,
    name: input.name,
    category_name: input.category_name || 'Other',
    supplier_category_id: input.supplier_category_id ?? null,
    supplier_price: 0,
    your_price: Number(input.your_price),
    reseller_price: Number(input.reseller_price ?? input.your_price),
    product_type: productType,
    supplier_source: supplierSource,
    qty_values: null,
    params,
    available: input.available !== false,
    is_listed: input.is_listed !== false,
    image_url: input.image_url || null,
    category_img: input.image_url || null,
    price_overridden: true,
    pricing_mode: pricingService.PRICING_MODES.FIXED,
    custom_markup_percent: null,
    image_overridden: Boolean(input.image_url),
    archived: false,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('products').insert(row).select().single();
  fail(error, 'create product');
  await writeAudit(adminId, 'product.create', 'product', data.id || data.supplier_product_id, row);
  return data;
}





















async function updateProduct(adminId, identifier, input) {
  const { product, column } = await findProduct(identifier);
  const patch = productPatch(input);
  const pricingTouched = input.pricing_mode !== undefined
    || input.custom_markup_percent !== undefined
    || input.your_price !== undefined;

  let settings;
  if (pricingTouched) {
    settings = await getSettings();
    let pricingMode = input.pricing_mode || pricingService.normalizePricingMode(product);
    if (input.your_price !== undefined && input.pricing_mode === undefined) {
      pricingMode = pricingService.PRICING_MODES.FIXED;
    }
    if (input.custom_markup_percent !== undefined && input.pricing_mode === undefined) {
      pricingMode = pricingService.PRICING_MODES.PERCENTAGE;
    }
    if (product.product_type === 'manual' && pricingMode !== pricingService.PRICING_MODES.FIXED) {
      const error = new Error('Manual products must use a fixed customer price');
      error.status = 400;
      error.code = 'MANUAL_PRODUCT_FIXED_PRICE_REQUIRED';
      throw error;
    }

    const customMarkup = input.custom_markup_percent !== undefined
      ? input.custom_markup_percent
      : product.custom_markup_percent;
    const customerPrice = pricingService.calculateCustomerPrice({
      supplierPrice: product.supplier_price,
      pricingMode,
      globalMarkupPercent: settings.default_markup_percent,
      customMarkupPercent: customMarkup,
      fixedPrice: input.your_price !== undefined ? input.your_price : product.your_price,
    });
    patch.pricing_mode = pricingMode;
    patch.custom_markup_percent = pricingMode === pricingService.PRICING_MODES.PERCENTAGE
      ? Number(customMarkup)
      : null;
    patch.your_price = customerPrice;
    patch.price_overridden = pricingMode !== pricingService.PRICING_MODES.GLOBAL;
  }
  const { data, error } = await supabase
    .from('products')
    .update(patch)
    .eq(column, product[column])
    .select()
    .single();
  fail(error, 'update product');
  await writeAudit(adminId, 'product.update', 'product', data.id || data.supplier_product_id, patch);
  if (!settings) settings = await getSettings();
  return pricingService.enrichProductPricing(data, settings.default_markup_percent);
}

async function archiveProduct(adminId, identifier) {
  const { product, column } = await findProduct(identifier);
  const patch = {
    available: false,
    is_listed: false,
    archived: true,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from('products')
    .update(patch)
    .eq(column, product[column])
    .select()
    .single();
  fail(error, 'archive product');
  await writeAudit(adminId, 'product.archive', 'product', data.id || data.supplier_product_id, patch);
  return data;
}

async function setProductListing(adminId, identifiers, isListed) {
  const updated = [];
  for (const identifier of identifiers) {
    updated.push(await updateProduct(adminId, identifier, { is_listed: isListed }));
  }
  return {
    updated: updated.length,
    is_listed: isListed,
    message: isListed
      ? `${updated.length} product(s) added to your store.`
      : `${updated.length} product(s) hidden from your store.`,
  };
}

async function setProductPricing(adminId, identifiers, input) {
  const products = [];
  for (const identifier of identifiers) {
    products.push((await findProduct(identifier)).product);
  }
  if (
    input.pricing_mode !== pricingService.PRICING_MODES.FIXED
    && products.some((product) => product.product_type === 'manual')
  ) {
    const error = new Error('Manual products cannot use supplier markup pricing. Remove them from the selection.');
    error.status = 400;
    error.code = 'MANUAL_PRODUCT_IN_BULK_PRICING';
    throw error;
  }
  const updated = [];
  for (const identifier of identifiers) {
    updated.push(await updateProduct(adminId, identifier, {
      pricing_mode: input.pricing_mode,
      custom_markup_percent: input.custom_markup_percent,
    }));
  }
  const modeLabel = input.pricing_mode === pricingService.PRICING_MODES.GLOBAL
    ? 'global markup'
    : `${Number(input.custom_markup_percent)}% custom markup`;
  return {
    updated: updated.length,
    pricing_mode: input.pricing_mode,
    custom_markup_percent: input.custom_markup_percent ?? null,
    message: `${updated.length} product(s) now use ${modeLabel}.`,
  };
}

async function ensureCategories() {
  const [categoriesResult, productsResult] = await Promise.all([
    supabase.from('categories').select('*'),
    supabase
      .from('products')
      .select('category_name,category_img,image_url,supplier_category_id'),
  ]);
  fail(categoriesResult.error, 'load categories');
  fail(productsResult.error, 'load product categories');

  const categories = categoriesResult.data || [];
  const knownSupplierIds = new Set(
    categories
      .map((category) => Number(category.supplier_category_id))
      .filter((value) => Number.isFinite(value) && value > 0),
  );
  const categoriesByName = new Map(
    categories.map((category) => [cleanSearch(category.supplier_name || category.name), category]),
  );
  const claimedNames = new Set();
  const queuedFallbackNames = new Set();
  const missing = [];
  const backfills = [];
  const syncedAt = new Date().toISOString();

  for (const product of productsResult.data || []) {
    const name = String(product.category_name || '').trim();
    if (!name || cleanSearch(name) === 'null') continue;

    const rawSupplierId = Number(product.supplier_category_id);
    const supplierCategoryId = Number.isFinite(rawSupplierId) && rawSupplierId > 0
      ? rawSupplierId
      : null;
    const normalizedName = cleanSearch(name);
    const imageCandidate = String(product.category_img || product.image_url || '').trim();
    const imageUrl = imageCandidate
      && !imageCandidate.endsWith('/empty.png')
      && imageCandidate !== 'https://api.kamal-cell.com/'
      ? imageCandidate
      : null;

    if (supplierCategoryId && knownSupplierIds.has(supplierCategoryId)) continue;

    const sameName = categoriesByName.get(normalizedName);
    if (
      supplierCategoryId
      && sameName
      && sameName.supplier_category_id == null
      && !claimedNames.has(normalizedName)
    ) {
      claimedNames.add(normalizedName);
      knownSupplierIds.add(supplierCategoryId);
      backfills.push({
        id: sameName.id,
        supplier_category_id: supplierCategoryId,
        supplier_name: name,
        source: 'supplier',
        synced_at: syncedAt,
        image_url: sameName.image_url || imageUrl,
      });
      continue;
    }

    if (
      !supplierCategoryId
      && (categoriesByName.has(normalizedName) || queuedFallbackNames.has(normalizedName))
    ) continue;
    if (supplierCategoryId) knownSupplierIds.add(supplierCategoryId);
    else queuedFallbackNames.add(normalizedName);

    missing.push({
      key: supplierCategoryId
        ? `supplier-${supplierCategoryId}`
        : `${slugify(name)}-${crypto.randomBytes(3).toString('hex')}`,
      name,
      supplier_name: supplierCategoryId ? name : null,
      supplier_category_id: supplierCategoryId,
      source: supplierCategoryId ? 'supplier' : 'manual',
      synced_at: supplierCategoryId ? syncedAt : null,
      image_url: imageUrl,
      description: '',
      visible: true,
    });
  }

  for (const row of backfills) {
    const { id, ...patch } = row;
    const { error } = await supabase.from('categories').update(patch).eq('id', id);
    fail(error, 'connect discovered category to supplier ID');
  }

  if (missing.length) {
    const { error } = await supabase.from('categories').insert(missing);
    fail(error, 'create discovered categories');
  }
}

async function listCategories({ publicOnly = false } = {}) {
  await ensureCategories();
  let query = supabase.from('categories').select('*').order('sort_order', { ascending: true });
  if (publicOnly) query = query.eq('visible', true);
  const [categoriesResult, productsResult] = await Promise.all([
    query,
    supabase
      .from('products')
      .select('category_name,supplier_category_id,is_listed,available,archived'),
  ]);
  fail(categoriesResult.error, 'list categories');
  fail(productsResult.error, 'count category products');
  const totalCounts = new Map();
  const listedCounts = new Map();
  const unavailableCounts = new Map();
  for (const product of productsResult.data || []) {
    if (product.archived) continue;
    const rawSupplierId = Number(product.supplier_category_id);
    const key = Number.isFinite(rawSupplierId) && rawSupplierId > 0
      ? `supplier:${rawSupplierId}`
      : `name:${cleanSearch(product.category_name)}`;
    totalCounts.set(key, (totalCounts.get(key) || 0) + 1);
    if (product.is_listed && product.available) {
      listedCounts.set(key, (listedCounts.get(key) || 0) + 1);
    }
    if (!product.available) {
      unavailableCounts.set(key, (unavailableCounts.get(key) || 0) + 1);
    }
  }
  const categoriesWithCounts = (categoriesResult.data || []).map((category) => {
    const key = category.supplier_category_id != null
      ? `supplier:${Number(category.supplier_category_id)}`
      : `name:${cleanSearch(category.supplier_name || category.name)}`;
    return {
      ...category,
      label: category.name,
      product_count: listedCounts.get(key) || 0,
      listed_product_count: listedCounts.get(key) || 0,
      total_product_count: totalCounts.get(key) || 0,
      unavailable_product_count: unavailableCounts.get(key) || 0,
    };
  });
  return publicOnly
    ? categoriesWithCounts.filter((category) => category.product_count > 0)
    : categoriesWithCounts;
}

async function updateCategory(adminId, identifier, input) {
  const byId = await supabase.from('categories').select('*').eq('id', identifier).maybeSingle();
  let current = !byId.error ? byId.data : null;
  let column = 'id';
  if (!current) {
    const byKey = await supabase.from('categories').select('*').eq('key', identifier).maybeSingle();
    fail(byKey.error, 'find category');
    current = byKey.data;
    column = 'key';
  }
  if (!current) {
    const error = new Error('Category not found');
    error.status = 404;
    throw error;
  }

  const patch = { updated_at: new Date().toISOString() };
  for (const field of ['name', 'description', 'image_url', 'visible', 'sort_order']) {
    if (input[field] !== undefined) patch[field] = input[field];
  }
  const { data, error } = await supabase
    .from('categories')
    .update(patch)
    .eq(column, current[column])
    .select()
    .single();
  fail(error, 'update category');

  if (
    input.name
    && input.name !== current.name
    && current.supplier_category_id == null
  ) {
    const { error: productError } = await supabase
      .from('products')
      .update({ category_name: input.name, updated_at: new Date().toISOString() })
      .eq('category_name', current.name);
    fail(productError, 'rename category products');
  }
  await writeAudit(adminId, 'category.update', 'category', data.id, patch);
  return data;
}

async function listOrders(status) {
  const { users, products, orders } = await loadDashboardData();
  const normalizedStatus = cleanSearch(status);
  const filtered = normalizedStatus && normalizedStatus !== 'all'
    ? orders.filter((order) => cleanSearch(order.status) === normalizedStatus)
    : orders;
  return enrichOrders(filtered, users, products);
}

async function findOrder(identifier) {
  const byId = await supabase.from('orders').select('*').eq('id', identifier).maybeSingle();
  if (!byId.error && byId.data) return { order: byId.data, column: 'id' };
  const byUuid = await supabase.from('orders').select('*').eq('order_uuid', identifier).maybeSingle();
  fail(byUuid.error, 'find order');
  if (!byUuid.data) {
    const error = new Error('Order not found');
    error.status = 404;
    throw error;
  }
  return { order: byUuid.data, column: 'order_uuid' };
}

/**
 * Looks up the product tied to an order (matching by internal id OR
 * supplier_product_id, since order.product_id can be either depending
 * on how the order was created). Used to confirm an order is for a
 * manual product before allowing an admin to attach credentials.
 */
async function findProductForOrder(order) {
  const { data, error } = await supabase
    .from('products')
    .select('id,supplier_product_id,name,product_type')
    .or(`id.eq.${order.product_id},supplier_product_id.eq.${order.product_id}`)
    .maybeSingle();
  fail(error, 'load product for order');
  return data || null;
}

async function updateOrder(adminId, identifier, input) {
  const { order, column } = await findOrder(identifier);
  const patch = { updated_at: new Date().toISOString() };
  if (input.admin_note !== undefined) patch.admin_note = input.admin_note;

  const allowedManualStatuses = new Set(['pending_supplier', 'wait', 'reject']);
  const isFulfilling = input.status === 'fulfilled';

  if (input.status !== undefined) {
    if (!allowedManualStatuses.has(input.status) && !isFulfilling) {
      const error = new Error('Administrators cannot manually mark supplier fulfillment as successful');
      error.status = 400;
      throw error;
    }

    if (isFulfilling) {
      // Only manual products (Shahid, Netflix, etc.) can be fulfilled this
      // way. Supplier-backed products resolve automatically through
      // supplierApi / orderStatusPoller and must never be force-completed.
      const product = await findProductForOrder(order);
      if (!product || product.product_type !== 'manual') {
        const error = new Error('Only manual products can be fulfilled with credentials');
        error.status = 400;
        error.code = 'NOT_A_MANUAL_PRODUCT';
        throw error;
      }
      if (order.status !== 'pending_manual') {
        const error = new Error('Only orders awaiting manual fulfillment can be marked fulfilled');
        error.status = 400;
        error.code = 'ORDER_NOT_PENDING_MANUAL';
        throw error;
      }
      patch.manual_credentials = input.manual_credentials;
      patch.fulfilled_at = new Date().toISOString();
    }

    patch.status = input.status;
  }

  const { data, error } = await supabase
    .from('orders')
    .update(patch)
    .eq(column, order[column])
    .select()
    .single();
  fail(error, 'update order');

  // Credentials (username/email/password) are sensitive — never write them
  // into the audit trail in plaintext.
  const auditChanges = { ...patch };
  if (auditChanges.manual_credentials) auditChanges.manual_credentials = '[redacted]';
  await writeAudit(adminId, 'order.update', 'order', data.order_uuid || data.id, auditChanges, input.audit_reason);

  if (isFulfilling) {
    await notifications.notifyOrder(data).catch((notificationError) => {
      console.error('[adminService] order fulfilled but notification failed:', notificationError.message);
    });
  }

  return data;
}

async function listUsers(search) {
  const term = cleanSearch(search);
  const [usersResult, ordersResult] = await Promise.all([
    supabase
      .from('users')
      .select('id,email,phone_e164,display_name,auth_provider,wallet_balance,role,customer_type,disabled,email_verified,email_verified_at,phone_verified_at,created_at')
      .order('created_at', { ascending: false }),
    supabase.from('orders').select('user_id'),
  ]);
  fail(usersResult.error, 'list users');
  fail(ordersResult.error, 'count user orders');
  const counts = new Map();
  for (const order of ordersResult.data || []) {
    const key = String(order.user_id);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return (usersResult.data || [])
    .filter((user) => {
      if (!term) return true;
      const typeLabel = user.customer_type === 'reseller' ? 'supplier reseller' : 'user retail';
      const identity = `${user.email || ''} ${user.phone_e164 || ''} ${user.display_name || ''}`.toLowerCase();
      return identity.includes(term) || typeLabel.includes(term);
    })
    .map((user) => ({ ...user, wallet_balance: Number(user.wallet_balance || 0), order_count: counts.get(String(user.id)) || 0 }));
}

async function updateUser(adminId, userId, input) {
  if (input.wallet_balance !== undefined || input.disabled !== undefined) {
    const { error } = await supabase.rpc('admin_update_user', {
      p_admin_id: adminId,
      p_user_id: userId,
      p_wallet_balance: input.wallet_balance === undefined ? null : Number(input.wallet_balance),
      p_disabled: input.disabled === undefined ? null : Boolean(input.disabled),
      p_reason: input.audit_reason,
    });
    fail(error, 'update user wallet or status');
  }

  if (input.customer_type !== undefined) {
    const customerType = pricingService.normalizeCustomerType(input.customer_type);
    const { error } = await supabase
      .from('users')
      .update({ customer_type: customerType, updated_at: new Date().toISOString() })
      .eq('id', userId);
    fail(error, 'update customer pricing type');
    await writeAudit(
      adminId,
      'customer.type.update',
      'user',
      userId,
      { customer_type: customerType },
      input.audit_reason,
    );
  }

  const { data, error } = await supabase
    .from('users')
    .select('id,email,phone_e164,display_name,auth_provider,wallet_balance,role,customer_type,disabled,email_verified,email_verified_at,phone_verified_at,created_at')
    .eq('id', userId)
    .single();
  fail(error, 'reload updated user');
  return data;
}

async function createAdmin(adminId, input) {
  const email = input.email.trim().toLowerCase();
  const { data: existing, error: existingError } = await supabase
    .from('users')
    .select('id')
    .ilike('email', email)
    .maybeSingle();
  fail(existingError, 'check admin email');
  if (existing) {
    const error = new Error('An account with this email already exists');
    error.status = 409;
    throw error;
  }
  authService.validatePassword(input.password);
  if (input.password.length < 12) {
    const error = new Error('Administrator passwords must contain at least 12 characters');
    error.status = 400;
    error.code = 'WEAK_ADMIN_PASSWORD';
    throw error;
  }
  const passwordHash = await bcrypt.hash(input.password, 12);
  const { data, error } = await supabase
    .from('users')
    .insert({
      id: crypto.randomUUID(),
      email,
      password_hash: passwordHash,
      role: 'admin',
      disabled: false,
      email_verified: true,
      email_verified_at: new Date().toISOString(),
    })
    .select('id,email,wallet_balance,role,customer_type,disabled,email_verified,created_at')
    .single();
  fail(error, 'create administrator');
  await writeAudit(adminId, 'admin.create', 'user', data.id, { email: data.email, role: 'admin' });
  return data;
}

async function updateAdminAccount(adminId, input) {
  const { data: current, error: currentError } = await supabase
    .from('users')
    .select('*')
    .eq('id', adminId)
    .single();
  fail(currentError, 'load administrator account');

  const passwordMatches = await bcrypt.compare(
    input.current_password || '',
    current.password_hash || '',
  );
  if (!passwordMatches) {
    const error = new Error('Current password is incorrect');
    error.status = 401;
    error.code = 'INVALID_CURRENT_PASSWORD';
    throw error;
  }

  const patch = { updated_at: new Date().toISOString() };
  const changes = {};
  if (input.email !== undefined) {
    const email = input.email.trim().toLowerCase();
    if (email !== current.email) {
      const { data: existing, error: existingError } = await supabase
        .from('users')
        .select('id')
        .ilike('email', email)
        .neq('id', adminId)
        .maybeSingle();
      fail(existingError, 'check updated administrator email');
      if (existing) {
        const error = new Error('An account with this email already exists');
        error.status = 409;
        error.code = 'EMAIL_TAKEN';
        throw error;
      }
      patch.email = email;
      changes.email = { from: current.email, to: email };
    }
  }

  if (input.password) {
    authService.validatePassword(input.password);
    if (input.password.length < 12) {
      const error = new Error('Administrator passwords must contain at least 12 characters');
      error.status = 400;
      error.code = 'WEAK_ADMIN_PASSWORD';
      throw error;
    }
    patch.password_hash = await bcrypt.hash(input.password, 12);
    patch.password_changed_at = new Date().toISOString();
    changes.password_changed = true;
  }

  if (Object.keys(changes).length === 0) {
    const error = new Error('Enter a different email or a new password');
    error.status = 400;
    error.code = 'NOTHING_TO_UPDATE';
    throw error;
  }

  const { data, error } = await supabase
    .from('users')
    .update(patch)
    .eq('id', adminId)
    .select('*')
    .single();
  fail(error, 'update administrator account');
  await writeAudit(
    adminId,
    'admin.account.update',
    'user',
    adminId,
    changes,
    'Administrator updated own credentials',
  );
  const admin = authService.toPublicUser(data);
  return { admin, token: authService.issueToken(data) };
}

async function getSettings() {
  const { data, error } = await supabase
    .from('app_settings')
    .select('*')
    .eq('id', SETTINGS_ID)
    .single();
  fail(error, 'load settings');
  return data;
}

async function getPublicSettings() {
  const settings = await getSettings();
  return {
    exchange_rate: Number(settings.exchange_rate),
    maintenance_mode: Boolean(settings.maintenance_mode),
    allow_orders: Boolean(settings.allow_orders),
    support_phone: settings.support_phone || process.env.XSTORE_SUPPORT_PHONE || '+96176345701',
    whish_phone: settings.whish_phone || process.env.XSTORE_WHISH_PHONE || '+96176345701',
  };
}

async function updateSettings(adminId, input) {
  const patch = { ...input, updated_at: new Date().toISOString() };
  if (patch.exchange_rate !== undefined) patch.exchange_rate = Number(patch.exchange_rate);
  if (patch.default_markup_percent !== undefined) {
    patch.default_markup_percent = Number(patch.default_markup_percent);
  }
  let repricedProducts = 0;
  if (patch.default_markup_percent !== undefined) {
    const repriceResult = await supabase.rpc('reprice_global_products', {
      p_markup: patch.default_markup_percent,
    });
    fail(repriceResult.error, 'reprice products using global markup');
    repricedProducts = Number(repriceResult.data || 0);
  }
  const { data, error } = await supabase
    .from('app_settings')
    .update(patch)
    .eq('id', SETTINGS_ID)
    .select()
    .single();
  fail(error, 'update settings');
  await writeAudit(adminId, 'settings.update', 'settings', SETTINGS_ID, patch);
  return { ...data, repriced_products: repricedProducts };
}

async function getSupplierStatus() {
  const [settings, products] = await Promise.all([
    getSettings(),
    supabase.from('products').select('supplier_product_id,is_listed,archived'),
  ]);
  fail(products.error, 'load supplier product counts');
  const supplierProducts = (products.data || []).filter((product) => product.supplier_product_id != null);
  try {
    const profile = await supplierApi.getProfile();
    return {
      connected: true,
      message: 'Supplier API connected securely',
      last_sync_at: settings.last_supplier_sync_at,
      supplier_products: supplierProducts.length,
      mapped_products: supplierProducts.filter((product) => product.is_listed && !product.archived).length,
      unmapped_products: supplierProducts.filter((product) => !product.is_listed || product.archived).length,
      profile,
    };
  } catch (error) {
    return {
      connected: false,
      message: error.message,
      last_sync_at: settings.last_supplier_sync_at,
      supplier_products: supplierProducts.length,
    };
  }
}

async function syncSupplier(adminId) {
  const startedAt = Date.now();
  const { data: syncLog, error: logError } = await supabase
    .from('supplier_sync_logs')
    .insert({ admin_id: adminId, status: 'running' })
    .select()
    .single();
  fail(logError, 'start supplier synchronization log');

  try {
    const result = await catalogService.syncCatalog();
    const now = new Date().toISOString();
    const durationMs = Date.now() - startedAt;
    const { error } = await supabase
      .from('app_settings')
      .update({ last_supplier_sync_at: now, updated_at: now })
      .eq('id', SETTINGS_ID);
    fail(error, 'record supplier synchronization');
    const { error: syncLogError } = await supabase
      .from('supplier_sync_logs')
      .update({
        status: 'success',
        imported_count: Number(result.imported || result.synced || 0),
        updated_count: Number(result.updated || result.synced || 0),
        processed_count: Number(result.synced || 0),
        duration_ms: durationMs,
        details: result,
        completed_at: now,
      })
      .eq('id', syncLog.id);
    fail(syncLogError, 'finish supplier synchronization log');
    await writeAudit(adminId, 'supplier.sync', 'supplier', syncLog.id, result);
    return {
      ...result,
      imported: result.imported || result.synced,
      updated: result.updated || result.synced,
      duration_ms: durationMs,
      sync_id: syncLog.id,
      message: `Supplier catalog synchronized: ${result.synced} products processed.`,
    };
  } catch (error) {
    await supabase
      .from('supplier_sync_logs')
      .update({
        status: 'failed',
        duration_ms: Date.now() - startedAt,
        error_code: error.code || 'SUPPLIER_SYNC_FAILED',
        error_message: String(error.message || 'Supplier synchronization failed').slice(0, 1000),
        completed_at: new Date().toISOString(),
      })
      .eq('id', syncLog.id);
    throw error;
  }
}

async function getSupplierSyncHistory(limit = 50) {
  const { data, error } = await supabase
    .from('supplier_sync_logs')
    .select('*,admin:users!supplier_sync_logs_admin_id_fkey(email)')
    .order('started_at', { ascending: false })
    .limit(Math.min(Math.max(Number(limit) || 50, 1), 200));
  fail(error, 'load supplier synchronization history');
  return data || [];
}

async function listAuditLogs(limit = 100) {
  const { data, error } = await supabase
    .from('admin_audit_logs')
    .select('*,admin:users!admin_audit_logs_admin_id_fkey(email)')
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(Number(limit) || 100, 1), 500));
  fail(error, 'load administrator audit logs');
  return data || [];
}

async function listOperationalLogs(level, limit) {
  return operationsService.list({ level, limit });
}

async function uploadImage(adminId, file) {
  const extension = path.extname(file.originalname || '').toLowerCase() || '.jpg';
  const objectName = `catalog/${Date.now()}-${crypto.randomUUID()}${extension}`;
  const { error } = await supabase.storage.from(IMAGE_BUCKET).upload(objectName, file.buffer, {
    contentType: file.mimetype,
    upsert: false,
  });
  fail(error, 'upload image');
  const { data } = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(objectName);
  await writeAudit(adminId, 'image.upload', 'storage', objectName, {
    content_type: file.mimetype,
    size: file.size,
  });
  return { url: data.publicUrl };
}

module.exports = {
  getAdminMe,
  getOverview,
  getReports,
  listProducts,
  createProduct,
  updateProduct,
  archiveProduct,
  setProductListing,
  setProductPricing,
  listCategories,
  updateCategory,
  listOrders,
  updateOrder,
  listUsers,
  updateUser,
  createAdmin,
  updateAdminAccount,
  getSettings,
  getPublicSettings,
  updateSettings,
  getSupplierStatus,
  syncSupplier,
  getSupplierSyncHistory,
  listAuditLogs,
  listOperationalLogs,
  uploadImage,
};