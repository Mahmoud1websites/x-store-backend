function requireValue(name, minimumLength = 1) {
  const value = String(process.env[name] || '').trim();
  if (value.length < minimumLength) return `${name} must be at least ${minimumLength} characters`;
  return null;
}

function validateEnvironment() {
  const production = process.env.NODE_ENV === 'production';
  const issues = [];

  if (production) {
    issues.push(requireValue('JWT_SECRET', 32));
    issues.push(requireValue('AUTH_CODE_PEPPER', 32));
    issues.push(requireValue('SUPABASE_URL', 12));
    issues.push(requireValue('SUPABASE_SERVICE_ROLE_KEY', 32));
    issues.push(requireValue('SUPPLIER_API_TOKEN', 20));
    issues.push(requireValue('CORS_ORIGINS', 10));
    issues.push(requireValue('RESEND_API_KEY', 20));
    issues.push(requireValue('EMAIL_FROM', 6));
    if (process.env.AUTH_GOOGLE_ENABLED === 'true') {
      issues.push(requireValue('GOOGLE_CLIENT_IDS', 20));
    }
    if (process.env.AUTH_PHONE_ENABLED === 'true') {
      issues.push(requireValue('TWILIO_ACCOUNT_SID', 20));
      issues.push(requireValue('TWILIO_AUTH_TOKEN', 20));
      issues.push(requireValue('TWILIO_VERIFY_SERVICE_SID', 20));
    }
    if (String(process.env.CORS_ORIGINS || '').includes('*')) {
      issues.push('CORS_ORIGINS must contain exact origins and cannot use *');
    }
  }

  const failures = issues.filter(Boolean);
  if (failures.length) {
    const error = new Error(`Unsafe production environment:\n- ${failures.join('\n- ')}`);
    error.code = 'INVALID_ENVIRONMENT';
    throw error;
  }

  if (!production && (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM)) {
    console.warn('[env] Email verification/password reset are disabled until RESEND_API_KEY and EMAIL_FROM are set.');
  }

  if (process.env.AUTH_GOOGLE_ENABLED === 'true' && !process.env.GOOGLE_CLIENT_IDS) {
    console.warn('[env] Google authentication is enabled but GOOGLE_CLIENT_IDS is missing.');
  }
  if (
    process.env.AUTH_PHONE_ENABLED === 'true'
    && (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_VERIFY_SERVICE_SID)
  ) {
    console.warn('[env] Phone authentication is enabled but Twilio Verify variables are incomplete.');
  }
}

module.exports = { validateEnvironment };
