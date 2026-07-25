const Session  = require('../models/Session');
const Lead     = require('../models/Lead');
const messages = require('../handlers/messages');
const engine   = require('../handlers/flowEngine');

// ─────────────────────────────────────────────────────────────
//  Inactivity Sweeper (Doc §10)
//
//  "If the user goes inactive for 10 minutes mid-flow, send one
//   reminder; if still inactive after 24 hours, close the session
//   and save partial data as an incomplete lead."
//
//  Runs on an interval inside the web process. That is the right
//  call at this scale — a separate worker or queue would be more
//  infrastructure than a single Railway service needs, and the
//  query is indexed on { state, lastMessageAt } so each tick is
//  cheap. If the bot ever runs on more than one instance, this
//  needs a lock (see NOTE at the bottom) or reminders will double up.
//
//  WHATSAPP CONSTRAINT: the 24-hour customer service window means
//  a free-form reminder is only deliverable while the user has
//  messaged within the last 24h. The 10-minute reminder is safely
//  inside that window. The 24-hour cleanup deliberately sends
//  nothing — it just archives the partial lead — because a
//  free-form message at that boundary would be rejected by Meta
//  and re-engaging requires an approved template instead.
// ─────────────────────────────────────────────────────────────

const TEN_MINUTES = 10 * 60 * 1000;
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
const TICK_INTERVAL = 60 * 1000;   // check every minute

let timer = null;

async function sweepReminders() {
  const cutoff = new Date(Date.now() - TEN_MINUTES);

  // Mid-flow, idle 10+ minutes, no reminder sent yet.
  const stale = await Session.find({
    state: { $in: ['FLOW', 'SUMMARY'] },
    lastMessageAt: { $lt: cutoff },
    reminderSentAt: null,
    botPaused: false,
    optedOut: false,
  }).limit(100);

  for (const session of stale) {
    try {
      await messages.sendInactivityReminder(session.phone, session.state);
      // Written with updateOne so the pre-save hook doesn't refresh
      // lastMessageAt — that would restart the 24h abandon clock and
      // the session would never be archived.
      await Session.updateOne(
        { _id: session._id },
        { $set: { reminderSentAt: new Date() } }
      );
      console.log(`[Reminders] Nudged ${session.phone} (idle in ${session.state})`);
    } catch (err) {
      console.error(`[Reminders] Failed to nudge ${session.phone}:`, err.message);
    }
  }
}

async function sweepAbandoned() {
  const cutoff = new Date(Date.now() - TWENTY_FOUR_HOURS);

  const abandoned = await Session.find({
    state: { $in: ['FLOW', 'SUMMARY'] },
    lastMessageAt: { $lt: cutoff },
    botPaused: false,
  }).limit(100);

  for (const session of abandoned) {
    try {
      await savePartialLead(session);

      // Reset in place rather than deleting — the phone number,
      // opt-out flag and conversation history all stay intact, so a
      // returning user isn't treated as a brand new contact.
      session.resetFlow();
      session.state = 'MENU';
      session.abandonedAt = new Date();
      await session.save();

      console.log(`[Reminders] Archived abandoned session ${session.phone}`);
    } catch (err) {
      console.error(`[Reminders] Failed to archive ${session.phone}:`, err.message);
    }
  }
}

// Only worth storing if they actually gave us something usable —
// a bare category pick with no contact detail is noise in the CRM.
async function savePartialLead(session) {
  const a = session.answers || {};
  const flow = session.flowId ? engine.getFlow(session.flowId) : null;
  if (!flow) return;

  const hasSomething = a.name || a.mobile || a.city || a.business_name || a.product_name;
  if (!hasSomething) {
    console.log(`[Reminders] ${session.phone} abandoned with no usable data — not saved`);
    return;
  }

  const currentStep = flow.steps[session.stepIndex];

  const lead = new Lead({
    name:            a.name || 'Unknown',
    phone:           session.phone,
    mobile:          a.mobile || '',
    email:           a.work_email || '',
    businessName:    a.business_name || a.product_name || '',
    city:            a.city || '',
    flowId:          flow.id,
    category:        flow.id,
    categoryLabel:   flow.label,
    answers:         a,
    queue:           flow.queue || 'service_leads',
    tags:            ['incomplete'],
    status:          'partial',
    isPartial:       true,
    abandonedAtStep: currentStep ? currentStep.key : '',
  });
  await lead.save();
  console.log(`[Reminders] 💾 Partial lead saved — ${session.phone} | ${flow.label}`);
}

async function tick() {
  try {
    await sweepReminders();
    await sweepAbandoned();
  } catch (err) {
    // Never let a sweeper error kill the interval.
    console.error('[Reminders] Sweep error:', err.message);
  }
}

function start() {
  if (timer) return;
  timer = setInterval(tick, TICK_INTERVAL);
  console.log('[Reminders] Inactivity sweeper started (10min nudge / 24h archive)');
  // NOTE: single-instance assumption. If this service is ever scaled
  // to multiple replicas, add a lock (e.g. a findOneAndUpdate claim on
  // each session, or a TTL lock document) before sending, or every
  // replica will send the same user the same reminder.
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick, sweepReminders, sweepAbandoned, savePartialLead };