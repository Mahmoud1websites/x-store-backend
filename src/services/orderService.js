/**
 * orderService.js
 *
 * Owns the full lifecycle of a single order. Three fulfillment paths,
 * chosen by the product being ordered:
 *
 *   1. product_type === 'manual'            -> pending_manual, admin
 *      (Shahid, Netflix, etc.)                 attaches credentials later
 *
 *   2. supplier_source === 'topupapp'        -> rechargeApi (MTC/Alfa
 *      (mobile recharges)                       direct recharge by phone)
 *
 *   3. everything else (default/'kamal_cell')-> supplierApi (Kamal Cell,
 *                                                original supplier flow)
 *
 * Shared steps for paths 2 and 3:
 *   - Validate product + quantity against local catalog
 *   - Generate a UUIDv4 order_uuid (our idempotency key)
 *   - Persist a local pending row BEFORE calling the supplier (so a
 *     crash mid-call doesn't lose the record)
 *   - Call the relevant supplier's newOrder()
 *   - Persist the resulting status (accept / reject / wait)
 *   - On reject -> refund the wallet through an idempotent database function
 *
 * Wallet debits/refunds are performed by locked Postgres functions.
 * Each order event has a unique ledger key so retries cannot debit or
 * refund the customer twice.
 *
 * NOTE on TopUpApp: their API has no client-supplied idempotency key, so
 * duplicate-order protection for those orders (like all orders here)
 * relies entirely on our own clientRequestId / getOrderByClientRequest
 * check below — never on anything TopUpApp returns.
 */

const crypto = require('crypto');
const supplierApi = require('./supplierApi');
const rechargeApi = require('./rechargeApi');
const catalogService = require('./catalogService');
const pricingService = require('./pricingService');
const store = require('../db/db');
const notifications = require('./notificationService');

async function debitHook(userId, amount, reason) {
  return store.debitWallet(userId, amount, reason);
}

async function refundHook(userId, amount, reason) {
  return store.creditWallet(userId, amount, reason);
}

const refundReason = (orderUuid) => `order:${orderUuid}:refund`;

async function refundOrder(order) {
  if (order.refunded_at) return order;
  await refundHook(order.user_id, order.your_price, refundReason(order.order_uuid));
  return store.updateOrder(order.order_uuid, {
    refunded_at: new Date().toISOString(),
  });
}

/**
 * Pulls a phone number out of the customer's submitted extra fields for
 * TopUpApp direct-recharge orders. The mobile app renders one text input
 * per entry in product.params, so we accept a few common labels rather
 * than forcing one exact string in Supabase.
 */
function extractPhoneNumber(extraParams = {}) {
  const candidates = ['Phone Number', 'phone_number', 'Phone', 'phone', 'Number', 'number'];
  for (const key of candidates) {
    if (extraParams[key]) return String(extraParams[key]).trim();
  }
  return null;
}

/**
 * Places a new order for a user.
 *
 * @param {Object} args
 * @param {string} args.userId
 * @param {number|string} args.productId - supplier product id
 * @param {number} args.qty
 * @param {Object} [args.extraParams] - e.g. { playerId: '12345' } or { 'Phone Number': '03123456' }
 */
