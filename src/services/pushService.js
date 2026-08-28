const supabase = require('../db/supabaseClient');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const TOKEN_PATTERN = /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/;

function validateToken(value) {
  const token = String(value || '').trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw Object.assign(new Error('A valid Expo push token is required'), {
      code: 'INVALID_PUSH_TOKEN',
      status: 400,
    });
  }
  return token;
}

async function register(userId, tokenInput, platform = 'unknown') {
  const token = validateToken(tokenInput);
  const requestedPlatform = String(platform || 'unknown').toLowerCase();
  const safePlatform = ['android', 'ios', 'web'].includes(requestedPlatform)
    ? requestedPlatform
    : 'unknown';
  const row = {
    user_id: userId,
    expo_push_token: token,
    platform: safePlatform,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from('push_tokens')
    .upsert(row, { onConflict: 'expo_push_token' })
    .select('id,platform,updated_at')
    .single();
  if (error) throw Object.assign(new Error(`Register push token: ${error.message}`), { code: 'DATABASE_ERROR', status: 500 });
  return data;
}

async function unregister(userId, tokenInput) {
  const token = validateToken(tokenInput);
  const { error } = await supabase
    .from('push_tokens')
    .delete()
    .eq('user_id', userId)
    .eq('expo_push_token', token);
  if (error) throw Object.assign(new Error(`Remove push token: ${error.message}`), { code: 'DATABASE_ERROR', status: 500 });
  return { removed: true };
}

async function unregisterAll(userId) {
  const { error } = await supabase
    .from('push_tokens')
    .delete()
    .eq('user_id', userId);
  if (error) throw Object.assign(new Error(`Remove user push tokens: ${error.message}`), { code: 'DATABASE_ERROR', status: 500 });
  return { removed: true };
}

async function removeInvalidTokens(tokens) {
  if (!tokens.length) return;
  const { error } = await supabase.from('push_tokens').delete().in('expo_push_token', tokens);
  if (error) console.error('[push] Could not remove invalid tokens:', error.message);
}

async function sendToUser(userId, notification) {
  const { data: rows, error } = await supabase
    .from('push_tokens')
    .select('expo_push_token')
    .eq('user_id', userId);
  if (error) throw new Error(`Load push tokens: ${error.message}`);
  const tokens = (rows || []).map((row) => row.expo_push_token).filter((token) => TOKEN_PATTERN.test(token));
  if (!tokens.length) return { sent: 0 };

  const messages = tokens.map((to) => ({
    to,
    sound: 'default',
    title: notification.title,
    body: notification.body,
    data: notification.data || {},
    priority: 'high',
    channelId: 'x-store-updates',
  }));
  const response = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(process.env.EXPO_ACCESS_TOKEN
        ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` }
        : {}),
    },
    body: JSON.stringify(messages),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Expo push service returned ${response.status}`);
  const tickets = Array.isArray(payload.data) ? payload.data : [payload.data].filter(Boolean);
  const invalid = tickets
    .map((ticket, index) => ticket?.details?.error === 'DeviceNotRegistered' ? tokens[index] : null)
    .filter(Boolean);
  await removeInvalidTokens(invalid);
  return { sent: Math.max(tokens.length - invalid.length, 0) };
}

module.exports = { register, unregister, unregisterAll, sendToUser, validateToken };
