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

// Some suppliers send a generic/incorrect field label (e.g. "Phone Number")
// for products that actually need a game Player ID. Override by keyword
// match against the category or product name, regardless of what the
// supplier sends, so the checkout screen shows the right field.
const PARAM_LABEL_OVERRIDES = [
  { match: /pubg/i, params: ['Player ID'] },
  { match: /free ?fire/i, params: ['Player ID'] },
  { match: /mobile legends/i, params: ['User ID', 'Zone ID'] },
  // add more game categories here as needed
];

function resolveParams(p) {
  const haystack = `${p.category_name || ''} ${p.name || ''}`;
  const override = PARAM_LABEL_OVERRIDES.find((rule) => rule.match.test(haystack));
  return override ? override.params : p.params;
}

// ---- Users ----

async function createUser({
  id,
  email = null,
  passwordHash,
  phoneE164 = null,
  authProvider = 'password',
  googleSub = null,
  displayName = null,
  emailVerified = false,
  phoneVerified = false,
}) {
  const row = {
    id,
    email,
    password_hash: passwordHash,
    phone_e164: phoneE164,
    auth_provider: authProvider,
    google_sub: googleSub,
    display_name: displayName,
    email_verified: Boolean(emailVerified),
    email_verified_at: emailVerified ? new Date().toISOString() : null,
    phone_verified_at: phoneVerified ? new Date().toISOString() : null,
  };
  const { data, error } = await supabase
    .from('users')
    .insert(row)
    .select()
    .single();
  throwIfError(error, 'createUser');
  return data;
}

async function getUserByEmail(email) {
  if (!email) return null;
  // .ilike without wildcards = exact match, case-insensitive.
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .ilike('email', email)
    .maybeSingle();
  throwIfError(error, 'getUserByEmail');
  return data;
}

async function getUserByPhone(phoneE164) {
  if (!phoneE164) return null;
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('phone_e164', phoneE164)
    .maybeSingle();
  throwIfError(error, 'getUserByPhone');
  return data;
}

async function getUserByGoogleSub(googleSub) {
  if (!googleSub) return null;
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('google_sub', googleSub)
    .maybeSingle();
  throwIfError(error, 'getUserByGoogleSub');
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

async function invalidateAuthTokens(userId, purpose) {
  const { error } = await supabase
    .from('auth_tokens')
    .update({ used_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('purpose', purpose)
    .is('used_at', null);
  throwIfError(error, 'invalidateAuthTokens');
}

async function createAuthToken({ userId, purpose, tokenHash, expiresAt }) {
  await invalidateAuthTokens(userId, purpose);
  const { data, error } = await supabase
    .from('auth_tokens')
    .insert({
      user_id: userId,
      purpose,
      token_hash: tokenHash,
      expires_at: expiresAt,
    })
    .select()
    .single();
  throwIfError(error, 'createAuthToken');
  return data;
}

async function getAuthToken({ userId, purpose, tokenHash }) {
  const { data, error } = await supabase
    .from('auth_tokens')
    .select('*')
    .eq('user_id', userId)
    .eq('purpose', purpose)
    .eq('token_hash', tokenHash)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  throwIfError(error, 'getAuthToken');
  return data;
}

async function getActiveAuthToken({ userId, purpose }) {
  const { data, error } = await supabase
    .from('auth_tokens')
    .select('*')
    .eq('user_id', userId)
    .eq('purpose', purpose)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  throwIfError(error, 'getActiveAuthToken');
  return data;
}

async function incrementAuthTokenAttempts(id, currentAttempts = 0) {
  const { error } = await supabase
    .from('auth_tokens')
    .update({ failed_attempts: Number(currentAttempts || 0) + 1 })
    .eq('id', id);
  throwIfError(error, 'incrementAuthTokenAttempts');
}

async function consumeAuthToken(id) {
  const { data, error } = await supabase
    .from('auth_tokens')
    .update({ used_at: new Date().toISOString() })
    .eq('id', id)
    .is('used_at', null)
    .select('id')
    .maybeSingle();
  throwIfError(error, 'consumeAuthToken');
  if (!data) {
    throw Object.assign(new Error('The security code is invalid or expired'), {
      code: 'INVALID_OR_EXPIRED_CODE',
      status: 400,
    });
  }
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
    .select('supplier_product_id,your_price,reseller_price,image_url,price_overridden,image_overridden,is_listed,archived,pricing_mode,custom_markup_percent')
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
      supplier_category_id:
        Number.isFinite(Number(p.parent_id)) && Number(p.parent_id) > 0
          ? Number(p.parent_id)
          : null,
      name: p.name,
      category_name: p.category_name,
      category_img: p.category_img || null,
      image_url: existing.image_url ?? null,
      image_overridden: existing.image_overridden ?? false,
      archived: existing.archived ?? false,
      supplier_price: p.supplier_price,
      supplier_price_updated_at: now,
      your_price: customerPrice,
      // Supplier sync never overwrites the administrator's reseller price.
      // New products safely start at the retail price until it is customized.
      reseller_price: existing.reseller_price ?? customerPrice,
      pricing_mode: pricingMode,
      custom_markup_percent: pricingMode === pricingService.PRICING_MODES.PERCENTAGE
        ? existing.custom_markup_percent
        : null,
      price_overridden: pricingMode !== pricingService.PRICING_MODES.GLOBAL,
      product_type: p.product_type,
      qty_values: p.qty_values,
      params: resolveParams(p),
      is_listed: existing.is_listed ?? false,
      available: existing.archived ? false : p.available,
      updated_at: now,
    };
  });
  const safeRows = rows.map((row) => ({
    ...row,
    image_overridden: row.image_overridden ?? false,
    price_overridden: row.price_overridden ?? false,
    is_listed: row.is_listed ?? false,
    archived: row.archived ?? false,
  }));
  const { data, error } = await supabase
    .from('products')
    .upsert(safeRows, { onConflict: 'supplier_product_id' })
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
      customer_type: order.customer_type || 'retail',
      unit_price: order.unit_price,
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
  getUserByPhone,
  getUserByGoogleSub,
  getUserById,
  updateUser,
  createAuthToken,
  getAuthToken,
  getActiveAuthToken,
  incrementAuthTokenAttempts,
  consumeAuthToken,
  invalidateAuthTokens,
  getAppSettings,
  debitWallet,
  creditWallet,
};
