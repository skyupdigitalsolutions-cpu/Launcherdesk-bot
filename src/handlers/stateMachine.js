const Session  = require('../models/Session');
const Lead     = require('../models/Lead');
const Listing  = require('../models/Listing');
const messages = require('./messages');
const msg91    = require('../services/msg91');
const sheets   = require('../services/sheets');
const logger   = require('../services/logger');
const engine   = require('./flowEngine');
const { FLOWS } = require('../config/flows');
const { runExclusive } = require('../services/lock');

// ─────────────────────────────────────────────────────────────
//  LauncherDesk Bot — State Machine (Phase 1)
//
//  States:
//   MENU     Waiting for a category pick from the main list
//   FLOW     Inside a category's question sequence
//   SUMMARY  Summary card shown, waiting for Submit / Edit
//   DONE     Lead saved
//   HUMAN    Bot paused, human agent handling
//
//  The per-question logic all lives in config/flows.js and is
//  executed by flowEngine.js. This file only owns transitions
//  between the five states above, persistence, and side effects
//  (Sheets, sales alerts). Adding a category needs no change here.
// ─────────────────────────────────────────────────────────────

// Public entry point. Serialized per phone number so two rapid taps
// (the Submit-then-Edit case seen in production) cannot both read the
// same session state and both act on it.
function handleInbound(parsed) {
  return runExclusive(parsed.phone, () => handleInboundSerial(parsed));
}

async function handleInboundSerial(parsed) {
  const { phone, type, text, buttonId, listRowId } = parsed;
  const upper = String(text || '').toUpperCase().trim();

  const session = await getOrCreate(phone);
  logIncomingSafe(phone, text, type, session.state);
  stampIncoming(session, text);

  // Any inbound message clears a pending reminder — they're active again.
  if (session.reminderSentAt) session.reminderSentAt = null;

  // ── Human takeover ────────────────────────────────────────
  if (session.botPaused) {
    console.log(`[Bot] Paused for ${phone} — human takeover, no auto-reply`);
    await session.save();
    return;
  }

  // ── Opt-out / opt-in ──────────────────────────────────────
  if (upper === 'STOP') {
    session.optedOut = true;
    session.resetFlow();
    session.state = 'MENU';
    await session.save();
    await messages.sendOptOutConfirm(phone, session.state);
    return;
  }

  if (upper === 'START') {
    session.optedOut = false;
    session.resetFlow();
    session.state = 'MENU';
    await session.save();
    await messages.sendOptInConfirm(phone, session.state);
    return;
  }

  if (session.optedOut) {
    console.log(`[Bot] Ignored message from opted-out number ${phone}`);
    return;
  }

  // ── Global menu keywords ──────────────────────────────────
  // Deliberately excludes bare "HI"/"HELLO" while inside a flow:
  // in stage 1 these were checked before state routing, so a user
  // whose name or city legitimately contained them would be thrown
  // back to the menu mid-capture.
  const isMenuKeyword = upper === 'MENU' || upper === 'RESTART' || upper === 'START OVER';
  const isGreeting    = upper === 'HI' || upper === 'HELLO' || upper === 'HEY';

  if (isMenuKeyword || (isGreeting && session.state !== 'FLOW')) {
    session.resetFlow();
    session.state = 'MENU';
    await session.save();
    await messages.sendWelcomeMenu(phone, session.state);
    return;
  }

  console.log(
    `[Bot] ${phone} | ${session.state}` +
    `${session.flowId ? `:${session.flowId}[${session.stepIndex}]` : ''}` +
    ` | ${type} | "${text}" | btn=${buttonId} list=${listRowId}`
  );

  switch (session.state) {
    case 'MENU':    await handleMenu(session, parsed);    break;
    case 'FLOW':    await handleFlow(session, parsed);    break;
    case 'SUMMARY': await handleSummary(session, parsed); break;
    case 'DONE':    await handleDone(session, parsed);    break;

    case 'HUMAN':
      console.log(`[Bot] ${phone} in HUMAN state — skipped`);
      break;

    default:
      console.warn(`[Bot] Unknown state "${session.state}" for ${phone} — resetting`);
      session.resetFlow();
      session.state = 'MENU';
      await session.save();
      await messages.sendWelcomeMenu(phone, session.state);
  }
}

