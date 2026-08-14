/**
 * db.js
 *
 * Drop-in replacement for db/memoryStore.js, backed by Supabase
 * (Postgres) instead of an in-memory Map. Every exported function
 * has the exact same name and shape as memoryStore.js had, so
 * authService.js / catalogService.js / orderService.js /
 * orderStatusPoller.js don't need any changes beyond their require()
 * path — see the updated imports in those files.
 *
 * Run sql/schema.sql in your Supabase project before using this.
 */

const supabase = require('./supabaseClient');
const pricingService = require('../services/pricingService');

function throwIfError(error, context) {
  if (error) {
    const wrapped = new Error(`[db] ${context}: ${error.message}`);
    wrapped.code = error.code;
    wrapped.details = error.details;
    throw wrapped;
  }
}

// ---- Users ----

async function createUser({ id, email, passwordHash }) {
  const { data, error } = await supabase
    .from('users')
    .insert({ id, email, password_hash: passwordHash })
    .select()
    .single();
  throwIfError(error, 'createUser');
  return data;
}

async function getUserByEmail(email) {
  // .ilike without wildcards = exact match, case-insensitive.
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .ilike('email', email)
    .maybeSingle();
  throwIfError(error, 'getUserByEmail');
  return data;
}

async function getUserById(id) {
  const { data, error } = await supabase.from('users').select('*').eq('id', id).maybeSingle();
  throwIfError(error, 'getUserById');
  return data;
}

async function updateUser(id, patch) {
  const { data, error } = await supabase.from('users').update(patch).eq('id', id).select().maybeSingle();
  throwIfError(error, 'updateUser');
  return data;
}

async function getAppSettings() {
  const { data, error } = await supabase.from('app_settings').select('*').eq('id', 1).single();
  throwIfError(error, 'getAppSettings');
  return data;
}

async function debitWallet(userId, amount, reason) {
  const { data, error } = await supabase.rpc('wallet_debit', {
    p_user_id: userId,
    p_amount: Number(amount),
    p_reason: reason,
  });
  if (error && /insufficient wallet balance/i.test(error.message)) {
    throw Object.assign(new Error('Insufficient wallet balance'), { code: 'INSUFFICIENT_FUNDS' });
  }
  throwIfError(error, 'debitWallet');
  return Number(data);
}

async function creditWallet(userId, amount, reason) {
  const { data, error } = await supabase.rpc('wallet_credit', {
    p_user_id: userId,
    p_amount: Number(amount),
    p_reason: reason,
  });
  throwIfError(error, 'creditWallet');
  return Number(data);
}

// ---- Products ----

async function upsertProducts(productList) {
  if (!productList.length) return 0;
  const supplierIds = productList.map((p) => p.id);
  const { data: existingRows, error: existingError } = await supabase
    .from('products')
    .select('supplier_product_id,your_price,image_url,price_overridden,image_overridden,is_listed,archived,pricing_mode,custom_markup_percent')
    .in('supplier_product_id', supplierIds);
  throwIfError(existingError, 'load products before sync');
  const existingBySupplierId = new Map(
    (existingRows || []).map((row) => [String(row.supplier_product_id), row])
  );

  const now = new Date().toISOString();
  const rows = productList.map((p) => {
    const existing = existingBySupplierId.get(String(p.id)) || {};
    const pricingMode = pricingService.normalizePricingMode(existing);
    let customerPrice = p.your_price;
    if (pricingMode === pricingService.PRICING_MODES.FIXED) {
      customerPrice = existing.your_price;
    } else if (pricingMode === pricingService.PRICING_MODES.PERCENTAGE) {
      customerPrice = pricingService.calculateCustomerPrice({
        supplierPrice: p.supplier_price,
        pricingMode,
        customMarkupPercent: existing.custom_markup_percent,
      });
    }

    return {
      ...existing,
      supplier_product_id: p.id,
      name: p.name,
      category_name: p.category_name,
      category_img: p.category_img || null,
      supplier_price: p.supplier_price,
      supplier_price_updated_at: now,
      your_price: customerPrice,
      pricing_mode: pricingMode,
      custom_markup_percent: pricingMode === pricingService.PRICING_MODES.PERCENTAGE
        ? existing.custom_markup_percent
        : null,
      price_overridden: pricingMode !== pricingService.PRICING_MODES.GLOBAL,
      product_type: p.product_type,
      qty_values: p.qty_values,
      params: p.params,
      is_listed: existing.is_listed ?? false,
      available: existing.archived ? false : p.available,
      updated_at: now,
    };
  });
  const { data, error } = await supabase
    .from('products')
    .upsert(rows, { onConflict: 'supplier_product_id' })
    .select();
  throwIfError(error, 'upsertProducts');
  return data.length;
}

async function getProduct(supplierProductId) {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('supplier_product_id', supplierProductId)
    .maybeSingle();
  throwIfError(error, 'getProduct');
  return data;
}

async function listProducts() {
  const { data, error } = await supabase.from('products').select('*');
  throwIfError(error, 'listProducts');
  return data || [];
}

// ---- Orders ----

async function createOrder(order) {
  const { data, error } = await supabase
    .from('orders')
    .insert({
      order_uuid: order.order_uuid,
      client_request_id: order.client_request_id,
      user_id: order.user_id,
      product_id: order.product_id,
      qty: order.qty,
      extra_params: order.extra_params,
      your_price: order.your_price,
      supplier_price: order.supplier_price,
      status: order.status,
      supplier_order_id: order.supplier_order_id,
    })
    .select()
    .single();
  throwIfError(error, 'createOrder');
  return data;
}

async function getOrderByClientRequest(userId, clientRequestId) {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('user_id', userId)
    .eq('client_request_id', clientRequestId)
    .maybeSingle();
  throwIfError(error, 'getOrderByClientRequest');
  return data;
}

async function getOrderByUuid(orderUuid) {
  const { data, error } = await supabase.from('orders').select('*').eq('order_uuid', orderUuid).maybeSingle();
  throwIfError(error, 'getOrderByUuid');
  return data;
}

async function updateOrder(orderUuid, patch) {
  const { data, error } = await supabase
    .from('orders')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('order_uuid', orderUuid)
    .select()
    .maybeSingle();
  throwIfError(error, 'updateOrder');
  return data;
}

async function listOrdersByStatus(status) {
  const { data, error } = await supabase.from('orders').select('*').eq('status', status);
  throwIfError(error, 'listOrdersByStatus');
  return data || [];
}

async function listOrdersByStatuses(statuses) {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .in('status', statuses);
  throwIfError(error, 'listOrdersByStatuses');
  return data || [];
}

async function listOrdersByUser(userId) {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  throwIfError(error, 'listOrdersByUser');
  return data || [];
}

module.exports = {
  upsertProducts,
  getProduct,
  listProducts,
  createOrder,
  getOrderByClientRequest,
  getOrderByUuid,
  updateOrder,
  listOrdersByStatus,
  listOrdersByStatuses,
  listOrdersByUser,
  createUser,
  getUserByEmail,
  getUserById,
  updateUser,
  getAppSettings,
  debitWallet,
  creditWallet,
};
