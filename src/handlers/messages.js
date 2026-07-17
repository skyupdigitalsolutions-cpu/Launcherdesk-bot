const msg91 = require('../services/msg91');
const logger = require('../services/logger');
const { CATEGORIES, MENU_ROWS } = require('../config/categories');

// ─────────────────────────────────────────────────────────────
//  Message Builders
//  One function per outgoing message type.
//  All send* functions return the MSG91 response promise.
//
//  Each function also logs the exact text it sends via the
//  logger service (MongoDB + Google Sheets), since this is the
//  one place the outgoing message text is actually known.
// ─────────────────────────────────────────────────────────────

// Log an outgoing message without ever throwing — logging must
// never break the conversation flow.
async function logOutgoingSafe(phone, message, messageType, state) {
  try {
    await logger.logOutgoing({ phone, message, messageType, state });
  } catch (err) {
    console.error('Logger Error:', err.message);
  }
}

// ── Step 2: Main menu (interactive list) ─────────────────────
async function sendMainMenu(phone, state) {
  const bodyText =
    'Hi there! 👋 Which area can we help your business with today?\n\n' +
    'Choose a category below and we\'ll share everything you need to know.';

  const sections = [
    {
      title: 'Our Services',
      rows: MENU_ROWS.map((row) => ({
        id:          row.id,
        title:       row.title,
        description: row.description,
      })),
    },
  ];

  const result = await msg91.sendListMessage(phone, bodyText, 'View Categories', sections);
  await logOutgoingSafe(phone, bodyText, 'interactive', state);
  return result;
}

// ── Step 3: Category detail (reply buttons) ───────────────────
async function sendCategoryDetail(phone, categoryKey, state) {
  const cat = CATEGORIES[categoryKey];
  if (!cat) return sendFallback(phone, state);

  const text = `*${cat.title}*\n\n${cat.body}`;
  const buttons = [
    { id: 'need_service', title: '✅ Need This Service' },
    { id: 'back_menu',    title: '🔙 Back to Menu' },
  ];

  const result = await msg91.sendButtonMessage(phone, text, buttons);
  await logOutgoingSafe(phone, text, 'interactive', state);
  return result;
}

// ── Step 4: Lead capture — name confirmation ──────────────────
async function sendAskNameConfirm(phone, nameFromTemplate, state) {
  const text =
    `Great choice! 🙌 Let me connect you with the right expert.\n\n` +
    `Quick question — should we address you as *${nameFromTemplate}*?`;

  const buttons = [
    { id: 'name_yes',  title: '✅ Yes, that\'s right' },
    { id: 'name_edit', title: '✏️ Use a different name' },
  ];

  const result = await msg91.sendButtonMessage(phone, text, buttons);
  await logOutgoingSafe(phone, text, 'interactive', state);
  return result;
}

// ── Step 4b: Ask for name (if they said 'different name') ─────
async function sendAskName(phone, state) {
  const text = 'Please type your full name:';
  const result = await msg91.sendText(phone, text);
  await logOutgoingSafe(phone, text, 'text', state);
  return result;
}

// ── Step 4c: Ask for email ────────────────────────────────────
async function sendAskEmail(phone, name, state) {
  const text = `Thanks, *${name}*! 📧\n\nWhat's your *email address*?\n_(We'll send a summary of your enquiry.)_`;
  const result = await msg91.sendText(phone, text);
  await logOutgoingSafe(phone, text, 'text', state);
  return result;
}

// ── Step 4d: Invalid email prompt ────────────────────────────
async function sendInvalidEmail(phone, state) {
  const text = `Hmm, that doesn't look like a valid email. 🤔\n\nPlease re-check and send again.\n_Example: name@company.com_`;
  const result = await msg91.sendText(phone, text);
  await logOutgoingSafe(phone, text, 'text', state);
  return result;
}

