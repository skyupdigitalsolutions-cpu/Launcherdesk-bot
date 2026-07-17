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

    const res = await axios.post(SESSION_URL, body, {
      headers: {
        authkey: AUTH_KEY,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
    });
    console.log(`[MSG91] ${contentType} → ${to}:`, JSON.stringify(res.data).slice(0, 150));
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
    const body = {
      integrated_number: FROM_NUMBER,
      content_type: 'template',
      payload: {
        messaging_product: 'whatsapp',
        type: 'template',
        template: {
          name: process.env.TEMPLATE_NAME_SALES_ALERT,
          language: { code: 'en', policy: 'deterministic' },
          to_and_components: [{
            to: [to],
            components: {
              body_1: { type: 'text', value: lead.name },
              body_2: { type: 'text', value: lead.phone },
              body_3: { type: 'text', value: lead.email || 'Not provided' },
              body_4: { type: 'text', value: lead.businessName || 'Not provided' },
              body_5: { type: 'text', value: lead.city || 'Not provided' },
              body_6: { type: 'text', value: lead.categoryLabel },
            },
          }],
        },
      },
    };
    const res = await axios.post(BULK_URL, body, {
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