// ─────────────────────────────────────────────────────────────
//  MENU — category selection
// ─────────────────────────────────────────────────────────────

async function handleMenu(session, parsed) {
  const { phone } = parsed;
  const selected = parsed.listRowId || parsed.buttonId || '';

  const upperText = String(parsed.text || '').toUpperCase().trim();
  if (selected === 'expert' || upperText === 'TALK TO AN EXPERT') {
    return handleExpertHandoff(session, phone, 'menu_request');
  }

  // Also accept a typed category name — plenty of users type instead
  // of tapping, and bouncing them to a fallback loses the lead.
  let flowId = FLOWS[selected] && !FLOWS[selected].hidden ? selected : null;
  if (!flowId && parsed.text) {
    const t = parsed.text.toLowerCase().trim();
    const hit = Object.values(FLOWS).find(
      (f) => !f.hidden && (f.menu.title.toLowerCase() === t || f.label.toLowerCase() === t)
    );
    if (hit) flowId = hit.id;
  }

  if (!flowId) {
    // A stale control tap from an older bubble is not the user failing
    // to understand — don't tell them they were unclear, just re-show
    // the list.
    const isStaleControl = selected.startsWith('ctl:') ||
      ['CONTINUE', "LET'S START", 'LETS START', 'SUBMIT', 'EDIT', 'BACK',
       'SKIP', 'DONE', 'STAY HERE', 'START OVER', 'VISIT WEBSITE',
       'BROWSE SERVICES', 'MAIN MENU'].includes(upperText);

    if (!isStaleControl) {
      await messages.sendFallback(phone, session.state);
    }
    await messages.sendWelcomeMenu(phone, session.state);
    return;
  }

  await startFlow(session, phone, flowId);
}

async function startFlow(session, phone, flowId) {
  const flow = engine.getFlow(flowId);
  if (!flow) {
    console.error(`[Bot] startFlow called with unknown flow "${flowId}"`);
    return messages.sendWelcomeMenu(phone, session.state);
  }

  session.state = 'FLOW';
  session.flowId = flowId;
  session.stepIndex = engine.nextStepIndex(flow, session.answers || {}, 0);
  session.invalidAttempts = 0;
  session.awaitingTypedMobile = false;
  await session.save();

  // Tell the user what's coming before asking anything. Branch flows
  // (the marketplace buyer/seller split) skip this — the user has
  // already seen an intro for the parent category and a second one
  // reads as a false restart.
  if (!flow.hidden) {
    const intro = engine.buildIntro(flow, session.answers || {});
    session.awaitingIntroAck = true;
    await session.save();
    await messages.sendFlowIntro(phone, intro.text, session.state);
    return;   // question 1 waits for "Let's Start"
  }

  await sendCurrentStep(session, phone);
}

// ─────────────────────────────────────────────────────────────
//  FLOW — the question engine
// ─────────────────────────────────────────────────────────────

