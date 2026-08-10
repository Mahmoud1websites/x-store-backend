const express = require('express');
const router = express.Router();
const catalogService = require('../services/catalogService');
const requireAuth = require('../middleware/requireAuth');
const requireAdmin = require('../middleware/requireAdmin');

// GET /api/products - list what the app should show to users
router.get('/', async (req, res) => {
  try {
    const products = await catalogService.listAvailableProducts();
    res.json({ status: 'OK', data: products });
  } catch (err) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

// POST /api/products/sync - admin/cron endpoint to pull latest catalog from supplier
router.post('/sync', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await catalogService.syncCatalog();
    res.json({ status: 'OK', ...result });
  } catch (err) {
    res.status(502).json({ status: 'ERROR', message: err.message });
  }
});

module.exports = router;
