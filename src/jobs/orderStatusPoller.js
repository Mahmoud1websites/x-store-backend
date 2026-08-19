/**
 * Periodically rechecks supplier orders whose status is "wait".
 */

const store = require('../db/db');
const orderService = require('../services/orderService');

let intervalHandle = null;
let pollInProgress = false;

async function pollOnce() {
  if (pollInProgress) {
    console.log('[orderStatusPoller] previous poll is still running; skipped');
    return;
  }

  pollInProgress = true;

  try {
    // Only supplier orders explicitly waiting for a final result.
    const orders = await store.listOrdersByStatuses(['wait']);

    // An order cannot be checked without a supplier order ID.
    const waitingOrders = orders.filter(
      (order) => Boolean(order.supplier_order_id)
    );

    const missingSupplierId = orders.filter(
      (order) => !order.supplier_order_id
    );

    for (const order of missingSupplierId) {
      console.warn(
        `[orderStatusPoller] skipped ${order.order_uuid}: missing supplier_order_id`
      );
    }

    if (waitingOrders.length === 0) return;

    console.log(
      `[orderStatusPoller] rechecking ${waitingOrders.length} waiting order(s)`
    );

    for (const order of waitingOrders) {
      try {
        const updated = await orderService.recheckOrder(order.order_uuid);

        if (updated.status === 'wait') {
          console.log(
            `[orderStatusPoller] order ${order.order_uuid} is still waiting`
          );
        } else {
          console.log(
            `[orderStatusPoller] order ${order.order_uuid} resolved -> ${updated.status}`
          );
        }
      } catch (error) {
        console.error(
          `[orderStatusPoller] failed to recheck ${order.order_uuid}:`,
          error.message
        );
      }
    }
  } catch (error) {
    console.error(
      '[orderStatusPoller] database connection failed:',
      error.message
    );
  } finally {
    pollInProgress = false;
  }
}

function startOrderStatusPoller() {
  const intervalMs = Number(
    process.env.ORDER_POLL_INTERVAL_MS || 60000
  );

  if (intervalHandle) return;

  intervalHandle = setInterval(pollOnce, intervalMs);

  console.log(
    `[orderStatusPoller] started, interval=${intervalMs}ms`
  );
}

function stopOrderStatusPoller() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = {
  startOrderStatusPoller,
  stopOrderStatusPoller,
  pollOnce,
};