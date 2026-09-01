const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const store = require('../db/db');
const emailService = require('./emailService');
const notifications = require('./notificationService');
const authProviders = require('./authProviderService');
const pushService = require('./pushService');


const JWT_SECRET = process.env.JWT_SECRET || (() => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set in production');
  }
  console.warn('[authService] JWT_SECRET is not set; using a temporary development-only secret.');
  return crypto.randomBytes(32).toString('hex');
})();




const AUTH_CODE_PEPPER = process.env.AUTH_CODE_PEPPER || (() => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('AUTH_CODE_PEPPER must be set in production');
  }
  console.warn('[authService] AUTH_CODE_PEPPER is not set; using a temporary development-only pepper.');
  return crypto.randomBytes(32).toString('hex');
})();




const TOKEN_EXPIRY = '30d';
const CODE_EXPIRY_MS = 15 * 60 * 1000;

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validatePassword(password) {
  const value = String(password || '');
  if (value.length < 10) {
    throw Object.assign(new Error('Password must be at least 10 characters'), { code: 'WEAK_PASSWORD' });
  }
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/\d/.test(value)) {
    throw Object.assign(new Error('Password must include uppercase, lowercase and a number'), { code: 'WEAK_PASSWORD' });
  }
  return value;
}

function hashCode(email, purpose, code) {
  return crypto
    .createHash('sha256')
    .update(`${normalizeEmail(email)}:${purpose}:${String(code)}:${AUTH_CODE_PEPPER}`)
    .digest('hex');
}

function generateCode() {
  return String(crypto.randomInt(0, 100_000_000)).padStart(8, '0');
}

async function createAndSendCode(user, purpose) {
  const code = generateCode();
  await store.createAuthToken({
    userId: user.id,
    purpose,
    tokenHash: hashCode(user.email, purpose, code),
    expiresAt: new Date(Date.now() + CODE_EXPIRY_MS).toISOString(),
  });
  try {
    await emailService.sendAuthCode({ to: user.email, code, purpose });
  } catch (error) {
    if (process.env.NODE_ENV === 'production') throw error;
    if (process.env.ALLOW_DEV_AUTH_CODES !== 'true') throw error;
    console.warn(`[authService] Development ${purpose} code generated for ${user.email}.`);
  }
  return process.env.NODE_ENV !== 'production' && process.env.ALLOW_DEV_AUTH_CODES === 'true'
    ? { development_code: code }
    : {};
}

async function verifyCode(user, purpose, code) {
  const token = await store.getActiveAuthToken({ userId: user.id, purpose });
  if (!token || Number(token.failed_attempts || 0) >= 5) {
    throw Object.assign(new Error('The security code is invalid or expired'), { code: 'INVALID_OR_EXPIRED_CODE' });
  }

  const suppliedHash = hashCode(user.email, purpose, String(code || '').trim());
  const storedHash = String(token.token_hash || '');
  const matches = suppliedHash.length === storedHash.length
    && crypto.timingSafeEqual(Buffer.from(suppliedHash), Buffer.from(storedHash));
  if (!matches) {
    await store.incrementAuthTokenAttempts(token.id, token.failed_attempts);
    throw Object.assign(new Error('The security code is invalid or expired'), { code: 'INVALID_OR_EXPIRED_CODE' });
  }
  return token;
}