async function handleFlow(session, parsed) {
  const { phone } = parsed;
  const flow = engine.getFlow(session.flowId);

  if (!flow) {
    session.resetFlow();
    session.state = 'MENU';
    await session.save();
    return messages.sendWelcomeMenu(phone, session.state);
  }

  const answers = session.answers || {};
  const step = flow.steps[session.stepIndex];

  if (!step) {
    // Index somehow past the end — treat the flow as complete.
    return showSummary(session, phone);
  }

  // "Use another number" was tapped: the next text is the mobile.
  if (session.awaitingTypedMobile) {
    const check = engine.VALIDATORS.mobile(parsed.text);
    if (!check.ok) {
      return handleInvalid(session, phone, flow, check.error);
    }
    session.awaitingTypedMobile = false;
    session.invalidAttempts = 0;
    session.setAnswer(step.key, check.value);
    return advance(session, phone, flow);
  }

  // Answer to a pending topic-switch offer. Checked first so the
  // reply can never be mistaken for an answer to the open question.
  if (session.pendingSwitchTo) {
    const target = session.pendingSwitchTo;
    const tapped = parsed.listRowId || parsed.buttonId || '';
    const said = String(parsed.text || '').toUpperCase().trim();

    if (tapped === 'ctl:show_menu' || said === 'SHOW SERVICES' || target === 'MENU') {
      // Only treat as confirmed if they actually said yes to it.
      if (tapped === 'ctl:show_menu' || said === 'SHOW SERVICES'
          || said === 'YES' || said === 'SWITCH') {
        session.resetFlow();
        session.state = 'MENU';
        await session.save();
        return messages.sendWelcomeMenu(phone, session.state);
      }
      session.pendingSwitchTo = null;
      await session.save();
      return sendCurrentStep(session, phone);
    }

    if (tapped === 'ctl:switch_yes' || said === 'SWITCH' || said === 'YES') {
      session.pendingSwitchTo = null;
      if (target === 'expert') {
        return handleExpertHandoff(session, phone, 'topic_switch');
      }
      // Fresh start on the new flow. Answers from the abandoned one
      // are dropped deliberately — carrying "office_size" into a
      // legal enquiry would put nonsense on the summary card.
      session.resetFlow();
      await session.save();
      return startFlow(session, phone, target);
    }

    // Anything else means stay. Re-ask so they aren't left hanging.
    session.pendingSwitchTo = null;
    await session.save();
    return sendCurrentStep(session, phone);
  }

  // Waiting on "Let's Start" after the intro. Any reply moves on —
  // if the user types instead of tapping, showing question 1 is still
  // the right response, and being strict here would just strand them.
  if (session.awaitingIntroAck) {
    session.awaitingIntroAck = false;
    await session.save();
    return sendCurrentStep(session, phone);
  }

  // Response to the "continue or start over?" prompt sent after a
  // mid-flow greeting. Checked before interpret() so these titles are
  // never mistaken for an answer to the current question.
  const tappedRaw = parsed.listRowId || parsed.buttonId || '';
  const upperRaw = String(parsed.text || '').toUpperCase().trim();
  if (tappedRaw === 'ctl:resume' || upperRaw === 'CONTINUE'
      || tappedRaw === 'ctl:begin' || upperRaw === "LET'S START") {
    return sendCurrentStep(session, phone);
  }
  if (tappedRaw === 'ctl:restart_flow' || upperRaw === 'START OVER') {
    session.resetFlow();
    session.state = 'MENU';
    await session.save();
    return messages.sendWelcomeMenu(phone, session.state);
  }

  const result = engine.interpret(flow, answers, session.stepIndex, {
    ...parsed,
    waNumber: phone,
  });

  switch (result.action) {
    case 'control':
      return handleControl(session, phone, flow, result.control);

    case 'answer': {
      session.invalidAttempts = 0;
      session.setAnswer(step.key, result.value);

      // Marketplace split hands off to a fresh flow so the step
      // counter restarts at 1, per the doc's "counts separately".
      if (typeof step.branchTo === 'function') {
        const nextFlowId = step.branchTo(result.value);
        if (nextFlowId && FLOWS[nextFlowId]) {
          await session.save();
          return startFlow(session, phone, nextFlowId);
        }
      }
      return advance(session, phone, flow);
    }

    case 'multi_add': {
      const current = Array.isArray(answers[step.key]) ? answers[step.key] : [];
      if (!current.includes(result.value)) current.push(result.value);
      session.setAnswer(step.key, current);
      session.invalidAttempts = 0;
      await session.save();
      // Re-render the same step with the new tick mark.
      return sendCurrentStep(session, phone);
    }

    case 'invalid':
      return handleInvalid(session, phone, flow, result.error);

    // User sent "Hi" mid-flow — almost always they want to start
    // again. Ask instead of guessing: silently accepting it corrupts
    // the answer, silently restarting throws away their progress.
    case 'greeting': {
      await session.save();
      return messages.sendResumeOrRestart(phone, step.prompt, session.state);
    }

    // Text identical to a button from an earlier question. Re-ask the
    // current question rather than storing the stale value. Does not
    // count towards invalidAttempts — the user didn't get it wrong.
    case 'topic_switch': {
      // Ambiguous ("change service", or a term spanning categories):
      // show the list rather than guessing which one they meant.
      if (result.type === 'menu' || !result.flowId) {
        session.pendingSwitchTo = 'MENU';
        await session.save();
        await messages.sendChangeServiceOffer(phone, flow.label, session.state);
        return;
      }
      const target = result.flowId;
      const targetLabel = target === 'expert'
        ? 'Talk to an Expert'
        : (FLOWS[target] && FLOWS[target].label) || target;
      session.pendingSwitchTo = target;
      await session.save();
      await messages.sendTopicSwitchOffer(phone, flow.label, targetLabel, session.state);
      return;
    }

    case 'stale_tap': {
      await session.save();
      await messages.sendStaleTapWarning(phone, result.tapped, session.state);
      return sendCurrentStep(session, phone);
    }

    default:
      return handleInvalid(
        session, phone, flow,
        "Sorry, I didn't catch that. Please pick one of the options below."
      );
  }
}

