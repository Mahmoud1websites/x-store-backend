const supabase = require('../db/supabaseClient');

function safeMetadata(value) {
  if (!value || typeof value !== 'object') return {};
  const copy = { ...value };
  for (const key of Object.keys(copy)) {
    if (/token|secret|password|authorization|cookie/i.test(key)) copy[key] = '[redacted]';
  }
  return copy;
}

async function log({
  level = 'error',
  source,
  code = null,
  message,
  requestId = null,
  method = null,
  path = null,
  statusCode = null,
  metadata = {},
}) {
  const row = {
    level,
    source,
    code,
    message: String(message || 'Unknown operational error').slice(0, 2000),
    request_id: requestId,
    method,
    path,
    status_code: statusCode,
    metadata: safeMetadata(metadata),
  };
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), ...row }));
  const { error } = await supabase.from('operational_logs').insert(row);
  if (error) console.error('[operationsService] failed to persist log:', error.message);
}

async function list({ level, limit = 100 } = {}) {
  let query = supabase
    .from('operational_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(Number(limit) || 100, 1), 500));
  if (level) query = query.eq('level', level);
  const { data, error } = await query;
  if (error) {
    const wrapped = new Error(`load operational logs: ${error.message}`);
    wrapped.code = 'DATABASE_ERROR';
    throw wrapped;
  }
  return data || [];
}

module.exports = { log, list };