async function placeOrder({
  userId,
  productId,
  qty,
  extraParams = {},
  clientRequestId = crypto.randomUUID(),
}) {
  const normalizedRequestId = String(clientRequestId).trim();
  if (!normalizedRequestId || normalizedRequestId.length > 120) {
    throw Object.assign(new Error('Invalid checkout request identifier'), {
      code: 'INVALID_CHECKOUT_REQUEST',
    });
  }

  const existingOrder = await store.getOrderByClientRequest(userId, normalizedRequestId);
  if (existingOrder) return existingOrder;

  const product = await catalogService.getProductOrThrow(productId);
  const customer = await store.getUserById(userId);
  if (!customer || customer.disabled) {
    throw Object.assign(new Error('Customer account is unavailable'), {
      code: 'CUSTOMER_UNAVAILABLE',
    });
  }
  catalogService.validateProductForSale(product);
  catalogService.validateQty(product, qty);
  const validatedParams = catalogService.validateExtraParams(product, extraParams);

  // Manual products (e.g. Shahid, Netflix) have no supplier integration.
  // Payment is collected the same way, but fulfillment is done by an
  // admin who manually sends the account credentials afterward.
  const isManual = product.product_type === 'manual';
  const supplierSource = product.supplier_source || 'kamal_cell';
  const isTopUpApp = !isManual && supplierSource === 'topupapp';

  let phoneNumber = null;
  if (isTopUpApp) {
    phoneNumber = extractPhoneNumber(validatedParams);
    if (!phoneNumber) {
      throw Object.assign(new Error('A phone number is required for this recharge'), {
        code: 'PHONE_NUMBER_REQUIRED',
      });
    }
  }

  const orderUuid = crypto.randomUUID();
  const effectivePrice = pricingService.priceForCustomer(
    product,
    customer.customer_type,
  );
  const yourPrice = Number(effectivePrice.unit_price) * Number(qty);
  if (!Number.isFinite(yourPrice) || yourPrice <= 0) {
    throw Object.assign(new Error('Product price is invalid'), { code: 'INVALID_PRODUCT_PRICE' });
  }

  // Create the idempotent order record before charging the wallet. A
  // database unique index allows only one order per client request.
  let order;
  try {
    order = await store.createOrder({
      order_uuid: orderUuid,
      client_request_id: normalizedRequestId,
      user_id: userId,
      product_id: productId,
      qty,
      extra_params: validatedParams,
      your_price: yourPrice,
      supplier_price: Number(product.supplier_price) * Number(qty),
      customer_type: effectivePrice.customer_type,
      unit_price: effectivePrice.unit_price,
      status: 'payment_pending',
      supplier_order_id: null,
      supplier_source: isManual ? null : supplierSource,
    });
  } catch (error) {
    if (error.code === '23505') {
      const duplicate = await store.getOrderByClientRequest(userId, normalizedRequestId);
      if (duplicate) return duplicate;
    }
    throw error;
  }

  try {
    await debitHook(userId, yourPrice, `order:${orderUuid}`);
    order = await store.updateOrder(orderUuid, {
      status: isManual ? 'pending_manual' : 'pending_supplier',
      wallet_debited_at: new Date().toISOString(),
    });
  } catch (error) {
    await store.updateOrder(orderUuid, {
      status: 'payment_failed',
      error_message: error.message,
    });
    throw error;
  }

  // Manual products stop here. There is no supplier call to make — an
  // admin will review the order in the dashboard and attach credentials,
  // which moves the order to "fulfilled" (see admin order update route).
  if (isManual) {
    await notifications.notifyOrder(order).catch((notificationError) => {
      console.error('[orderService] manual order updated but notification failed:', notificationError.message);
    });
    return order;
  }

  let result;
  try {
    if (isTopUpApp) {
      result = await rechargeApi.newOrder({
        productId: product.provider_product_id,
        qty,
        orderUuid,
        isDirectRecharge: true,
        phoneNumber,
      });

    } else {
      result = await supplierApi.newOrder({
        productId,
        qty,
        orderUuid,
        extraParams: validatedParams,
      });
    }
  } catch (err) {
    // Network/unexpected failure talking to the supplier: leave the order
    // as pending_supplier. It is SAFE to retry with the same orderUuid
    // for Kamal Cell, since it de-dupes on order_uuid. TopUpApp has no
    // such dedupe, so a retry job must not blindly resubmit TopUpApp
    // orders — see jobs/orderStatusPoller.js, which only rechecks status
    // and never resubmits.
    return store.updateOrder(orderUuid, {
      status: 'supplier_call_failed',
      error_message: err.message,
    });
  }

  const supplierStatus = result.data.status; // accept | reject | wait
  if (!['accept', 'reject', 'wait'].includes(supplierStatus)) {
    return store.updateOrder(orderUuid, {
      status: 'supplier_call_failed',
      error_message: 'Supplier returned an unknown order status',
    });
  }
  let updated = await store.updateOrder(orderUuid, {
    status: supplierStatus,
    supplier_order_id: result.data.order_id,
    supplier_response: result.data,
  });

  if (supplierStatus === 'reject') {
    updated = await refundOrder(updated);
  }

  await notifications.notifyOrder(updated).catch((notificationError) => {
    console.error('[orderService] order updated but notification failed:', notificationError.message);
  });

  return updated;
}

/**
 * Re-checks a single order against the relevant supplier and updates
 * local status. Used by both a manual "check my order" endpoint and the
 * background poller.
 *
 * Manual orders (pending_manual / fulfilled) have no supplier order to
 * check, so they are returned as-is. Kamal Cell and TopUpApp orders are
 * routed to their respective API clients based on order.supplier_source.
 */
async function recheckOrder(orderUuid, userId = null) {
  let order = await store.getOrderByUuid(orderUuid);
  if (!order) {
    const err = new Error(`Order ${orderUuid} not found locally`);
    err.code = 'ORDER_NOT_FOUND';
    throw err;
  }
  if (userId && String(order.user_id) !== String(userId)) {
    const err = new Error('Order not found');
    err.code = 'ORDER_NOT_FOUND';
    throw err;
  }
  if (['accept', 'reject', 'payment_failed', 'pending_manual', 'fulfilled'].includes(order.status)) {
    return order;
  }

  const isTopUpApp = order.supplier_source === 'topupapp';

  let supplierOrder;
  try {
    if (isTopUpApp) {
      // TopUpApp only supports lookup by its own numeric order id — no
      // "check by our UUID" fallback exists like Kamal Cell has.
      if (!order.supplier_order_id) return order;
      const result = await rechargeApi.checkOrders([order.supplier_order_id]);
      supplierOrder = result.data[0];
    } else {
      // Prefer checking by our own UUID if we never got a supplier order_id
      // back (e.g. previous call failed before we recorded it).
      const useUuid = !order.supplier_order_id;
      const idToCheck = useUuid ? order.order_uuid : order.supplier_order_id;
      const result = await supplierApi.checkOrders([idToCheck], useUuid);
      supplierOrder = result.data[0];
    }
  } catch (err) {
    console.error(`[orderService] recheck failed for ${orderUuid}:`, err.message);
    return order;
  }

  if (!supplierOrder) return order; // nothing to update yet
  if (!['accept', 'reject', 'wait'].includes(supplierOrder.status)) return order;

  const previousStatus = order.status;
  let updated = await store.updateOrder(orderUuid, {
    status: supplierOrder.status,
    supplier_order_id: supplierOrder.order_id,
    error_message: null,
  });

  if (supplierOrder.status === 'reject') {
    updated = await refundOrder(updated);
  }

  if (updated.status !== previousStatus) {
    await notifications.notifyOrder(updated).catch((notificationError) => {
      console.error('[orderService] order updated but notification failed:', notificationError.message);
    });
  }

  return updated;
}

module.exports = {
  placeOrder,
  recheckOrder,
  listOrdersForUser: (userId) => store.listOrdersByUser(userId),
};