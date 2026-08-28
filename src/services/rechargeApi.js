/**
 * rechargeApi.js
 *
 * Thin client for the TopUpApp B2B API (MTC/Alfa mobile recharges).
 * Mirrors the shape of supplierApi.js so orderService/catalogService can
 * treat both suppliers uniformly, but note two real differences from
 * Kamal Cell:
 *
 *   1. Status vocabulary differs: TopUpApp returns pending/completed/failed
 *      instead of accept/reject/wait. mapStatus() below translates their
 *      status into our internal vocabulary so the rest of the app (order
 *      poller, notifications, admin dashboard) doesn't need to know two
 *      different status languages.
 *
 *   2. TopUpApp has no client-supplied idempotency key (no order_uuid
 *      equivalent accepted on their side). Duplicate-order protection is
 *      handled entirely by orderService's existing clientRequestId /
 *      getOrderByClientRequest check BEFORE this module is ever called —
 *      do not rely on TopUpApp's `reference` field for dedupe.
 */

const axios = require('axios');

const BASE_URL = process.env.RECHARGE_API_BASE_URL || 'https://topupapp.net/api/v2/b2b';
const API_TOKEN = process.env.RECHARGE_API_TOKEN;

const client = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
  headers: {
    Authorization: `Bearer ${API_TOKEN}`,
    'X-Currency': 'USD',
  },
});

function wrapError(error, context) {
  const status = error.response?.status;
  const message = error.response?.data?.message
    || error.response?.data?.error
    || error.message
    || 'Recharge API request failed';
  const wrapped = new Error(`[rechargeApi] ${context}: ${message}`);
  wrapped.status = status || 502;
  wrapped.code = status === 401 || status === 403
    ? 'RECHARGE_AUTH_FAILED'
    : status === 429
      ? 'RECHARGE_RATE_LIMITED'
      : 'RECHARGE_API_ERROR';
  wrapped.providerStatus = status;
  return wrapped;
}

/**
 * Translates TopUpApp's status vocabulary into ours.
 *   pending / processing  -> wait
 *   completed             -> accept
 *   failed / cancelled    -> reject
 * Anything unrecognized passes through as 'wait' so an unexpected status
 * never gets silently treated as success or failure.
 */
function mapStatus(providerStatus) {
  const normalized = String(providerStatus || '').toLowerCase();
  if (normalized === 'completed') return 'accept';
  if (['failed', 'cancelled', 'canceled', 'rejected'].includes(normalized)) return 'reject';
  return 'wait'; // pending, processing, or anything unrecognized
}

async function getBalance() {
  try {
    const { data } = await client.get('/balance');
    return data.data;
  } catch (error) {
    throw wrapError(error, 'get balance');
  }
}

// Kept as getProfile() to match supplierApi.js's interface used by
// adminService.getSupplierStatus() / getOverview() health checks.
async function getProfile() {
  return getBalance();
}

async function listProducts({ categoryId, subcategoryId, regionId, search, currency = 'USD' } = {}) {
  try {
    const { data } = await client.get('/products', {
      headers: { 'X-Currency': currency },
      params: {
        category_id: categoryId,
        subcategory_id: subcategoryId,
        region_id: regionId,
        search,
      },
    });
    return data.data;
  } catch (error) {
    throw wrapError(error, 'list products');
  }
}

async function getProduct(productId, { thirdpartyId, currency = 'USD' } = {}) {
  try {
    const { data } = await client.get(`/products/${productId}`, {
      headers: { 'X-Currency': currency },
      params: { thirdparty_id: thirdpartyId },
    });
    return data.data;
  } catch (error) {
    throw wrapError(error, 'get product');
  }
}

/**
 * Places a new recharge order.
 *
 * @param {Object} args
 * @param {number|string} args.productId
 * @param {number} [args.qty=1] - must be 1 when isDirectRecharge is true
 * @param {string} [args.orderUuid] - stored as `reference` for your own
 *   traceability; NOT relied on for dedupe (see file header note)
 * @param {boolean} [args.isDirectRecharge]
 * @param {string} [args.phoneNumber] - required when isDirectRecharge is true
 * @param {Object} [args.requiredFields] - product-specific required fields
 * @param {string} [args.currency='USD']
 */
async function newOrder({
  productId,
  qty = 1,
  orderUuid,
  isDirectRecharge = false,
  phoneNumber,
  requiredFields,
  currency = 'USD',
}) {
  if (isDirectRecharge && !phoneNumber) {
    const error = new Error('[rechargeApi] phone number is required for direct recharge orders');
    error.code = 'RECHARGE_PHONE_REQUIRED';
    error.status = 400;
    throw error;
  }
  if (isDirectRecharge && Number(qty) !== 1) {
    const error = new Error('[rechargeApi] quantity must be 1 for direct recharge orders');
    error.code = 'RECHARGE_INVALID_QTY';
    error.status = 400;
    throw error;
  }

  const payload = {
    type: 'cartless',
    product_id: Number(productId),
    quantity: Number(qty),
    reference: orderUuid,
  };
  if (isDirectRecharge) {
    payload.direct_recharge = true;
    payload.direct_recharge_phone_number = phoneNumber;
  }
  if (requiredFields && Object.keys(requiredFields).length) {
    payload.required_fields = requiredFields;
  }

  try {
    const { data } = await client.post('/orders', payload, {
      headers: { 'X-Currency': currency },
    });
    const order = data.data;
    return {
      data: {
        status: mapStatus(order.status),
        provider_status: order.status,
        order_id: order.id,
        order_number: order.order_number,
        final_amount: order.final_amount,
        direct_recharge: order.direct_recharge || null,
      },
    };
  } catch (error) {
    throw wrapError(error, 'create order');
  }
}

/**
 * Checks one or more orders by TopUpApp's own order id.
 * Unlike supplierApi.checkOrders, there is no "check by our UUID" mode —
 * TopUpApp only supports lookup by its own numeric order id, so orderUuid
 * must already have been recorded from the newOrder() response.
 *
 * @param {Array<number|string>} orderIds - TopUpApp order ids
 */
async function checkOrders(orderIds) {
  try {
    const results = await Promise.all(
      orderIds.map(async (id) => {
        const { data } = await client.get(`/orders/${id}`);
        const order = data.data;
        return {
          order_id: order.id,
          status: mapStatus(order.status),
          provider_status: order.status,
          direct_recharge: order.direct_recharge || null,
        };
      }),
    );
    return { data: results };
  } catch (error) {
    throw wrapError(error, 'check orders');
  }
}

module.exports = {
  getBalance,
  getProfile,
  listProducts,
  getProduct,
  newOrder,
  checkOrders,
  mapStatus,
};