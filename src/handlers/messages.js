const msg91  = require('../services/msg91');
const logger = require('../services/logger');
const { MENU_ROWS } = require('../config/flows');

// ─────────────────────────────────────────────────────────────
//  Outbound Message Layer
//
//  Every user-facing string lives here. The state machine decides
//  WHAT should happen; this file decides how it reads on the phone.
//  Keeping copy in one place means the client can rewrite tone
//  without anyone touching conversation logic.
// ─────────────────────────────────────────────────────────────

async function logOutgoingSafe(phone, message, messageType, state) {
  try {
    await logger.logOutgoing({ phone, message, messageType, state });
  } catch (err) {
    console.error('Logger Error:', err.message);
  }
}


// ─────────────────────────────────────────────────────────────
//  Every outbound message goes out as INTERACTIVE.
//
//  In production, MSG91 plain-text sends were accepted by the API but
//  never reached the handset, while interactive messages always
//  arrived. A validation error the user cannot see is worse than no
//  validation at all — they retype the same wrong value into silence.
//  So notices carry at least one button and travel the path that works.
//
//  WhatsApp caps buttons at 3 and titles at 20 chars.
// ─────────────────────────────────────────────────────────────
async function sendNotice(phone, text, buttons, state, footer) {
  const btns = (buttons && buttons.length ? buttons : [{ id: 'ctl:browse_more', title: 'Main Menu' }])
    .slice(0, 3)
    .map((b) => ({ id: b.id, title: b.title.slice(0, 20) }));
  const result = await msg91.sendButtonMessage(phone, text, btns, undefined, footer);
  await logOutgoingSafe(phone, text, 'interactive', state);
  return result;
}

// ── Doc §1: Welcome + category list ───────────────────────────
async function sendWelcomeMenu(phone, state) {
  const body =
    '\u{1F44B} *Welcome to LauncherDesk!*\n\n' +
    "We're here to help you start, manage and grow your business.\n\n" +
    'Please choose a service below.';

  const sections = [{ title: 'Our Services', rows: MENU_ROWS }];

  const result = await msg91.sendListMessage(phone, body, 'View Services', sections);
  await logOutgoingSafe(phone, body, 'interactive', state);
  return result;
}

// ── Generic step sender ───────────────────────────────────────
// Takes the instruction object produced by flowEngine.renderStep and
// dispatches it to the right MSG91 content type. This is the single
// seam between flow definitions and the wire format — new input
// types only need a case here.
async function sendStep(phone, instruction, state) {
  const { kind, body, header, footer } = instruction;

  if (kind === 'buttons') {
    const result = await msg91.sendButtonMessage(
      phone, body, instruction.buttons, header, footer
    );
    await logOutgoingSafe(phone, body, 'interactive', state);
    return result;
  }

  if (kind === 'list') {
    const result = await msg91.sendListMessage(
      phone, body, instruction.listButton, instruction.sections, header, footer
    );
    await logOutgoingSafe(phone, body, 'interactive', state);
    return result;
  }

  const result = await msg91.sendText(phone, body);
  await logOutgoingSafe(phone, body, 'text', state);
  return result;
}

// ── Validation error (Doc §10) ────────────────────────────────
async function sendValidationError(phone, errorText, state) {
  const text = `\u26A0\uFE0F ${errorText}`;
  return sendNotice(phone, text, [{ id: 'ctl:back', title: 'Back' }], state);
}

// Second consecutive failure — stop looping, offer a human.
async function sendStuckOffer(phone, state) {
  const text =
    "Looks like I'm not getting this right. \u{1F615}\n\n" +
    'Let me connect you with a LauncherDesk expert who can help directly.';
  const buttons = [
    { id: 'ctl:expert',    title: 'Talk to an Expert' },
    { id: 'ctl:browse_more', title: 'Back to Menu' },
  ];
  const result = await msg91.sendButtonMessage(phone, text, buttons);
  await logOutgoingSafe(phone, text, 'interactive', state);
  return result;
}

async function sendAskTypedMobile(phone, state) {
  const text =
    'No problem \u2014 please type the 10-digit mobile number our expert should call.\n\n' +
    '_Example: 9876543210_';
  return sendNotice(phone, text, [{ id: 'ctl:back', title: 'Back' }], state);
}

