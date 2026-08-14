const supabase = require('../db/supabaseClient');

function databaseError(error, context) {
  if (!error) return;
  const wrapped = new Error(`${context}: ${error.message}`);
  wrapped.code = 'DATABASE_ERROR';
  wrapped.status = 500;
  throw wrapped;
}

function normalizeRequest(row) {
  if (!row) return row;
  return {
    ...row,
    amount_usd: Number(row.amount_usd || 0),
    user: row.user
      ? { ...row.user, wallet_balance: Number(row.user.wallet_balance || 0) }
      : undefined,
  };
}

async function listForUser(userId) {
  const { data, error } = await supabase
    .from('wallet_topup_requests')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);
  databaseError(error, 'load wallet requests');
  return (data || []).map(normalizeRequest);
}

async function createForUser(user, input) {
  const { data: pending, error: pendingError } = await supabase
    .from('wallet_topup_requests')
    .select('*')
    .eq('user_id', user.id)
    .eq('status', 'pending')
    .maybeSingle();
  databaseError(pendingError, 'check pending wallet request');

  let request = pending;
  let reused = Boolean(pending);
  if (!request) {
    const { data, error } = await supabase
      .from('wallet_topup_requests')
      .insert({
        user_id: user.id,
        amount_usd: Number(input.amount_usd),
        customer_note: input.customer_note || '',
      })
      .select()
      .single();
    if (error?.code === '23505') {
      return createForUser(user, input);
    }
    databaseError(error, 'create wallet request');
    request = data;
  }

  const { data: settings, error: settingsError } = await supabase
    .from('app_settings')
    .select('exchange_rate,whish_phone,support_phone')
    .eq('id', 1)
    .single();
  databaseError(settingsError, 'load Whish settings');

  return {
    request: normalizeRequest(request),
    reused,
    whish_phone: settings.whish_phone || settings.support_phone || '+96179306701',
    exchange_rate: Number(settings.exchange_rate || 89500),
  };
}

async function cancelForUser(userId, requestId) {
  const { data, error } = await supabase
    .from('wallet_topup_requests')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', requestId)
    .eq('user_id', userId)
    .eq('status', 'pending')
    .select()
    .maybeSingle();
  databaseError(error, 'cancel wallet request');
  if (!data) {
    const notFound = new Error('Pending wallet request not found');
    notFound.code = 'TOPUP_NOT_FOUND';
    notFound.status = 404;
    throw notFound;
  }
  return normalizeRequest(data);
}

async function listForAdmin(status = 'pending') {
  let query = supabase
    .from('wallet_topup_requests')
    .select('*,user:users!wallet_topup_requests_user_id_fkey(email,wallet_balance)')
    .order('created_at', { ascending: false })
    .limit(500);
  if (status && status !== 'all') query = query.eq('status', status);
  const { data, error } = await query;
  databaseError(error, 'load administrator wallet requests');
  return (data || []).map(normalizeRequest);
}

async function reviewByAdmin(adminId, requestId, input) {
  const { data, error } = await supabase.rpc('admin_review_wallet_topup', {
    p_admin_id: adminId,
    p_request_id: requestId,
    p_action: input.action,
    p_whish_reference: input.whish_reference || null,
    p_admin_note: input.admin_note || null,
  });
  if (error) {
    const wrapped = new Error(error.message);
    wrapped.code = /already reviewed/i.test(error.message)
      ? 'TOPUP_ALREADY_REVIEWED'
      : 'DATABASE_ERROR';
    wrapped.status = wrapped.code === 'TOPUP_ALREADY_REVIEWED' ? 409 : 400;
    throw wrapped;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    const notFound = new Error('Wallet request not found');
    notFound.code = 'TOPUP_NOT_FOUND';
    notFound.status = 404;
    throw notFound;
  }
  return normalizeRequest(row);
}

module.exports = {
  listForUser,
  createForUser,
  cancelForUser,
  listForAdmin,
  reviewByAdmin,
};
