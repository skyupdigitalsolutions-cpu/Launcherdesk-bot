const axios = require('axios');

// TWO endpoints — this was the bug:
//  SESSION_URL → text + interactive (buttons/list), works inside 24h window
//  BULK_URL    → templates ONLY (used to START a conversation)
const SESSION_URL = 'https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/';
const BULK_URL    = 'https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/';

const AUTH_KEY    = process.env.MSG91_AUTH_KEY;
const FROM_NUMBER = process.env.MSG91_WHATSAPP_NUMBER;

// ── Core sender for SESSION messages (text + interactive) ─────
async function sendSession(to, contentType, contentObject) {
  try {
    const body = {
      recipient_number:  to,
      integrated_number: FROM_NUMBER,
      content_type:      contentType,   // 'text' | 'interactive'
      ...contentObject,                 // { text: {...} } OR { interactive: {...} }
    };

    const _t0 = Date.now();
    const res = await axios.post(SESSION_URL, body, {
      // WITHOUT THIS, a slow or hung MSG91 request waits indefinitely.
      // Combined with the per-phone lock in services/lock.js, one hung
      // send blocks every later message from that user — observed as a
      // 30-second reply. 8s is generous for an API that normally
      // answers in under 400ms; failing fast and logging beats hanging.
      timeout: 8000,
      headers: {
        authkey: AUTH_KEY,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
    });
    // Timing included so a slow MSG91 API is visible in the logs
    // rather than being mistaken for slowness in the bot.
    console.log(`[MSG91] ${contentType} → ${to} in ${Date.now() - _t0}ms:`, JSON.stringify(res.data).slice(0, 150));
    return res.data;
  } catch (err) {
    console.error(`[MSG91] Error (${contentType}) → ${to}:`, JSON.stringify(err.response?.data || err.message));
    throw err;
  }
}

// ── 1. Plain text session reply ───────────────────────────────
async function sendText(to, text) {
  return sendSession(to, 'text', { text: { body: text } });
}

// ── 2. Interactive list ───────────────────────────────────────
async function sendListMessage(to, bodyText, buttonLabel, sections, headerText, footerText) {
  const interactive = {
    type: 'list',
    body: { text: bodyText },
    action: { button: buttonLabel, sections },
  };
  if (headerText) interactive.header = { type: 'text', text: headerText };
  if (footerText) interactive.footer = { text: footerText };
  return sendSession(to, 'interactive', { interactive });
}

// ── 3. Interactive reply buttons (max 3) ──────────────────────
async function sendButtonMessage(to, bodyText, buttons, headerText, footerText) {
  const interactive = {
    type: 'button',
    body: { text: bodyText },
    action: {
      buttons: buttons.map((btn) => ({
        type: 'reply',
        reply: { id: btn.id, title: btn.title },
      })),
    },
  };
  if (headerText) interactive.header = { type: 'text', text: headerText };
  if (footerText) interactive.footer = { text: footerText };
  return sendSession(to, 'interactive', { interactive });
}

// ── 4. Sales alert (TEMPLATE — uses BULK endpoint) ────────────
async function sendSalesAlert(to, lead) {
  try {
    const templateName =
      process.env.TEMPLATE_ID_SALES_ALERT || process.env.TEMPLATE_NAME_SALES_ALERT;

    // Fail loudly in the log rather than firing a request that MSG91
    // will reject with an opaque error.
    if (!templateName) {
      console.error('[MSG91] No sales-alert template configured — set TEMPLATE_ID_SALES_ALERT in .env');
      return null;
    }

    const body = {
      integrated_number: FROM_NUMBER,
      content_type: 'template',
      payload: {
        messaging_product: 'whatsapp',
        type: 'template',
        template: {
          // BUGFIX: this read TEMPLATE_NAME_SALES_ALERT, but .env
          // defines TEMPLATE_ID_SALES_ALERT — so the template name
          // was always undefined and every sales alert failed
          // silently. Both names are accepted now so neither the old
          // nor the new .env spelling can break it again.
          name: process.env.TEMPLATE_ID_SALES_ALERT || process.env.TEMPLATE_NAME_SALES_ALERT,
          language: { code: 'en', policy: 'deterministic' },
          to_and_components: [{
            to: [to],
            components: {
              // Falls back across old and new field names so the
              // template keeps working regardless of which shape the
              // caller passes, and never sends `undefined` (which
              // MSG91 rejects for the whole message).
              body_1: { type: 'text', value: lead.name || 'Unknown' },
              body_2: { type: 'text', value: lead.mobile || lead.phone || 'Not provided' },
              body_3: { type: 'text', value: lead.email || lead.work_email || 'Not provided' },
              body_4: { type: 'text', value: lead.businessName || lead.business_name || 'Not provided' },
              body_5: { type: 'text', value: lead.city || 'Not provided' },
              body_6: { type: 'text', value: lead.categoryLabel || 'General Enquiry' },
            },
          }],
        },
      },
    };
    const res = await axios.post(BULK_URL, body, {
      timeout: 8000,   // see the note on SESSION_URL above
      headers: { authkey: AUTH_KEY, 'Content-Type': 'application/json' },
    });
    console.log(`[MSG91] template → ${to}:`, JSON.stringify(res.data).slice(0, 150));
    return res.data;
  } catch (err) {
    console.error(`[MSG91] Error (template) → ${to}:`, JSON.stringify(err.response?.data || err.message));
    throw err;
  }
}

module.exports = { sendText, sendListMessage, sendButtonMessage, sendSalesAlert };