const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const authService = require('../services/authService');
const requireAuth = require('../middleware/requireAuth');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

// GET /api/auth/me - returns the current logged-in user's data (fresh from DB)
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await authService.getMe(req.user.id);
    res.json({ status: 'OK', data: user });
  } catch (err) {
    res.status(404).json({ status: 'ERROR', code: err.code, message: err.message });
  }
});

// POST /api/auth/register - body: { email, password }
router.post('/register', authLimiter, async (req, res) => {
  try {
    const result = await authService.register(req.body);
    res.json({ status: 'OK', data: result });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', code: err.code, message: err.message });
  }
});

// POST /api/auth/login - body: { email, password }
router.post('/login', authLimiter, async (req, res) => {
  try {
    const result = await authService.login(req.body);
    res.json({ status: 'OK', data: result });
  } catch (err) {
    res.status(401).json({ status: 'ERROR', code: err.code, message: err.message });
  }
});

module.exports = router;
