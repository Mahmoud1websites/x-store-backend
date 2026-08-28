const supabase = require('../db/supabaseClient');
const pushService = require('./pushService');

function databaseError(error, context) {
  if (!error) return;
  const wrapped = new Error(`${context}: ${error.message}`);
  wrapped.code = 'DATABASE_ERROR';
  wrapped.status = 500;
  throw wrapped;
}

async function create({ userId, type, title, body, data = {}, dedupeKey = null }) {
  const row = {
    user_id: userId,
    type,
    title,
    body,
    data,
    dedupe_key: dedupeKey,
  };
  const query = supabase.from('notifications');
  const { data: created, error } = dedupeKey
    ? await query.upsert(row, { onConflict: 'dedupe_key', ignoreDuplicates: true }).select().maybeSingle()
    : await query.insert(row).select().single();
  databaseError(error, 'create notification');
  if (created) {
    pushService.sendToUser(userId, { title, body, data }).catch((pushError) => {
      console.error('[push] Notification delivery failed:', pushError.message);
    });
  }
  return created;
}

async function listForUser(userId, { limit = 50, unreadOnly = false } = {}) {
  let query = supabase
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(Number(limit) || 50, 1), 100));
  if (unreadOnly) query = query.is('read_at', null);
  const { data, error } = await query;
  databaseError(error, 'load notifications');
  return data || [];
}

async function summary(userId) {
  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .is('read_at', null);
  databaseError(error, 'count unread notifications');
  return { unread: count || 0 };
}

async function markRead(userId, notificationId) {
  const { data, error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', notificationId)
    .eq('user_id', userId)
    .select()
    .maybeSingle();
  databaseError(error, 'mark notification read');
  if (!data) {
    const notFound = new Error('Notification not found');
    notFound.status = 404;
    notFound.code = 'NOTIFICATION_NOT_FOUND';
    throw notFound;
  }
  return data;
}

async function markAllRead(userId) {
  const { data, error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('read_at', null)
    .select('id');
  databaseError(error, 'mark all notifications read');
  return { updated: (data || []).length };
}

async function notifyWalletReview(request) {
  const approved = request.status === 'approved';
  return create({
    userId: request.user_id,
    type: approved ? 'wallet_approved' : 'wallet_rejected',
    title: approved ? 'Wallet credit approved' : 'Wallet request not approved',
    body: approved
      ? `$${Number(request.amount_usd || 0).toFixed(2)} was added to your X Store wallet.`
      : request.admin_note || 'Your wallet credit request was reviewed and rejected.',
    data: { request_id: request.id, amount_usd: Number(request.amount_usd || 0) },
    dedupeKey: `wallet:${request.id}:${request.status}`,
  });
}

function orderMessage(status) {
  if (status === 'accept') {
    return { type: 'order_completed', title: 'Order completed', body: 'Your service order was completed successfully.' };
  }
  if (status === 'reject') {
    return { type: 'order_rejected', title: 'Order rejected and refunded', body: 'The supplier rejected this order and your wallet was refunded.' };
  }
  return { type: 'order_submitted', title: 'Order submitted', body: 'Your order was received and is being processed.' };
}

async function notifyOrder(order) {
  const message = orderMessage(order.status);
  return create({
    userId: order.user_id,
    ...message,
    data: { order_uuid: order.order_uuid, status: order.status },
    dedupeKey: `order:${order.order_uuid}:${order.status}`,
  });
}

module.exports = {
  create,
  listForUser,
  summary,
  markRead,
  markAllRead,
  notifyWalletReview,
  notifyOrder,
};
