const GOOGLE_TOKEN_INFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const TWILIO_API_BASE = 'https://verify.twilio.com/v2/Services';
const PROVIDER_TIMEOUT_MS = 12_000;

function configuredGoogleClientIds() {
  return String(process.env.GOOGLE_CLIENT_IDS || process.env.GOOGLE_CLIENT_ID || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function twilioConfig() {
  return {
    accountSid: String(process.env.TWILIO_ACCOUNT_SID || '').trim(),
    authToken: String(process.env.TWILIO_AUTH_TOKEN || '').trim(),
    verifyServiceSid: String(process.env.TWILIO_VERIFY_SERVICE_SID || '').trim(),
  };
}

function availability() {
  const twilio = twilioConfig();
  return {
    google: process.env.AUTH_GOOGLE_ENABLED !== 'false'
      && configuredGoogleClientIds().length > 0,
    phone: process.env.AUTH_PHONE_ENABLED !== 'false'
      && Boolean(twilio.accountSid && twilio.authToken && twilio.verifyServiceSid),
  };
}

function providerError(message, code = 'AUTH_PROVIDER_UNAVAILABLE', status = 503) {
  return Object.assign(new Error(message), { code, status });
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    throw providerError(
      error?.name === 'AbortError'
        ? 'The authentication provider took too long to respond'
        : 'Could not connect to the authentication provider',
    );
  } finally {
    clearTimeout(timer);
  }
}

async function verifyGoogleIdToken(idToken) {
  const clientIds = configuredGoogleClientIds();
  if (!clientIds.length) {
    throw providerError('Google sign-in is not configured yet');
  }
  const token = String(idToken || '').trim();
  if (!token || token.length > 10_000) {
    throw providerError('A valid Google identity token is required', 'INVALID_GOOGLE_TOKEN', 400);
  }

  const response = await fetchWithTimeout(
    `${GOOGLE_TOKEN_INFO_URL}?id_token=${encodeURIComponent(token)}`,
    { headers: { Accept: 'application/json' } },
  );
  const payload = await response.json().catch(() => ({}));
  const expiresAt = Number(payload.exp || 0) * 1000;
  const issuer = String(payload.iss || '');
  if (
    !response.ok
    || !payload.sub
    || !clientIds.includes(String(payload.aud || ''))
    || !['accounts.google.com', 'https://accounts.google.com'].includes(issuer)
    || String(payload.email_verified) !== 'true'
    || !payload.email
    || !Number.isFinite(expiresAt)
    || expiresAt <= Date.now()
  ) {
    throw providerError('Google sign-in could not be verified', 'INVALID_GOOGLE_TOKEN', 401);
  }
  return {
    sub: String(payload.sub),
    email: String(payload.email).trim().toLowerCase(),
    name: String(payload.name || '').trim().slice(0, 120) || null,
  };
}

function normalizePhone(input) {
  const raw = String(input || '').trim();
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (raw.startsWith('+')) return /^\+[1-9]\d{7,14}$/.test(`+${digits}`) ? `+${digits}` : null;
  if (digits.startsWith('961')) return /^961\d{7,8}$/.test(digits) ? `+${digits}` : null;
  if (digits.startsWith('0')) digits = `961${digits.slice(1)}`;
  else if (/^\d{8}$/.test(digits)) digits = `961${digits}`;
  return /^\d{8,15}$/.test(digits) ? `+${digits}` : null;
}

async function twilioRequest(path, values) {
  const config = twilioConfig();
  if (!availability().phone) throw providerError('Phone sign-in is not configured yet');
  const response = await fetchWithTimeout(
    `${TWILIO_API_BASE}/${encodeURIComponent(config.verifyServiceSid)}${path}`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(values).toString(),
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('[phone-auth] Twilio Verify request failed:', response.status, payload.code || 'UNKNOWN');
    throw providerError('The phone verification service is temporarily unavailable');
  }
  return payload;
}

async function requestPhoneCode(phoneInput) {
  const phone = normalizePhone(phoneInput);
  if (!phone) throw providerError('Enter a valid phone number with country code', 'INVALID_PHONE', 400);
  await twilioRequest('/Verifications', { To: phone, Channel: 'sms' });
  return { phone, message: 'A verification code was sent by SMS.' };
}

async function verifyPhoneCode(phoneInput, codeInput) {
  const phone = normalizePhone(phoneInput);
  const code = String(codeInput || '').replace(/\D/g, '').slice(0, 10);
  if (!phone) throw providerError('Enter a valid phone number with country code', 'INVALID_PHONE', 400);
  if (code.length < 4) throw providerError('Enter the complete verification code', 'INVALID_PHONE_CODE', 400);
  const payload = await twilioRequest('/VerificationCheck', { To: phone, Code: code });
  if (payload.status !== 'approved') {
    throw providerError('The phone verification code is invalid or expired', 'INVALID_PHONE_CODE', 401);
  }
  return { phone };
}

module.exports = {
  availability,
  normalizePhone,
  requestPhoneCode,
  verifyPhoneCode,
  verifyGoogleIdToken,
};
