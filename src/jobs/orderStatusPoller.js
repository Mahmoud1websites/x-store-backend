/**
 * orderStatusPoller.js
 *
 * The supplier can return status "wait" on newOrder — meaning the
 * order isn't resolved yet. This job periodically rechecks every
 * locally "wait" order so the user's app can show the real final
 * status without needing to poll the supplier directly itself.
 *
 * Start this from app.js with startOrderStatusPoller().
 */

const store = require('../db/db');
const orderService = require('../services/orderService');

let intervalHandle = null;

async function pollOnce() {
  const waitingOrders = await store.listOrdersByStatus('wait');
  if (waitingOrders.length === 0) return;

  console.log(`[orderStatusPoller] rechecking ${waitingOrders.length} waiting order(s)`);
  for (const order of waitingOrders) {
    try {
      const updated = await orderService.recheckOrder(order.order_uuid);
      if (updated.status !== 'wait') {
        console.log(`[orderStatusPoller] order ${order.order_uuid} resolved -> ${updated.status}`);
      }
    } catch (err) {
      console.error(`[orderStatusPoller] failed to recheck ${order.order_uuid}:`, err.message);
    }
  }
}

function startOrderStatusPoller() {
  const intervalMs = Number(process.env.ORDER_POLL_INTERVAL_MS || 60000);
  if (intervalHandle) return; // already running
  intervalHandle = setInterval(pollOnce, intervalMs);
  console.log(`[orderStatusPoller] started, interval=${intervalMs}ms`);
}

function stopOrderStatusPoller() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = { startOrderStatusPoller, stopOrderStatusPoller, pollOnce };
