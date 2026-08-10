/**
 * supabaseClient.js
 *
 * Uses the SERVICE ROLE key, not the anon/public key — this backend
 * runs in a trusted environment (your server), so it's allowed to
 * bypass Row Level Security and act with full DB access. NEVER send
 * the service role key to the React Native app; it stays server-side
 * only, in this backend's .env.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('[supabaseClient] WARNING: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set. DB calls will fail.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }, // this is a backend service, no browser session to persist
});

module.exports = supabase;
