const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// Publicly hosted logo URL. Must be reachable over the internet — email
// clients fetch this image directly, they cannot see local files. Update
// this if the logo is hosted somewhere other than your backend's /public
// static folder (e.g. Supabase Storage, S3, etc).
const LOGO_URL = process.env.EMAIL_LOGO_URL || 'https://xstore.best/public/logo.png';

function isConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function sendEmail({ to, subject, text, html }) {
  if (!isConfigured()) {
    const error = new Error('Email delivery is not configured');
    error.code = 'EMAIL_NOT_CONFIGURED';
    error.status = 503;
    throw error;
  }

  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: [to],
      subject,
      text,
      html,
      reply_to: process.env.SUPPORT_EMAIL || undefined,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || 'Email provider rejected the message');
    error.code = 'EMAIL_DELIVERY_FAILED';
    error.status = 502;
    throw error;
  }
  return payload;
}

async function sendAuthCode({ to, code, purpose }) {
  const verification = purpose === 'email_verification';
  const subject = verification
    ? 'Verify your X Store email'
    : 'Reset your X Store password';
  const heading = verification ? 'Verify your email' : 'Reset your password';
  const action = verification
    ? 'Enter this code in X Store to finish creating your account.'
    : 'Enter this code in X Store to choose a new password.';
  const safeCode = escapeHtml(code);

  return sendEmail({
    to,
    subject,
    text: `${heading}\n\nYour X Store security code is ${code}. It expires in 15 minutes. Never share this code.`,
    html: `
      <div style="font-family:Arial,sans-serif;background:#f5f6fb;padding:32px;color:#151925">
        <div style="max-width:520px;margin:auto;background:#fff;border:1px solid #e2e5ee;border-radius:20px;padding:30px">
          <img src="${LOGO_URL}" alt="X Store" style="height:44px;display:block;margin:0 0 18px" />
          <div style="font-size:12px;font-weight:800;letter-spacing:1.6px;color:#4f46e5">X STORE SECURITY</div>
          <h1 style="font-size:26px;margin:18px 0 10px">${heading}</h1>
          <p style="color:#697083;line-height:1.6">${action}</p>
          <div style="font-size:32px;font-weight:900;letter-spacing:8px;text-align:center;background:#eeedff;color:#4f46e5;border-radius:14px;padding:20px;margin:24px 0">${safeCode}</div>
          <p style="font-size:13px;color:#697083">This code expires in 15 minutes. X Store administrators will never ask you to share it.</p>
        </div>
      </div>`,
  });
}

module.exports = { isConfigured, sendEmail, sendAuthCode };