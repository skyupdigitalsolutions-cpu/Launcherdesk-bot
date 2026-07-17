const axios = require('axios');

const BASE_URL = 'https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/';
const AUTH_KEY    = process.env.MSG91_AUTH_KEY;
const FROM_NUMBER = process.env.MSG91_WHATSAPP_NUMBER;

// ── Core sender: content_type is now dynamic ──────────────────
async function sendMessage(to, contentType, payload) {
  try {
    const body = {
      integrated_number: FROM_NUMBER,
      content_type: contentType,          // 'text' | 'interactive' | 'template'
      payload: {
        messaging_product: 'whatsapp',
        to,
        ...payload,
      },
    };

    const response = await axios.post(BASE_URL, body, {
      headers: { authkey: AUTH_KEY, 'Content-Type': 'application/json' },
    });

    console.log(`[MSG91] ${contentType} → ${to}:`, JSON.stringify(response.data).slice(0, 120));
    return response.data;
  } catch (err) {
    const errData = err.response?.data || err.message;
    console.error(`[MSG91] Error (${contentType}) → ${to}:`, JSON.stringify(errData));
    throw err;
  }
}

// ── 1. Plain text session reply ───────────────────────────────
async function sendText(to, text) {
  return sendMessage(to, 'text', {
    type: 'text',
    text: { body: text },
  });
}

// ── 2. Interactive list ───────────────────────────────────────
async function sendListMessage(to, bodyText, buttonLabel, sections) {
  return sendMessage(to, 'interactive', {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: { button: buttonLabel, sections },
    },
  });
}

// ── 3. Interactive reply buttons (max 3) ──────────────────────
async function sendButtonMessage(to, bodyText, buttons) {
  return sendMessage(to, 'interactive', {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.map((btn) => ({
          type: 'reply',
          reply: { id: btn.id, title: btn.title },
        })),
      },
    },
  });
}

// ── 4. Sales alert (approved template — keep as-is) ───────────
async function sendSalesAlert(to, lead) {
  return sendMessage(to, 'template', {
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
  });
}

module.exports = { sendText, sendListMessage, sendButtonMessage, sendSalesAlert };