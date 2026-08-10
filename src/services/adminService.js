const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');
const supabase = require('../db/supabaseClient');
const catalogService = require('./catalogService');
const supplierApi = require('./supplierApi');

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
    supabase.from('users').select('id,email,wallet_balance,role,disabled,created_at'),
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
      email: user?.email || null,
      customer_email: user?.email || null,
      product_name: product?.name || null,
    };
  });
}

async function getOverview() {
  const { users, products, orders } = await loadDashboardData();
  const fulfilledStatuses = new Set(['accept', 'completed']);
  const revenue = orders
    .filter((order) => fulfilledStatuses.has(String(order.status).toLowerCase()))
    .reduce((sum, order) => sum + Number(order.your_price || order.total || 0), 0);

  let supplier;
  try {
    const profile = await supplierApi.getProfile();
    supplier = { connected: true, message: 'Supplier API connected', profile };
  } catch (error) {
    supplier = { connected: false, message: error.message };
  }

  return {
    revenue,
    orders: orders.length,
    users: users.length,
    products: products.filter((product) => !product.archived).length,
    recentOrders: enrichOrders(orders.slice(0, 8), users, products),
    supplier,
  };
}

async function listProducts(search) {
  const term = cleanSearch(search);
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .order('updated_at', { ascending: false });
  fail(error, 'list products');
  return (data || []).filter((product) => {
    if (product.archived) return false;
    if (!term) return true;
    return [product.name, product.category_name, product.supplier_product_id]
      .some((value) => String(value || '').toLowerCase().includes(term));
  });
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
  const fields = ['name', 'category_name', 'available', 'supplier_product_id'];
  for (const field of fields) {
    if (input[field] !== undefined) patch[field] = input[field];
  }
  if (input.your_price !== undefined) {
    patch.your_price = Number(input.your_price);
    patch.price_overridden = true;
  }
  if (input.image_url !== undefined) {
    patch.image_url = input.image_url || null;
    patch.image_overridden = true;
  }
  patch.updated_at = new Date().toISOString();
  return patch;
}