// ── Doc §11: Summary card ─────────────────────────────────────
async function sendSummary(phone, summaryText, state) {
  const text =
    "Here's a summary of your request:\n\n" +
    summaryText +
    '\n\nShall I go ahead and submit this?';

  const buttons = [
    { id: 'ctl:submit', title: 'Submit' },
    { id: 'ctl:edit',   title: 'Edit' },
  ];

  const result = await msg91.sendButtonMessage(phone, text, buttons);
  await logOutgoingSafe(phone, text, 'interactive', state);
  return result;
}

async function sendEditIntro(phone, state) {
  const text = "\u270F\uFE0F No problem \u2014 let's go through it again. Your previous answers are saved.";
  return sendNotice(phone, text, [{ id: 'ctl:begin', title: 'Continue' }], state);
}

// ── Doc §12: Success ──────────────────────────────────────────
async function sendLeadSuccess(phone, categoryLabel, state) {
  const text =
    '\u{1F389} *Thank you for choosing LauncherDesk!*\n\n' +
    'Your request has been submitted successfully.\n\n' +
    `Our *${categoryLabel}* expert will contact you within *30 minutes* during business hours.`;

  const buttons = [
    { id: 'ctl:browse_more', title: 'Browse Services' },
    { id: 'ctl:visit_web',   title: 'Visit Website' },
  ];

  const result = await msg91.sendButtonMessage(phone, text, buttons);
  await logOutgoingSafe(phone, text, 'interactive', state);
  return result;
}

// ── Doc §9A.1: buyer confirmation, 4 business hour SLA ────────
async function sendBuyerConfirmation(phone, state) {
  const text =
    '\u{1F389} *Thanks!*\n\n' +
    "We're matching you with the best-fit tools for your business.\n\n" +
    "You'll hear from us within *4 business hours*.";

  const buttons = [
    { id: 'ctl:browse_more', title: 'Browse Services' },
    { id: 'ctl:visit_web',   title: 'Visit Website' },
  ];

  const result = await msg91.sendButtonMessage(phone, text, buttons);
  await logOutgoingSafe(phone, text, 'interactive', state);
  return result;
}

// ── Doc §12: seller variant, 2 business day SLA ───────────────
async function sendListingSuccess(phone, state) {
  const text =
    '\u{1F389} *Thank you for choosing LauncherDesk!*\n\n' +
    'Your listing request has been submitted successfully.\n\n' +
    'Our Marketplace team will review your listing and get back to you within *2 business days*.';

  const buttons = [
    { id: 'ctl:browse_more', title: 'Browse Services' },
    { id: 'ctl:visit_web',   title: 'Visit Website' },
  ];

  const result = await msg91.sendButtonMessage(phone, text, buttons);
  await logOutgoingSafe(phone, text, 'interactive', state);
  return result;
}

// ── Doc §9B: duplicate listing detected ───────────────────────
async function sendListingDuplicate(phone, productName, state) {
  const text =
    `Looks like *${productName}* is already listed with us.\n\n` +
    "We've logged this as an update request and our team will review the changes.";

  const buttons = [
    { id: 'ctl:browse_more', title: 'Browse Services' },
    { id: 'ctl:visit_web',   title: 'Visit Website' },
  ];

  const result = await msg91.sendButtonMessage(phone, text, buttons);
  await logOutgoingSafe(phone, text, 'interactive', state);
  return result;
}

// ── Doc §10: 10-minute inactivity reminder ────────────────────
async function sendInactivityReminder(phone, state) {
  const text =
    "\u{1F44B} Still there?\n\n" +
    "You're almost done \u2014 just reply to the last question and we'll get your request submitted.\n\n" +
    '_Type MENU to start over._';
  return sendNotice(phone, text, [{ id: 'ctl:resume', title: 'Continue' }, { id: 'ctl:restart_flow', title: 'Start Over' }], state);
}

