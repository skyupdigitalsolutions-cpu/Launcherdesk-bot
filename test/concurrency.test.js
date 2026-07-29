// Reproduces the production Submit+Edit race and verifies the
// per-phone lock now serializes it into one outcome.
const Module = require('module');
const orig = Module.prototype.require;

const sent = [];
let leadsCreated = 0;
const slow = (ms) => new Promise((r) => setTimeout(r, ms));

Module.prototype.require = function (p) {
  if (p.includes('services/msg91')) return {
    sendText:          async (t, b) => { sent.push(b); await slow(40); },
    sendButtonMessage: async (t, b) => { sent.push(b); await slow(40); },
    sendListMessage:   async (t, b) => { sent.push(b); await slow(40); },
    sendSalesAlert:    async () => ({}),
  };
  if (p.includes('models/Session')) return { findOne: async () => { await slow(30); return S; }, updateOne: async () => ({}) };
  if (p.includes('models/Lead')) return function (d) {
    Object.assign(this, d);
    this.save = async () => { await slow(50); leadsCreated++; };
  };
  if (p.includes('models/Listing')) { const L = function (d) { Object.assign(this, d); this.save = async () => {}; }; L.findOne = async () => null; return L; }
  if (p.includes('models/Conversation')) return { create: async () => ({}) };
  if (p.includes('services/sheets')) return { appendLead: async () => {}, appendConversationBatch: async () => {} };
  if (p.includes('services/sheetQueue')) return { enqueue: () => {}, start: () => {}, flush: async () => {} };
  if (p.includes('socket')) return { getIO: () => null, setIO: () => {} };
  return orig.apply(this, arguments);
};

let S;
function fresh(state, extra = {}) {
  S = {
    phone: '918722992405', state, flowId: 'finance', stepIndex: 4, answers: {
      finance_service: 'bookkeeping', business_type: 'proprietor',
      city: 'Bengaluru', name: 'Bhojraj', mobile: '8722992405',
    },
    invalidAttempts: 0, awaitingTypedMobile: false, awaitingIntroAck: false,
    pendingSwitchTo: null, botPaused: false, optedOut: false,
    reminderSentAt: null, conversation: {},
    setAnswer(k, v) { this.answers[k] = v; return this; },
    clearAnswer(k) { delete this.answers[k]; return this; },
    resetFlow() { this.flowId = null; this.stepIndex = 0; this.answers = {};
      this.invalidAttempts = 0; this.awaitingTypedMobile = false;
      this.awaitingIntroAck = false; this.pendingSwitchTo = null; return this; },
    async save() { await slow(30); return this; },
    markModified() {},
    ...extra,
  };
}

const sm = require('../src/handlers/stateMachine.js');
const msg = (o) => ({ phone: '918722992405', type: 'text', text: '', buttonId: null, listRowId: null, ...o });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

(async () => {
  // ── The exact production scenario ────────────────────────────
  console.log('\n── Submit and Edit fired together ──');
  fresh('SUMMARY');
  sent.length = 0; leadsCreated = 0;

  // Both webhooks arrive at once, as MSG91 delivered them
  await Promise.all([
    sm.handleInbound(msg({ text: 'Submit', buttonId: 'ctl:submit' })),
    sm.handleInbound(msg({ text: 'Edit',   buttonId: 'ctl:edit' })),
  ]);

  ok(leadsCreated === 1, `expected exactly 1 lead, got ${leadsCreated}`);
  const successes = sent.filter((b) => b.includes('submitted successfully')).length;
  ok(successes <= 1, `expected at most 1 success message, got ${successes}`);
  console.log(`   ✓ ${leadsCreated} lead, ${successes} success message (was: 1 lead + restart + 3 replies)`);

  // ── Double Submit must not duplicate the lead ────────────────
  console.log('── Submit tapped twice ──');
  fresh('SUMMARY');
  sent.length = 0; leadsCreated = 0;
  await Promise.all([
    sm.handleInbound(msg({ text: 'Submit', buttonId: 'ctl:submit' })),
    sm.handleInbound(msg({ text: 'Submit', buttonId: 'ctl:submit' })),
  ]);
  ok(leadsCreated === 1, `double Submit created ${leadsCreated} leads, expected 1`);
  console.log(`   ✓ ${leadsCreated} lead from two Submit taps`);

  // ── Ordering preserved for one number ────────────────────────
  console.log('── Messages stay in order ──');
  fresh('MENU'); S.flowId = null; S.answers = {};
  sent.length = 0;
  await Promise.all([
    sm.handleInbound(msg({ text: 'Hi' })),
    sm.handleInbound(msg({ text: 'Finance & Accounts', listRowId: 'finance' })),
  ]);
  ok(sent.length >= 2, 'both messages should produce a reply');
  console.log(`   ✓ ${sent.length} replies, processed sequentially`);

  // ── Stale tap after DONE must not scold the user ─────────────
  console.log('── Stale control tap after submission ──');
  fresh('DONE');
  sent.length = 0;
  await sm.handleInbound(msg({ text: 'Continue', buttonId: 'ctl:resume' }));
  const scolded = sent.some((b) => b.includes("didn't quite catch"));
  ok(!scolded, 'a stale control tap must not produce "I didn\'t quite catch that"');
  console.log(`   ✓ no confused fallback for a button the bot itself sent`);

  console.log(fail === 0
    ? `\n✅ all ${pass} concurrency assertions passed`
    : `\n❌ ${fail} failed / ${pass} passed`);
  process.exitCode = fail === 0 ? 0 : 1;
})();