// ── Step 4e: Ask for business name ───────────────────────────
async function sendAskBusiness(phone, state) {
  const text = `What's your *business name*?`;
  const buttons = [{ id: 'no_biz', title: '🆕 Not registered yet' }];
  const result = await msg91.sendButtonMessage(phone, text, buttons);
  await logOutgoingSafe(phone, text, 'interactive', state);
  return result;
}

// ── Step 4f: Ask for city ─────────────────────────────────────
async function sendAskCity(phone, state) {
  const text = `Which *city* are you based in? 📍`;
  const result = await msg91.sendText(phone, text);
  await logOutgoingSafe(phone, text, 'text', state);
  return result;
}

// ── Step 4g: Confirmation summary ────────────────────────────
async function sendConfirmation(phone, data, state) {
  const text =
    `Here's a summary of your request:\n\n` +
    `👤 *Name:* ${data.name}\n` +
    `📱 *Mobile:* ${data.phone}\n` +
    `📧 *Email:* ${data.email || 'Not provided'}\n` +
    `🏢 *Business:* ${data.businessName || 'Not registered yet'}\n` +
    `📍 *City:* ${data.city}\n` +
    `🎯 *Service:* ${data.categoryLabel}\n\n` +
    `Shall I go ahead?`;

  const buttons = [
    { id: 'confirm_yes',  title: '✅ Confirm & Submit' },
    { id: 'confirm_edit', title: '✏️ Edit Details' },
  ];

  const result = await msg91.sendButtonMessage(phone, text, buttons);
  await logOutgoingSafe(phone, text, 'interactive', state);
  return result;
}

// ── Step 5: Lead submitted success ───────────────────────────
async function sendLeadSuccess(phone, data, state) {
  const text =
    `✅ *Request submitted successfully!*\n\n` +
    `A LauncherDesk *${data.categoryLabel}* expert will contact you within *2 business hours*.\n\n` +
    `Need anything else?`;

  const buttons = [
    { id: 'browse_more', title: '🔍 Browse More Services' },
    { id: 'visit_web',   title: '🌐 Visit Website' },
  ];

  const result = await msg91.sendButtonMessage(phone, text, buttons);
  await logOutgoingSafe(phone, text, 'interactive', state);
  return result;
}

// ── Expert handoff message ────────────────────────────────────
async function sendExpertHandoff(phone, state) {
  const text = `💬 *Connecting you with our team...*\n\nA LauncherDesk expert will message you shortly.\n\nThank you for your patience! 🙏`;
  const result = await msg91.sendText(phone, text);
  await logOutgoingSafe(phone, text, 'text', state);
  return result;
}

// ── Opt-out confirmation ──────────────────────────────────────
async function sendOptOutConfirm(phone, state) {
  const text = `You've been unsubscribed from LauncherDesk messages. ✅\n\nReply *START* anytime to opt back in.`;
  const result = await msg91.sendText(phone, text);
  await logOutgoingSafe(phone, text, 'text', state);
  return result;
}

// ── Opt-in confirmation ───────────────────────────────────────
async function sendOptInConfirm(phone, state) {
  const text = `Welcome back! 👋 You're now subscribed to LauncherDesk updates.\n\nType *MENU* to explore our services.`;
  const result = await msg91.sendText(phone, text);
  await logOutgoingSafe(phone, text, 'text', state);
  return result;
}

// ── Fallback (unrecognised input) ────────────────────────────
async function sendFallback(phone, state) {
  const text =
    `I didn't quite catch that. 🤔\n\nLet me show you the main menu — just pick a category:`;
  const result = await msg91.sendText(phone, text);
  await logOutgoingSafe(phone, text, 'text', state);
  return result;
}

module.exports = {
  sendMainMenu,
  sendCategoryDetail,
  sendAskNameConfirm,
  sendAskName,
  sendAskEmail,
  sendInvalidEmail,
  sendAskBusiness,
  sendAskCity,
  sendConfirmation,
  sendLeadSuccess,
  sendExpertHandoff,
  sendOptOutConfirm,
  sendOptInConfirm,
  sendFallback,
};