// ── Expert handoff ────────────────────────────────────────────
async function sendExpertHandoff(phone, state) {
  const text =
    '\u{1F4AC} *Connecting you with our team...*\n\n' +
    'A LauncherDesk expert will message you shortly.\n\n' +
    'Thank you for your patience! \u{1F64F}';
  return sendNotice(phone, text, [{ id: 'ctl:browse_more', title: 'Main Menu' }], state);
}

async function sendWebsite(phone, url, state) {
  // URL sits on its own line so WhatsApp renders it as a tappable
  // link. Sent as an interactive message because plain text does not
  // reach the handset — the previous version was invisible, so tapping
  // "Visit Website" appeared to do nothing at all.
  const text =
    '\u{1F310} *LauncherDesk*\n\n' +
    'Explore all our services here:\n' +
    `${url}\n\n` +
    'Feel free to message us anytime! \u{1F44B}';
  return sendNotice(
    phone,
    text,
    [{ id: 'ctl:browse_more', title: 'Browse Services' }],
    state
  );
}

// ── Opt-out / opt-in ──────────────────────────────────────────
async function sendOptOutConfirm(phone, state) {
  const text =
    "You've been unsubscribed from LauncherDesk messages. \u2705\n\n" +
    'Reply *START* anytime to opt back in.';
  return sendNotice(phone, text, [{ id: 'ctl:browse_more', title: 'Main Menu' }], state);
}

async function sendOptInConfirm(phone, state) {
  const text =
    "Welcome back! \u{1F44B} You're now subscribed to LauncherDesk updates.\n\n" +
    'Type *MENU* to explore our services.';
  return sendNotice(phone, text, [{ id: 'ctl:browse_more', title: 'Main Menu' }], state);
}

async function sendFallback(phone, state) {
  const text = "I didn't quite catch that. \u{1F914}\n\nLet me show you the menu \u2014 just pick a service:";
  return sendNotice(phone, text, [{ id: 'ctl:browse_more', title: 'Main Menu' }], state);
}


// ── Mid-flow greeting: ask rather than guess ──────────────────
// Sending "Hi" halfway through a flow is ambiguous — it usually means
// "start again", but silently accepting it as an answer produces
// nonsense like "Name: Hi", and silently restarting discards work.
async function sendResumeOrRestart(phone, currentPrompt, state) {
  const text =
    'Hi again! \u{1F44B}\n\n' +
    'You\'re in the middle of a request. Would you like to carry on, or start fresh?\n\n' +
    `_Current question: ${currentPrompt}_`;
  const buttons = [
    { id: 'ctl:resume',       title: 'Continue' },
    { id: 'ctl:restart_flow', title: 'Start Over' },
  ];
  const result = await msg91.sendButtonMessage(phone, text, buttons);
  await logOutgoingSafe(phone, text, 'interactive', state);
  return result;
}

// ── Stale button tap detected ─────────────────────────────────
async function sendStaleTapWarning(phone, tappedTitle, state) {
  const text =
    `That looks like the *${tappedTitle}* button from an earlier question. \u{1F914}\n\n` +
    'Let me ask the current one again:';
  return sendNotice(phone, text, [{ id: 'ctl:back', title: 'Back' }], state);
}


// ── Flow intro: what we're about to ask ───────────────────────
// Sent as an interactive message (not plain text) because plain-text
// sends were not reaching handsets in production.
async function sendFlowIntro(phone, introText, state) {
  const result = await msg91.sendButtonMessage(
    phone, introText, [{ id: 'ctl:begin', title: "Let's Start" }]
  );
  await logOutgoingSafe(phone, introText, 'interactive', state);
  return result;
}

module.exports = {
  sendWelcomeMenu,
  sendStep,
  sendValidationError,
  sendStuckOffer,
  sendAskTypedMobile,
  sendSummary,
  sendEditIntro,
  sendLeadSuccess,
  sendBuyerConfirmation,
  sendListingSuccess,
  sendListingDuplicate,
  sendInactivityReminder,
  sendExpertHandoff,
  sendWebsite,
  sendOptOutConfirm,
  sendOptInConfirm,
  sendFallback,
  sendFlowIntro,
  sendResumeOrRestart,
  sendStaleTapWarning,
  // Kept so any older dashboard/route code that imports it won't crash
  sendMainMenu: sendWelcomeMenu,
};