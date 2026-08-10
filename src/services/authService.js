/**
 * authService.js
 *
 * Simple email/password auth issuing JWTs. This is a starting point —
 * for a Lebanon-market consumer app you'll likely want phone+OTP login
 * too eventually (via a local SMS gateway or Firebase Auth), but email
 * gets you a working, testable auth flow today.
 *
 * JWT_SECRET must be set in .env for production — a random fallback
 * is generated at boot for local dev so you don't crash on startup,
 * but it changes every restart (all tokens invalidate), so don't rely
 * on it beyond local testing.
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const store = require('../db/db');

const JWT_SECRET = process.env.JWT_SECRET || (() => {
  console.warn('[authService] WARNING: JWT_SECRET not set in .env — using a random dev-only secret. Set JWT_SECRET in production.');
  return crypto.randomBytes(32).toString('hex');
})();

const TOKEN_EXPIRY = '30d';

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function register({ email, password }) {
  if (!email || !isValidEmail(email)) {
    throw Object.assign(new Error('Valid email is required'), { code: 'INVALID_EMAIL' });
  }
  if (!password || password.length < 6) {
    throw Object.assign(new Error('Password must be at least 6 characters'), { code: 'WEAK_PASSWORD' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const existing = await store.getUserByEmail(normalizedEmail);
  if (existing) {
    throw Object.assign(new Error('An account with this email already exists'), { code: 'EMAIL_TAKEN' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await store.createUser({ id: crypto.randomUUID(), email: normalizedEmail, passwordHash });
  const token = issueToken(user);
  return { token, user: toPublicUser(user) };
}

async function login({ email, password }) {
  const user = await store.getUserByEmail(String(email || '').trim().toLowerCase());
  if (!user) {
    throw Object.assign(new Error('Invalid email or password'), { code: 'INVALID_CREDENTIALS' });
  }
  const valid = await bcrypt.compare(password || '', user.password_hash);
  if (!valid) {
    throw Object.assign(new Error('Invalid email or password'), { code: 'INVALID_CREDENTIALS' });
  }
  if (user.disabled) {
    throw Object.assign(new Error('This account is disabled'), { code: 'ACCOUNT_DISABLED' });
  }
  const token = issueToken(user);
  return { token, user: toPublicUser(user) };
}

function issueToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role || 'customer' }, JWT_SECRET, {
    expiresIn: TOKEN_EXPIRY,
  });
}

function verifyToken(token) {
  // Throws if invalid/expired — callers (middleware) should catch this.
  return jwt.verify(token, JWT_SECRET);
}

function toPublicUser(user) {
  // Never send password_hash back to the client.
  return {
    id: user.id,
    email: user.email,
    wallet_balance: Number(user.wallet_balance || 0),
    role: user.role || 'customer',
    disabled: Boolean(user.disabled),
    created_at: user.created_at,
  };
}

async function getMe(userId) {
  const user = await store.getUserById(userId);
  if (!user) {
    throw Object.assign(new Error('User not found'), { code: 'USER_NOT_FOUND' });
  }
  return toPublicUser(user);
}

module.exports = { register, login, verifyToken, toPublicUser, getMe };