async function handleControl(session, phone, flow, control) {
  const answers = session.answers || {};
  const step = flow.steps[session.stepIndex];

  if (control === 'restart') {
    session.resetFlow();
    session.state = 'MENU';
    await session.save();
    return messages.sendWelcomeMenu(phone, session.state);
  }

  if (control === 'back') {
    const prev = engine.prevStepIndex(flow, answers, session.stepIndex);
    if (prev === -1) {
      // Already at the first question — Back means "leave the flow".
      session.resetFlow();
      session.state = 'MENU';
      await session.save();
      return messages.sendWelcomeMenu(phone, session.state);
    }
    // Clear the answer we're returning to so the user genuinely
    // re-answers it rather than seeing a stale value on the summary.
    session.clearAnswer(flow.steps[prev].key);
    session.stepIndex = prev;
    session.invalidAttempts = 0;
    session.awaitingTypedMobile = false;
    await session.save();
    return sendCurrentStep(session, phone);
  }

  if (control === 'change_service') {
    session.pendingSwitchTo = 'MENU';
    await session.save();
    return messages.sendChangeServiceOffer(phone, flow.label, session.state);
  }

  if (control === 'skip') {
    if (step.required) {
      return handleInvalid(session, phone, flow, 'This one is required — please answer to continue.');
    }
    session.clearAnswer(step.key);
    session.invalidAttempts = 0;
    return advance(session, phone, flow);
  }

  if (control === 'done') {
    // "Done" only means anything on a multi-select step. Arriving
    // anywhere else it is a stale tap on the add-ons message — which
    // is exactly how a submitted lead ended up with an empty Name.
    // Previously this stored [] and advanced, silently losing the field.
    if (step.input !== 'multi') {
      await messages.sendStaleTapWarning(phone, 'Done', session.state);
      return sendCurrentStep(session, phone);
    }
    const chosen = Array.isArray(answers[step.key]) ? answers[step.key] : [];
    session.setAnswer(step.key, chosen);
    session.invalidAttempts = 0;
    return advance(session, phone, flow);
  }

  if (control === 'mobile_other') {
    session.awaitingTypedMobile = true;
    await session.save();
    return messages.sendAskTypedMobile(phone, session.state);
  }

  return handleInvalid(session, phone, flow, "I didn't understand that option.");
}

