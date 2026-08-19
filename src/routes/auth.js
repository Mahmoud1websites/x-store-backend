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
const codeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

router.get('/providers', (req, res) => {
  res.json({ status: 'OK', data: authService.providerAvailability() });
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
    res.status(201).json({ status: 'OK', data: result });
  } catch (err) {
    res.status(err.status || 400).json({ status: 'ERROR', code: err.code, message: err.message });
  }
});

// POST /api/auth/request-email-verification - body: { email }
router.post('/request-email-verification', codeLimiter, async (req, res) => {
  try {
    const result = await authService.requestEmailVerification(req.body);
    res.json({ status: 'OK', data: result });
  } catch (err) {
    res.status(err.status || 400).json({ status: 'ERROR', code: err.code, message: err.message });
  }
});

// POST /api/auth/verify-email - body: { email, code }
router.post('/verify-email', codeLimiter, async (req, res) => {
  try {
    const result = await authService.verifyEmail(req.body);
    res.json({ status: 'OK', data: result });
  } catch (err) {
    res.status(err.status || 400).json({ status: 'ERROR', code: err.code, message: err.message });
  }
});

// POST /api/auth/login - body: { email, password }
router.post('/login', authLimiter, async (req, res) => {
  try {
    const result = await authService.login(req.body);
    res.json({ status: 'OK', data: result });
  } catch (err) {
    res.status(err.status || 401).json({ status: 'ERROR', code: err.code, message: err.message });
  }
});

// Google ID tokens are issued by Google's native OAuth flow, then verified
// again by this backend. Client-provided profile information is never trusted.
router.post('/google', authLimiter, async (req, res) => {
  try {
    const result = await authService.googleLogin(req.body || {});
    res.json({ status: 'OK', data: result });
  } catch (err) {
    res.status(err.status || 401).json({ status: 'ERROR', code: err.code, message: err.message });
  }
});

router.post('/phone/request', codeLimiter, async (req, res) => {
  try {
    const result = await authService.requestPhoneLogin(req.body || {});
    res.json({ status: 'OK', data: result });
  } catch (err) {
    res.status(err.status || 400).json({ status: 'ERROR', code: err.code, message: err.message });
  }
});

router.post('/phone/verify', authLimiter, async (req, res) => {
  try {
    const result = await authService.verifyPhoneLogin(req.body || {});
    res.json({ status: 'OK', data: result });
  } catch (err) {
    res.status(err.status || 400).json({ status: 'ERROR', code: err.code, message: err.message });
  }
});

// These endpoints intentionally return generic request messages so callers
// cannot discover whether a customer email exists.
router.post('/forgot-password', codeLimiter, async (req, res) => {
  try {
    const result = await authService.forgotPassword(req.body);
    res.json({ status: 'OK', data: result });
  } catch (err) {
    res.status(err.status || 400).json({ status: 'ERROR', code: err.code, message: err.message });
  }
});

router.post('/reset-password', codeLimiter, async (req, res) => {
  try {
    const result = await authService.resetPassword(req.body);
    res.json({ status: 'OK', data: result });
  } catch (err) {
    res.status(err.status || 400).json({ status: 'ERROR', code: err.code, message: err.message });
  }
});

module.exports = router;
