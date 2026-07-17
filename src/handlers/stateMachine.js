const Session  = require('../models/Session');
const Lead     = require('../models/Lead');
const messages = require('./messages');
const msg91    = require('../services/msg91');
const sheets   = require('../services/sheets');
const logger   = require('../services/logger');
const { CATEGORIES } = require('../config/categories');

// ─────────────────────────────────────────────────────────────
//  LauncherDesk Bot — State Machine
//
//  States:
//   NEW        → First contact / after opt-in
//   MENU       → Waiting for category selection from list
//   CATEGORY   → Category detail shown, waiting for button
//   ASK_NAME   → Waiting for name confirmation or new name text
//   ASK_EMAIL  → Waiting for email text
//   ASK_BUSINESS → Waiting for business name text or 'not yet' btn
//   ASK_CITY   → Waiting for city text
//   CONFIRM    → Confirmation shown, waiting for confirm/edit
//   DONE       → Lead saved, conversation complete
//   HUMAN      → Bot paused, human agent handling
// ─────────────────────────────────────────────────────────────

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function handleInbound(parsed) {
  const { phone, type, text, buttonId, listRowId } = parsed;
  const upperText = text.toUpperCase().trim();

  // Load or create session up front — needed for logging and the pause check
  let session = await getOrCreate(phone);

  // ── Log incoming message immediately, before any state changes ──
  await logIncomingSafe(phone, text, type, session.state);

  // ── Human takeover: bot is paused — log only, no automatic replies ──
  if (session.botPaused) {
    console.log(`[Bot] Bot paused for ${phone} — skipping automation (human takeover)`);
    return;
  }

  // ── Global: opt-out ──────────────────────────────────────
  if (upperText === 'STOP') {
    const updatedSession = await Session.findOneAndUpdate(
      { phone },
      { optedOut: true, state: 'NEW' },
      { upsert: true, new: true }
    );
    await messages.sendOptOutConfirm(phone, updatedSession.state);
    return;
  }

  // ── Global: opt-in ───────────────────────────────────────
  if (upperText === 'START') {
    const updatedSession = await Session.findOneAndUpdate(
      { phone },
      { optedOut: false, state: 'NEW' },
      { upsert: true, new: true }
    );
    await messages.sendOptInConfirm(phone, updatedSession.state);
    return;
  }

  // ── Global: force menu keyword ────────────────────────────
  if (upperText === 'MENU' || upperText === 'HI' || upperText === 'HELLO') {
    if (session.optedOut) return;
    session.state = 'MENU';
    await session.save();
    await messages.sendMainMenu(phone, session.state);
    return;
  }

  // If opted out, silently ignore all messages
  if (session.optedOut) {
    console.log(`[Bot] Ignored message from opted-out number: ${phone}`);
    return;
  }

  console.log(`[Bot] ${phone} | state: ${session.state} | type: ${type} | text: "${text}" | btn: ${buttonId} | list: ${listRowId}`);

  // ── Route by state ────────────────────────────────────────
  switch (session.state) {

    // ── NEW: Template "Explore Services" button clicked ────
    case 'NEW': {
      // MSG91 sends template quick reply as type=button with text='Explore Services'
      const isExplore =
        buttonId === 'Explore Services' ||
        text === 'Explore Services' ||
        upperText.includes('EXPLORE');

      if (isExplore) {
        session.state = 'MENU';
        await session.save();
        await messages.sendMainMenu(phone, session.state);
      } else {
        // Any other first message — show menu anyway (graceful)
        session.state = 'MENU';
        await session.save();
        await messages.sendMainMenu(phone, session.state);
      }
      break;
    }

    // ── MENU: List selection received ─────────────────────
    case 'MENU': {
      const selected = listRowId || buttonId || '';

      if (selected === 'expert') {
        await handleExpertHandoff(session, phone);
        break;
      }

      if (CATEGORIES[selected]) {
        session.state = 'CATEGORY';
        session.data.category      = selected;
        session.data.categoryLabel = CATEGORIES[selected].label;
        await session.save();
        await messages.sendCategoryDetail(phone, selected, session.state);
      } else {
        // Unrecognised — re-send menu
        await messages.sendFallback(phone, session.state);
        await messages.sendMainMenu(phone, session.state);
      }
      break;
    }

    // ── CATEGORY: Waiting for Need This Service / Back / Expert
    case 'CATEGORY': {
      const btn = buttonId || '';

      if (btn === 'need_service') {
        // Start lead capture — use phone as name placeholder until we know their name
        session.state      = 'ASK_NAME';
        session.data.phone = phone;
        await session.save();
        // We don't have their name yet from template at this point
        // Ask for name directly
        await messages.sendAskName(phone, session.state);

      } else if (btn === 'back_menu') {
        session.state = 'MENU';
        await session.save();
        await messages.sendMainMenu(phone, session.state);

      } else if (btn === 'expert' || upperText.includes('EXPERT') || upperText.includes('AGENT')) {
        await handleExpertHandoff(session, phone);

      } else {
        await messages.sendFallback(phone, session.state);
        await messages.sendCategoryDetail(phone, session.data.category, session.state);
      }
      break;
    }

    // ── ASK_NAME: Waiting for typed name ─────────────────
    case 'ASK_NAME': {
      if (!text || text.length < 2) {
        const msgText = 'Please enter your full name (at least 2 characters):';
        await msg91.sendText(phone, msgText);
        await logOutgoingSafe(phone, msgText, 'text', session.state);
        break;
      }
      session.data.name  = toTitleCase(text);
      session.data.phone = phone;
      session.state      = 'ASK_EMAIL';
      await session.save();
      await messages.sendAskEmail(phone, session.data.name, session.state);
      break;
    }

    // ── ASK_EMAIL: Waiting for email ─────────────────────
    case 'ASK_EMAIL': {
      if (!EMAIL_REGEX.test(text)) {
        await messages.sendInvalidEmail(phone, session.state);
        break;
      }
      session.data.email = text.toLowerCase().trim();
      session.state      = 'ASK_BUSINESS';
      await session.save();
      await messages.sendAskBusiness(phone, session.state);
      break;
    }

    // ── ASK_BUSINESS: Waiting for business name or 'not yet'
    case 'ASK_BUSINESS': {
      const btn = buttonId || '';

      if (btn === 'no_biz') {
        session.data.businessName = 'Not registered yet';
      } else if (text && text.length >= 2) {
        session.data.businessName = text.trim();
      } else {
        const msgText = 'Please enter your business name, or tap the button if not registered yet:';
        await msg91.sendText(phone, msgText);
        await logOutgoingSafe(phone, msgText, 'text', session.state);
        await messages.sendAskBusiness(phone, session.state);
        break;
      }

      session.state = 'ASK_CITY';
      await session.save();
      await messages.sendAskCity(phone, session.state);
      break;
    }

    // ── ASK_CITY: Waiting for city ────────────────────────
    case 'ASK_CITY': {
      if (!text || text.length < 2) {
        const msgText = 'Please enter your city name:';
        await msg91.sendText(phone, msgText);
        await logOutgoingSafe(phone, msgText, 'text', session.state);
        break;
      }
      session.data.city = toTitleCase(text.trim());
      session.state     = 'CONFIRM';
      await session.save();
      await messages.sendConfirmation(phone, session.data, session.state);
      break;
    }

    // ── CONFIRM: Waiting for confirm or edit ──────────────
    case 'CONFIRM': {
      const btn = buttonId || '';

      if (btn === 'confirm_yes') {
        await saveLead(session, phone);

      } else if (btn === 'confirm_edit') {
        // Restart capture from name
        session.state = 'ASK_NAME';
        await session.save();
        const msgText = '✏️ No problem! Let\'s start over.\n\nWhat\'s your name?';
        await msg91.sendText(phone, msgText);
        await logOutgoingSafe(phone, msgText, 'text', session.state);

      } else {
        await messages.sendFallback(phone, session.state);
        await messages.sendConfirmation(phone, session.data, session.state);
      }
      break;
    }

    // ── DONE: Conversation complete ───────────────────────
    case 'DONE': {
      const btn = buttonId || '';

      if (btn === 'browse_more') {
        session.state = 'MENU';
        await session.save();
        await messages.sendMainMenu(phone, session.state);

      } else if (btn === 'visit_web') {
        const msgText = `🌐 Visit us at: ${process.env.WEBSITE_URL || 'https://launcherdesk.in'}\n\nFeel free to message us anytime! 👋`;
        await msg91.sendText(phone, msgText);
        await logOutgoingSafe(phone, msgText, 'text', session.state);

      } else {
        // Any text in DONE state — show menu again
        session.state = 'MENU';
        await session.save();
        await messages.sendMainMenu(phone, session.state);
      }
      break;
    }

    // ── HUMAN: Bot paused ─────────────────────────────────
    case 'HUMAN': {
      // Silently ignore — human agent is handling
      console.log(`[Bot] Message from ${phone} in HUMAN state — skipped`);
      break;
    }

    default: {
      console.warn(`[Bot] Unknown state "${session.state}" for ${phone} — resetting to MENU`);
      session.state = 'MENU';
      await session.save();
      await messages.sendMainMenu(phone, session.state);
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────

async function getOrCreate(phone) {
  let session = await Session.findOne({ phone });
  if (!session) {
    session = new Session({ phone, state: 'NEW' });
    await session.save();
  }
  return session;
}

// Log an incoming message without ever throwing — logging must
// never break the conversation flow.
async function logIncomingSafe(phone, message, messageType, state) {
  try {
    await logger.logIncoming({ phone, message, messageType, state });
  } catch (err) {
    console.error('Logger Error:', err.message);
  }
}

// Log an outgoing message sent directly via msg91 (not routed
// through a messages.js helper) without ever throwing.
async function logOutgoingSafe(phone, message, messageType, state) {
  try {
    await logger.logOutgoing({ phone, message, messageType, state });
  } catch (err) {
    console.error('Logger Error:', err.message);
  }
}

async function handleExpertHandoff(session, phone) {
  session.botPaused = true;
  session.state     = 'HUMAN';
  await session.save();

  await messages.sendExpertHandoff(phone, session.state);

  // Notify sales team
  const salesNumber = process.env.SALES_WA_NUMBER;
  if (salesNumber) {
    const leadInfo = {
      name:          session.data.name || 'Unknown',
      phone,
      email:         session.data.email || '',
      businessName:  session.data.businessName || '',
      city:          session.data.city || '',
      categoryLabel: session.data.categoryLabel || 'General Enquiry',
    };
    await msg91.sendSalesAlert(salesNumber, leadInfo);
  }
}

async function saveLead(session, phone) {
  const d = session.data;

  // Save to MongoDB
  const lead = new Lead({
    name:          d.name,
    phone,
    email:         d.email,
    businessName:  d.businessName,
    city:          d.city,
    category:      d.category,
    categoryLabel: d.categoryLabel,
  });
  await lead.save();

  // Append to Google Sheets (non-blocking — don't fail if Sheets is down)
  sheets.appendLead({ ...d, phone, source: 'whatsapp_bot' }).catch((e) =>
    console.error('[Bot] Sheets append error (non-fatal):', e.message)
  );

  // Notify sales team
  const salesNumber = process.env.SALES_WA_NUMBER;
  if (salesNumber) {
    await msg91.sendSalesAlert(salesNumber, { ...d, phone }).catch((e) =>
      console.error('[Bot] Sales alert error (non-fatal):', e.message)
    );
  }

  // Update session state
  session.state = 'DONE';
  await session.save();

  // Send success message to user
  await messages.sendLeadSuccess(phone, d, session.state);

  console.log(`[Bot] ✅ Lead saved — ${d.name} | ${phone} | ${d.categoryLabel}`);
}

function toTitleCase(str) {
  return str.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

module.exports = { handleInbound };