// Doc §10: re-prompt once on invalid entry, then offer
// "Talk to an Expert" as the fallback rather than looping forever.
async function handleInvalid(session, phone, flow, errorText) {
  session.invalidAttempts = (session.invalidAttempts || 0) + 1;
  await session.save();

  if (session.invalidAttempts >= 2) {
    await messages.sendStuckOffer(phone, session.state);
    session.invalidAttempts = 0;
    await session.save();
    return;
  }

  await messages.sendValidationError(phone, errorText, session.state);
  return sendCurrentStep(session, phone);
}

async function advance(session, phone, flow) {
  const answers = session.answers || {};
  const next = engine.nextStepIndex(flow, answers, session.stepIndex + 1);

  if (next === -1) {
    return showSummary(session, phone);
  }

  session.stepIndex = next;
  await session.save();
  return sendCurrentStep(session, phone);
}

async function sendCurrentStep(session, phone) {
  const flow = engine.getFlow(session.flowId);
  const instruction = engine.renderStep(flow, session.answers || {}, session.stepIndex, {
    waNumber: phone,
  });
  return messages.sendStep(phone, instruction, session.state);
}

// ─────────────────────────────────────────────────────────────
//  SUMMARY — Doc §11
// ─────────────────────────────────────────────────────────────

async function showSummary(session, phone) {
  const flow = engine.getFlow(session.flowId);
  const summary = engine.buildSummary(flow, session.answers || {});

  session.state = 'SUMMARY';
  await session.save();

  return messages.sendSummary(phone, summary, session.state);
}

async function handleSummary(session, parsed) {
  const { phone } = parsed;
  const tapped = parsed.listRowId || parsed.buttonId || '';
  const upper = String(parsed.text || '').toUpperCase().trim();

  if (tapped === 'ctl:submit' || upper === 'SUBMIT' || upper === 'YES') {
    return submitLead(session, phone);
  }

  if (tapped === 'ctl:edit' || upper === 'EDIT') {
    // Send them back to the first question of the same flow, keeping
    // their answers so each step arrives pre-answered — retyping
    // everything from scratch is what makes users abandon here.
    const flow = engine.getFlow(session.flowId);
    session.state = 'FLOW';
    session.stepIndex = engine.nextStepIndex(flow, session.answers || {}, 0);
    session.invalidAttempts = 0;
    await session.save();
    await messages.sendEditIntro(phone, session.state);
    return sendCurrentStep(session, phone);
  }

  // Titles matched too: some MSG91 setups deliver a button tap as
  // plain text containing the label rather than an interactive payload.
  if (tapped === 'ctl:expert' || upper === 'EXPERT' || upper === 'TALK TO AN EXPERT') {
    return handleExpertHandoff(session, phone, 'summary_request');
  }

  await messages.sendFallback(phone, session.state);
  const flow = engine.getFlow(session.flowId);
  return messages.sendSummary(
    phone,
    engine.buildSummary(flow, session.answers || {}),
    session.state
  );
}

// ─────────────────────────────────────────────────────────────
//  Submission
// ─────────────────────────────────────────────────────────────

async function submitLead(session, phone) {
  const flow = engine.getFlow(session.flowId);
  const a = session.answers || {};

  // Doc §9B: seller submissions are not a service lead — they go to
  // a separate Marketplace Listings review queue.
  if (flow.id === 'mp_seller') {
    return submitListing(session, phone, flow, a);
  }

  const isBuyer = flow.id === 'mp_buyer';

  const lead = new Lead({
    name:          a.name || 'Unknown',
    phone,
    mobile:        a.mobile || phone,
    email:         a.work_email || '',
    businessName:  a.business_name || '',
    city:          a.city || '',
    flowId:        flow.id,
    category:      flow.id,
    categoryLabel: flow.label,
    answers:       a,
    // Doc §9A: "Not Sure – Suggest Based on My Needs" is tagged for
    // manual curation and routed to the expert queue.
    queue:         flow.queue || 'service_leads',
    tags:          buildTags(flow, a),
    status:        'new',
  });
  await lead.save();

  sheets
    .appendLead({ ...a, phone, flowId: flow.id, categoryLabel: flow.label, source: 'whatsapp_bot' })
    .catch((e) => console.error('[Bot] Sheets append error (non-fatal):', e.message));

  notifySales({ ...a, phone, categoryLabel: flow.label });

  session.state = 'DONE';
  await session.save();

  if (isBuyer) {
    // Doc §9A.1 buyer confirmation, with its own 4-hour SLA.
    await messages.sendBuyerConfirmation(phone, session.state);
  } else {
    await messages.sendLeadSuccess(phone, flow.label, session.state);
  }

  console.log(`[Bot] ✅ Lead saved — ${a.name} | ${a.mobile || phone} | ${flow.label}`);

  // Doc §9A: route the "not sure" buyer to a human after capture.
  if (isBuyer && a.tool_category === 'not_sure') {
    await handleExpertHandoff(session, phone, 'marketplace_curation', { silent: true });
  }
}

