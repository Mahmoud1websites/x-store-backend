const express = require('express');
const router = express.Router();
const orderService = require('../services/orderService');
const requireAuth = require('../middleware/requireAuth');
const adminService = require('../services/adminService');

// All order routes require a logged-in user.
router.use(requireAuth);

// GET /api/orders - order history for the logged-in user, most recent first
router.get('/', async (req, res) => {
  try {
    const orders = await orderService.listOrdersForUser(req.user.id);
    res.json({ status: 'OK', data: orders });
  } catch (err) {
    res.status(502).json({ status: 'ERROR', message: err.message });
  }
});

/**
 * POST /api/orders
 * body: { productId, qty, extraParams }
 *
 * userId now comes from req.user (set by requireAuth from the JWT),
 * never from the request body — the client can no longer place an
 * order "as" another user by editing the request.
 */
router.post('/', async (req, res) => {
  const { productId, qty, extraParams } = req.body;
  if (!productId || !qty) {
    return res.status(400).json({ status: 'ERROR', message: 'productId and qty are required' });
  }
  try {
    const settings = await adminService.getPublicSettings();
    if (settings.maintenance_mode || !settings.allow_orders) {
      return res.status(503).json({
        status: 'ERROR',
        code: 'ORDERS_PAUSED',
        message: 'New orders are temporarily paused',
      });
    }
    const order = await orderService.placeOrder({ userId: req.user.id, productId, qty, extraParams });
    res.json({ status: 'OK', data: order });
  } catch (err) {
    const statusCode = err.code ? 400 : 502;
    res.status(statusCode).json({ status: 'ERROR', code: err.code, message: err.message });
  }
});

// GET /api/orders/:orderUuid - recheck & return current status
router.get('/:orderUuid', async (req, res) => {
  try {
    const order = await orderService.recheckOrder(req.params.orderUuid);
    // Make sure users can only check their own orders.
    if (order.user_id !== req.user.id) {
      return res.status(404).json({ status: 'ERROR', code: 'ORDER_NOT_FOUND', message: 'Order not found' });
    }
    res.json({ status: 'OK', data: order });
  } catch (err) {
    const statusCode = err.code === 'ORDER_NOT_FOUND' ? 404 : 502;
    res.status(statusCode).json({ status: 'ERROR', code: err.code, message: err.message });
  }
});

module.exports = router;