async function register({ email, password }) {
  const normalizedEmail = normalizeEmail(email);
  if (!isValidEmail(normalizedEmail)) {
    throw Object.assign(new Error('Valid email is required'), { code: 'INVALID_EMAIL' });
  }
  validatePassword(password);
  const existing = await store.getUserByEmail(normalizedEmail);
  if (existing) {
    throw Object.assign(new Error('An account with this email already exists'), { code: 'EMAIL_TAKEN' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await store.createUser({ id: crypto.randomUUID(), email: normalizedEmail, passwordHash });

  // The user row is already created at this point. Don't let a flaky email
  // provider fail the whole registration — the client can always request a
  // new code from the verify-email screen.
  let delivery = {};
  try {
    delivery = await createAndSendCode(user, 'email_verification');
  } catch (error) {
    console.error('[authService] Verification email delivery failed on register:', error.code || error.message);
  }

  return {
    email: user.email,
    requires_email_verification: true,
    message: 'Check your email for the 8-digit verification code.',
    ...delivery,
  };
}

async function requestEmailVerification({ email }) {
  const normalizedEmail = normalizeEmail(email);
  const user = await store.getUserByEmail(normalizedEmail);
  let delivery = {};
  if (user && !user.email_verified && !user.disabled) {
    try {
      delivery = await createAndSendCode(user, 'email_verification');
    } catch (error) {
      // Keep this response identical for existing and non-existing accounts.
      // The delivery provider failure is logged without exposing the email.
      console.error('[authService] Verification email delivery failed:', error.code || error.message);
    }
  }
  return {
    message: 'If this account needs verification, a new code has been sent.',
    ...delivery,
  };
}

async function verifyEmail({ email, code }) {
  const user = await store.getUserByEmail(normalizeEmail(email));
  if (!user) {
    throw Object.assign(new Error('The security code is invalid or expired'), { code: 'INVALID_OR_EXPIRED_CODE' });
  }
  if (user.email_verified) {
    // Never turn this public verification endpoint into a login shortcut.
    // Keep the response generic so it does not reveal account state either.
    throw Object.assign(new Error('The security code is invalid or expired'), {
      code: 'INVALID_OR_EXPIRED_CODE',
      status: 400,
    });
  }
  const tokenRecord = await verifyCode(user, 'email_verification', code);
  await store.consumeAuthToken(tokenRecord.id);
  const verifiedUser = await store.updateUser(user.id, {
    email_verified: true,
    email_verified_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  await notifications.create({
    userId: user.id,
    type: 'security',
    title: 'Email verified',
    body: 'Your X Store account email was verified successfully.',
    dedupeKey: `security:email-verified:${user.id}`,
  }).catch(() => undefined);
  return { token: issueToken(verifiedUser), user: toPublicUser(verifiedUser) };
}

async function login({ email, password }) {
  const user = await store.getUserByEmail(normalizeEmail(email));
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
  if (user.email_verified === false) {
    throw Object.assign(new Error('Verify your email before signing in'), { code: 'EMAIL_NOT_VERIFIED' });
  }
  const token = issueToken(user);
  return { token, user: toPublicUser(user) };
}

async function googleLogin({ id_token: idToken }) {
  const identity = await authProviders.verifyGoogleIdToken(idToken);
  let user = await store.getUserByGoogleSub(identity.sub);
  if (!user) user = await store.getUserByEmail(identity.email);

  if (user?.disabled) {
    throw Object.assign(new Error('This account is disabled'), { code: 'ACCOUNT_DISABLED', status: 403 });
  }

  if (!user) {
    const passwordHash = await bcrypt.hash(crypto.randomBytes(48).toString('base64url'), 12);
    user = await store.createUser({
      id: crypto.randomUUID(),
      email: identity.email,
      passwordHash,
      authProvider: 'google',
      googleSub: identity.sub,
      displayName: identity.name,
      // X Store still performs its own email verification for new accounts.
      emailVerified: false,
    });
  } else if (user.google_sub !== identity.sub || (!user.display_name && identity.name)) {
    user = await store.updateUser(user.id, {
      google_sub: identity.sub,
      display_name: user.display_name || identity.name,
      updated_at: new Date().toISOString(),
    });
  }

  if (user.email_verified === false) {
    const delivery = await createAndSendCode(user, 'email_verification');
    return {
      email: user.email,
      requires_email_verification: true,
      message: 'Google confirmed your email. Enter the X Store code sent to your inbox to finish registration.',
      ...delivery,
    };
  }

  return { token: issueToken(user), user: toPublicUser(user) };
}

async function requestPhoneLogin({ phone }) {
  return authProviders.requestPhoneCode(phone);
}

async function verifyPhoneLogin({ phone, code }) {
  const verified = await authProviders.verifyPhoneCode(phone, code);
  let user = await store.getUserByPhone(verified.phone);
  if (user?.disabled) {
    throw Object.assign(new Error('This account is disabled'), { code: 'ACCOUNT_DISABLED', status: 403 });
  }
  if (!user) {
    const passwordHash = await bcrypt.hash(crypto.randomBytes(48).toString('base64url'), 12);
    user = await store.createUser({
      id: crypto.randomUUID(),
      passwordHash,
      phoneE164: verified.phone,
      authProvider: 'phone',
      displayName: `Customer ${verified.phone.slice(-4)}`,
      emailVerified: true,
      phoneVerified: true,
    });
    await notifications.create({
      userId: user.id,
      type: 'security',
      title: 'Phone verified',
      body: 'Your X Store phone number was verified successfully.',
      dedupeKey: `security:phone-verified:${user.id}`,
    }).catch(() => undefined);
  }
  return { token: issueToken(user), user: toPublicUser(user) };
}

async function forgotPassword({ email }) {
  const user = await store.getUserByEmail(normalizeEmail(email));
  let delivery = {};
  if (user && !user.disabled) {
    try {
      delivery = await createAndSendCode(user, 'password_reset');
    } catch (error) {
      // Never reveal whether an account exists through delivery errors.
      console.error('[authService] Password-reset email delivery failed:', error.code || error.message);
    }
  }
  return {
    message: 'If an account exists for this email, a reset code has been sent.',
    ...delivery,
  };
}

async function resetPassword({ email, code, password }) {
  validatePassword(password);
  const user = await store.getUserByEmail(normalizeEmail(email));
  if (!user) {
    throw Object.assign(new Error('The security code is invalid or expired'), { code: 'INVALID_OR_EXPIRED_CODE' });
  }
  const tokenRecord = await verifyCode(user, 'password_reset', code);
  const passwordHash = await bcrypt.hash(password, 12);
  // Consume first so two concurrent submissions cannot reuse one code.
  await store.consumeAuthToken(tokenRecord.id);
  await store.updateUser(user.id, {
    password_hash: passwordHash,
    password_changed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  // Password reset invalidates JWTs through password_changed_at. Removing all
  // registered device tokens also prevents a lost device from receiving future
  // wallet or order notifications after the reset.
  await pushService.unregisterAll(user.id).catch((error) => {
    console.error('[authService] Could not remove push tokens after password reset:', error.message);
  });
  await notifications.create({
    userId: user.id,
    type: 'security',
    title: 'Password changed',
    body: 'Your X Store password was reset. Contact support immediately if this was not you.',
    dedupeKey: `security:password:${tokenRecord.id}`,
  }).catch(() => undefined);
  return { message: 'Password updated successfully. You can now sign in.' };
}

function issueToken(user) {
  return jwt.sign({
    sub: user.id,
    email: user.email || null,
    phone: user.phone_e164 || null,
    role: user.role || 'customer',
  }, JWT_SECRET, {
    expiresIn: TOKEN_EXPIRY,
  });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function toPublicUser(user) {
  return {
    id: user.id,
    email: user.email || null,
    phone_e164: user.phone_e164 || null,
    display_name: user.display_name || null,
    auth_provider: user.auth_provider || 'password',
    wallet_balance: Number(user.wallet_balance || 0),
    role: user.role || 'customer',
    customer_type: user.customer_type === 'reseller' ? 'reseller' : 'retail',
    disabled: Boolean(user.disabled),
    email_verified: user.email_verified !== false,
    email_verified_at: user.email_verified_at || null,
    phone_verified_at: user.phone_verified_at || null,
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

async function getSessionUser(payload) {
  const user = await store.getUserById(payload.sub);
  if (!user) {
    throw Object.assign(new Error('User not found'), { code: 'USER_NOT_FOUND' });
  }
  const passwordChangedAt = Date.parse(user.password_changed_at || '');
  const issuedAt = Number(payload.iat || 0) * 1000;
  // JWT `iat` is stored in whole seconds. Allow the remainder of that same
  // second so a token issued immediately after a password change is valid.
  if (Number.isFinite(passwordChangedAt) && issuedAt + 999 < passwordChangedAt) {
    throw Object.assign(new Error('Session was issued before the password changed'), {
      code: 'SESSION_REVOKED',
    });
  }
  return toPublicUser(user);
}

module.exports = {
  register,
  requestEmailVerification,
  verifyEmail,
  login,
  googleLogin,
  requestPhoneLogin,
  verifyPhoneLogin,
  providerAvailability: authProviders.availability,
  forgotPassword,
  resetPassword,
  verifyToken,
  toPublicUser,
  getMe,
  getSessionUser,
  validatePassword,
  issueToken,
};