async function submitListing(session, phone, flow, a) {
  // Doc §9B duplicate check: same mobile + product name is an update
  // request against the existing listing, not a new submission.
  const mobile = a.mobile || phone;
  const productName = (a.product_name || '').trim();

  const existing = await Listing.findOne({
    mobile,
    productName: new RegExp(`^${escapeRegex(productName)}$`, 'i'),
  });

  if (existing) {
    existing.updateRequests.push({
      submittedAt: new Date(),
      changes: a,
    });
    existing.status = 'update_requested';
    await existing.save();

    session.state = 'DONE';
    await session.save();

    await messages.sendListingDuplicate(phone, existing.productName, session.state);
    console.log(`[Bot] ♻️  Listing update request — ${productName} | ${mobile}`);
    return;
  }

  const listing = new Listing({
    productName,
    productCategory: a.product_category || '',
    pricingPlan:     a.pricing_plan || '',
    contactName:     a.name || '',
    workEmail:       a.work_email || '',
    mobile,
    phone,
    queue:           'marketplace_listings',
    status:          'pending_review',
    answers:         a,
  });
  await listing.save();

  sheets
    .appendLead({ ...a, phone, flowId: flow.id, categoryLabel: flow.label, source: 'whatsapp_marketplace_seller' })
    .catch((e) => console.error('[Bot] Sheets append error (non-fatal):', e.message));

  notifySales({ ...a, phone, name: a.name, categoryLabel: 'Marketplace Listing' });

  session.state = 'DONE';
  await session.save();

  await messages.sendListingSuccess(phone, session.state);
  console.log(`[Bot] 🏷️  Listing submitted — ${productName} | ${mobile}`);
}

function buildTags(flow, a) {
  const tags = [];
  if (flow.id === 'mp_buyer') {
    if (a.tool_category) tags.push(`tool:${a.tool_category}`);
    if (a.business_type) tags.push(`type:${a.business_type}`);
    if (a.budget)        tags.push(`budget:${a.budget}`);
    if (a.tool_category === 'not_sure') tags.push('needs_manual_curation');
  }
  if (a.entity_type === 'dpiit') tags.push('dpiit');
  if (Array.isArray(a.addons)) a.addons.forEach((x) => tags.push(`addon:${x}`));
  return tags;
}

// Fire-and-forget: a failed sales alert must never block the user's
// success message or lose the lead, which is already in MongoDB.
function notifySales(leadInfo) {
  const salesNumber = process.env.SALES_WA_NUMBER;
  if (!salesNumber) return;
  msg91
    .sendSalesAlert(salesNumber, leadInfo)
    .catch((e) => console.error('[Bot] Sales alert error (non-fatal):', e.message));
}

// ─────────────────────────────────────────────────────────────
//  DONE
// ─────────────────────────────────────────────────────────────

