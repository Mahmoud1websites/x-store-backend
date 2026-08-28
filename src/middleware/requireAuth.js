/**
 * requireAuth.js
 *
 * Protects a route by requiring a valid `Authorization: Bearer <token>`
 * header. On success, attaches req.user = { id, email }.
 *
 * Use on any route that should only work for a logged-in user
 * (orders, wallet, etc.) — never trust a userId sent in the request
 * body once this is wired in.
 */

const authService = require('../services/authService');

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ status: 'ERROR', code: 'NO_TOKEN', message: 'Missing or malformed Authorization header' });
  }

  try {
    const payload = authService.verifyToken(token);
    const user = await authService.getSessionUser(payload);
    if (user.disabled) {
      return res.status(403).json({
        status: 'ERROR',
        code: 'ACCOUNT_DISABLED',
        message: 'This account is disabled',
      });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ status: 'ERROR', code: 'INVALID_TOKEN', message: 'Invalid or expired token' });
  }
}

module.exports = requireAuth;
