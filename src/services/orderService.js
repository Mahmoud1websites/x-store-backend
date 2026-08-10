/**
 * orderService.js
 *
 * Owns the full lifecycle of a single order:
 *   1. Validate product + quantity against local catalog
 *   2. Generate a UUIDv4 order_uuid (our idempotency key)
 *   3. Persist a local "pending_supplier" order row BEFORE calling
 *      the supplier (so a crash mid-call doesn't lose the record)
 *   4. Call supplier newOrder()
 *   5. Persist the resulting status (accept / reject / wait)
 *   6. On reject -> refund the wallet through an idempotent database function
 *
 * Wallet debits/refunds are performed by locked Postgres functions.
 * Each order event has a unique ledger key so retries cannot debit or
 * refund the customer twice.
 */

const crypto = require('crypto');
const supplierApi = require('./supplierApi');
const catalogService = require('./catalogService');
const store = require('../db/db');

async function debitHook(userId, amount, reason) {
  return store.debitWallet(userId, amount, reason);
}

async function refundHook(userId, amount, reason) {
  return store.creditWallet(userId, amount, reason);
}

/**
 * Places a new order for a user.
 *
 * @param {Object} args
 * @param {string} args.userId
 * @param {number|string} args.productId - supplier product id
 * @param {number} args.qty
 * @param {Object} [args.extraParams] - e.g. { playerId: '12345' }
 */
async function placeOrder({ userId, productId, qty, extraParams = {} }) {
  const product = await catalogService.getProductOrThrow(productId);
  catalogService.validateQty(product, qty);

  const orderUuid = crypto.randomUUID();
  const yourPrice = Number(product.your_price) * Number(qty);

  // Debit wallet BEFORE calling supplier so we never fulfill an order
  // the user hasn't paid for. If this throws (insufficient balance),
  // we stop here and never call the supplier.
  await debitHook(userId, yourPrice, `order:${orderUuid}`);

  // Persist locally first — this row is our source of truth even if
  // the network call to the supplier below fails or times out.
  try {
    await store.createOrder({
      order_uuid: orderUuid,
      user_id: userId,
      product_id: productId,
      qty,
      extra_params: extraParams,
      your_price: yourPrice,
      supplier_price: Number(product.supplier_price) * Number(qty),
      status: 'pending_supplier',
      supplier_order_id: null,
    });
  } catch (error) {
    await refundHook(userId, yourPrice, `order:${orderUuid}:persistence_refund`);
    throw error;
  }

  let result;
  try {
    result = await supplierApi.newOrder({
      productId,
      qty,
      orderUuid,
      extraParams,
    });
  } catch (err) {
    // Network/unexpected failure talking to supplier: leave the order
    // as pending_supplier. It is SAFE to retry placeOrder-equivalent
    // calls with the same orderUuid via supplierApi.newOrder directly,
    // since the supplier de-dupes on order_uuid. A retry job should
    // pick these up (see jobs/orderStatusPoller.js).
    await store.updateOrder(orderUuid, { status: 'supplier_call_failed', error: err.message });
    throw err;
  }

  const supplierStatus = result.data.status; // accept | reject | wait
  const updated = await store.updateOrder(orderUuid, {
    status: supplierStatus,
    supplier_order_id: result.data.order_id,
    supplier_response: result.data,
  });

  if (supplierStatus === 'reject') {
    await refundHook(userId, yourPrice, `order:${orderUuid}:rejected`);
  }

  return updated;
}

/**
 * Re-checks a single order against the supplier and updates local status.
 * Used by both a manual "check my order" endpoint and the background poller.
 */
async function recheckOrder(orderUuid) {
  const order = await store.getOrderByUuid(orderUuid);
  if (!order) {
    const err = new Error(`Order ${orderUuid} not found locally`);
    err.code = 'ORDER_NOT_FOUND';
    throw err;
  }

  // Prefer checking by our own UUID if we never got a supplier order_id
  // back (e.g. previous call failed before we recorded it).
  const useUuid = !order.supplier_order_id;
  const idToCheck = useUuid ? order.order_uuid : order.supplier_order_id;

  const result = await supplierApi.checkOrders([idToCheck], useUuid);
  const supplierOrder = result.data[0];
  if (!supplierOrder) return order; // nothing to update yet

  const wasWait = order.status === 'wait';
  const updated = await store.updateOrder(orderUuid, {
    status: supplierOrder.status,
    supplier_order_id: supplierOrder.order_id,
  });

  if (wasWait && supplierOrder.status === 'reject') {
    await refundHook(order.user_id, order.your_price, `order:${orderUuid}:rejected_on_recheck`);
  }

  return updated;
}

module.exports = {
  placeOrder,
  recheckOrder,
  listOrdersForUser: (userId) => store.listOrdersByUser(userId),
};