async function handleDone(session, parsed) {
  const { phone } = parsed;
  const tapped = parsed.listRowId || parsed.buttonId || '';

  const upper = String(parsed.text || '').toUpperCase().trim();

  if (tapped === 'ctl:browse_more' || upper === 'BROWSE SERVICES' || upper === 'BACK TO MENU') {
    session.resetFlow();
    session.state = 'MENU';
    await session.save();
    return messages.sendWelcomeMenu(phone, session.state);
  }

  if (tapped === 'ctl:visit_web' || upper === 'VISIT WEBSITE') {
    // Falls back to the live site if WEBSITE_URL isn't set in Railway.
    const url = process.env.WEBSITE_URL || 'https://www.launcherdesk.com/';
    return messages.sendWebsite(phone, url, session.state);
  }

  if (tapped === 'ctl:expert' || upper === 'TALK TO AN EXPERT') {
    return handleExpertHandoff(session, phone, 'post_submit_request');
  }

  // Stale taps on buttons from EARLIER in the conversation. After a
  // submission the chat is full of them ("Continue", "Let's Start",
  // "Submit", "Edit"), and treating those as unrecognised produced a
  // confusing "I didn't quite catch that" for a button the bot itself
  // had sent. Quietly show the menu instead.
  const STALE_AFTER_DONE = [
    'CONTINUE', "LET'S START", 'LETS START', 'SUBMIT', 'EDIT',
    'BACK', 'SKIP', 'DONE', 'NONE OF THESE', 'STAY HERE',
    'YES, USE THIS', 'USE ANOTHER', 'START OVER', 'CHANGE SERVICE',
  ];
  const staleCtl = tapped.startsWith('ctl:') || STALE_AFTER_DONE.includes(upper);

  session.resetFlow();
  session.state = 'MENU';
  await session.save();
  if (!staleCtl && parsed.text) {
    // Genuinely unrecognised free text — worth acknowledging.
    await messages.sendFallback(phone, session.state);
  }
  return messages.sendWelcomeMenu(phone, session.state);
}

// ─────────────────────────────────────────────────────────────
//  Expert handoff
// ─────────────────────────────────────────────────────────────

async function handleExpertHandoff(session, phone, reason, opts = {}) {
  const a = session.answers || {};
  const flow = session.flowId ? engine.getFlow(session.flowId) : null;

  session.botPaused = true;
  session.state = 'HUMAN';
  await session.save();

  if (!opts.silent) {
    await messages.sendExpertHandoff(phone, session.state);
  }

  notifySales({
    name:          a.name || 'Unknown',
    phone,
    mobile:        a.mobile || phone,
    email:         a.work_email || '',
    businessName:  a.business_name || '',
    city:          a.city || '',
    categoryLabel: flow ? flow.label : 'General Enquiry',
    reason,
  });

  console.log(`[Bot] 🙋 Expert handoff — ${phone} (${reason})`);
}

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────

async function getOrCreate(phone) {
  let session = await Session.findOne({ phone });
  if (!session) {
    session = new Session({ phone, state: 'MENU' });
    await session.save();
  }
  if (!session.answers) session.answers = {};
  return session;
}

// Fire-and-forget. Awaiting this used to add seconds to every reply;
// the message is already safe in MongoDB by the time it matters, and
// a logging failure must never stop the bot from answering.
function logIncomingSafe(phone, message, messageType, state) {
  logger.logIncoming({ phone, message, messageType, state })
    .catch((err) => console.error('Logger Error:', err.message));
}

// The logger no longer touches Session — it was loading a second copy
// of the same document and racing the state machine's writes. These
// fields feed the admin console's conversation list, so they are set
// here on the session instance we already hold, and persist with the
// save that was happening anyway. Zero extra round trips.
function stampIncoming(session, message) {
  if (!session.conversation) session.conversation = {};
  session.conversation.lastIncomingMessage = message;
  session.conversation.lastDirection = 'Incoming';
  session.conversation.unreadCount = (session.conversation.unreadCount || 0) + 1;
  session.conversation.totalMessages = (session.conversation.totalMessages || 0) + 1;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { handleInbound, handleExpertHandoff, startFlow };