async function createProduct(adminId, input) {
  const supplierProductId = input.supplier_product_id || -Date.now();
  const row = {
    supplier_product_id: supplierProductId,
    name: input.name,
    category_name: input.category_name || 'Other',
    supplier_price: 0,
    your_price: Number(input.your_price),
    product_type: 'manual',
    qty_values: null,
    params: {},
    available: input.available !== false,
    image_url: input.image_url || null,
    category_img: input.image_url || null,
    price_overridden: true,
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
  const { data, error } = await supabase
    .from('products')
    .update(patch)
    .eq(column, product[column])
    .select()
    .single();
  fail(error, 'update product');
  await writeAudit(adminId, 'product.update', 'product', data.id || data.supplier_product_id, patch);
  return data;
}

async function archiveProduct(adminId, identifier) {
  const { product, column } = await findProduct(identifier);
  const patch = { available: false, archived: true, updated_at: new Date().toISOString() };
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

async function ensureCategories() {
  const [categoriesResult, productsResult] = await Promise.all([
    supabase.from('categories').select('*'),
    supabase.from('products').select('category_name,category_img,image_url'),
  ]);
  fail(categoriesResult.error, 'load categories');
  fail(productsResult.error, 'load product categories');

  const categories = categoriesResult.data || [];
  const knownNames = new Set(categories.map((category) => cleanSearch(category.name)));
  const missing = [];
  for (const product of productsResult.data || []) {
    const name = String(product.category_name || '').trim();
    if (!name || knownNames.has(cleanSearch(name))) continue;
    knownNames.add(cleanSearch(name));
    missing.push({
      key: `${slugify(name)}-${crypto.randomBytes(3).toString('hex')}`,
      name,
      image_url: product.category_img || product.image_url || null,
      description: '',
      visible: true,
    });
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
    supabase.from('products').select('category_name,archived'),
  ]);
  fail(categoriesResult.error, 'list categories');
  fail(productsResult.error, 'count category products');
  const counts = new Map();
  for (const product of productsResult.data || []) {
    if (product.archived) continue;
    const key = cleanSearch(product.category_name);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return (categoriesResult.data || []).map((category) => ({
    ...category,
    label: category.name,
    product_count: counts.get(cleanSearch(category.name)) || 0,
  }));
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
  for (const field of ['name', 'description', 'image_url', 'visible']) {
    if (input[field] !== undefined) patch[field] = input[field];
  }
  const { data, error } = await supabase
    .from('categories')
    .update(patch)
    .eq(column, current[column])
    .select()
    .single();
  fail(error, 'update category');

  if (input.name && input.name !== current.name) {
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

async function updateOrder(adminId, identifier, input) {
  const { order, column } = await findOrder(identifier);
  const patch = { updated_at: new Date().toISOString() };
  if (input.admin_note !== undefined) patch.admin_note = input.admin_note;
  if (input.status !== undefined) {
    const allowedManualStatuses = new Set(['pending_supplier', 'wait', 'reject']);
    if (!allowedManualStatuses.has(input.status)) {
      const error = new Error('Administrators cannot manually mark supplier fulfillment as successful');
      error.status = 400;
      throw error;
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
  await writeAudit(adminId, 'order.update', 'order', data.order_uuid || data.id, patch, input.audit_reason);
  return data;
}

async function listUsers(search) {
  const term = cleanSearch(search);
  const [usersResult, ordersResult] = await Promise.all([
    supabase
      .from('users')
      .select('id,email,wallet_balance,role,disabled,created_at')
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
    .filter((user) => !term || user.email.toLowerCase().includes(term))
    .map((user) => ({ ...user, wallet_balance: Number(user.wallet_balance || 0), order_count: counts.get(String(user.id)) || 0 }));
}

async function updateUser(adminId, userId, input) {
  const { data, error } = await supabase.rpc('admin_update_user', {
    p_admin_id: adminId,
    p_user_id: userId,
    p_wallet_balance: input.wallet_balance === undefined ? null : Number(input.wallet_balance),
    p_disabled: input.disabled === undefined ? null : Boolean(input.disabled),
    p_reason: input.audit_reason,
  });
  fail(error, 'update user');
  return Array.isArray(data) ? data[0] : data;
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
  const passwordHash = await bcrypt.hash(input.password, 12);
  const { data, error } = await supabase
    .from('users')
    .insert({ id: crypto.randomUUID(), email, password_hash: passwordHash, role: 'admin', disabled: false })
    .select('id,email,wallet_balance,role,disabled,created_at')
    .single();
  fail(error, 'create administrator');
  await writeAudit(adminId, 'admin.create', 'user', data.id, { email: data.email, role: 'admin' });
  return data;
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
    support_phone: settings.support_phone || '',
  };
}

async function updateSettings(adminId, input) {
  const patch = { ...input, updated_at: new Date().toISOString() };
  if (patch.exchange_rate !== undefined) patch.exchange_rate = Number(patch.exchange_rate);
  if (patch.default_markup_percent !== undefined) {
    patch.default_markup_percent = Number(patch.default_markup_percent);
  }
  const { data, error } = await supabase
    .from('app_settings')
    .update(patch)
    .eq('id', SETTINGS_ID)
    .select()
    .single();
  fail(error, 'update settings');
  await writeAudit(adminId, 'settings.update', 'settings', SETTINGS_ID, patch);
  return data;
}

async function getSupplierStatus() {
  const [settings, products] = await Promise.all([
    getSettings(),
    supabase.from('products').select('supplier_product_id,archived'),
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
      mapped_products: supplierProducts.filter((product) => !product.archived).length,
      unmapped_products: supplierProducts.filter((product) => product.archived).length,
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
  const result = await catalogService.syncCatalog();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('app_settings')
    .update({ last_supplier_sync_at: now, updated_at: now })
    .eq('id', SETTINGS_ID);
  fail(error, 'record supplier synchronization');
  await writeAudit(adminId, 'supplier.sync', 'supplier', null, result);
  return {
    ...result,
    imported: result.synced,
    updated: result.synced,
    message: `Supplier catalog synchronized: ${result.synced} products processed.`,
  };
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
  listProducts,
  createProduct,
  updateProduct,
  archiveProduct,
  listCategories,
  updateCategory,
  listOrders,
  updateOrder,
  listUsers,
  updateUser,
  createAdmin,
  getSettings,
  getPublicSettings,
  updateSettings,
  getSupplierStatus,
  syncSupplier,
  uploadImage,
};
