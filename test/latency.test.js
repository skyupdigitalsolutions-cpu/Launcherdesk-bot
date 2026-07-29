// Measures handler latency with a realistically slow Google Sheets API.
// Before the rewrite, every message awaited four Sheets round trips
// (two per direction), so a 1s API produced ~8s replies.
const Module = require('module');
const orig = Module.prototype.require;

const SHEETS_DELAY = 1000;   // pretend each Sheets call takes 1s
const MONGO_DELAY   = 60;    // and each Mongo op 60ms
let sheetsCalls = 0, mongoOps = 0;

const slow = (ms) => new Promise((r) => setTimeout(r, ms));

Module.prototype.require = function (p) {
  if (p.includes('services/sheets')) {
    return {
      appendConversationBatch: async (rows) => { sheetsCalls++; await slow(SHEETS_DELAY); return {}; },
      appendConversation:      async () => { sheetsCalls++; await slow(SHEETS_DELAY); return {}; },
      updateLeadActivity:      async () => { sheetsCalls++; await slow(SHEETS_DELAY); return {}; },
      appendLead:              async () => { sheetsCalls++; await slow(SHEETS_DELAY); return {}; },
    };
  }
  if (p.includes('services/msg91')) {
    return {
      sendText:          async () => { await slow(120); },
      sendButtonMessage: async () => { await slow(120); },
      sendListMessage:   async () => { await slow(120); },
      sendSalesAlert:    async () => ({}),
    };
  }
  if (p.includes('models/Conversation')) {
    return { create: async () => { mongoOps++; await slow(MONGO_DELAY); return {}; } };
  }
  if (p.includes('models/Session')) {
    return { findOne: async () => { mongoOps++; await slow(MONGO_DELAY); return S; }, updateOne: async () => ({}) };
  }
  if (p.includes('models/Lead')) return function (d) { Object.assign(this, d); this.save = async () => { mongoOps++; await slow(MONGO_DELAY); }; };
  if (p.includes('models/Listing')) { const L = function (d) { Object.assign(this, d); this.save = async () => {}; }; L.findOne = async () => null; return L; }
  if (p.includes('socket')) return { getIO: () => null, setIO: () => {} };
  return orig.apply(this, arguments);
};

const S = {
  phone: '918722992405', state: 'MENU', flowId: null, stepIndex: 0, answers: {},
  invalidAttempts: 0, awaitingTypedMobile: false, awaitingIntroAck: false,
  botPaused: false, optedOut: false, reminderSentAt: null, conversation: {},
  setAnswer(k, v) { this.answers[k] = v; return this; },
  clearAnswer(k) { delete this.answers[k]; return this; },
  resetFlow() { this.flowId = null; this.stepIndex = 0; this.answers = {}; this.invalidAttempts = 0;
    this.awaitingTypedMobile = false; this.awaitingIntroAck = false; this.pendingSwitchTo = null; return this; },
  async save() { mongoOps++; await slow(MONGO_DELAY); return this; },
  markModified() {},
};

const sm = require('../src/handlers/stateMachine.js');

async function time(label, parsed) {
  sheetsCalls = 0; mongoOps = 0;
  const t0 = Date.now();
  await sm.handleInbound({ phone: '918722992405', type: 'text', text: '', buttonId: null, listRowId: null, ...parsed });
  const ms = Date.now() - t0;
  console.log(`  ${String(ms).padStart(5)}ms  ${label}   (sheets calls in path: ${sheetsCalls}, mongo: ${mongoOps})`);
  return ms;
}

(async () => {
  console.log(`\nSimulating Sheets at ${SHEETS_DELAY}ms/call, Mongo at ${MONGO_DELAY}ms/op, MSG91 at 120ms:\n`);
  const times = [];
  times.push(await time('"Hi" → welcome menu',        { text: 'Hi' }));
  times.push(await time('tap Business Registration',  { text: 'Business Registration', listRowId: 'biz_reg' }));
  times.push(await time("tap Let's Start",            { text: "Let's Start", buttonId: 'ctl:begin' }));
  times.push(await time('tap Private Limited Co.',    { text: 'Private Limited Co.', listRowId: 'opt:pvt_ltd' }));
  times.push(await time('tap New Business',           { text: 'New Business', buttonId: 'opt:new' }));
  times.push(await time('type city "Bengaluru"',      { text: 'Bengaluru' }));

  console.log('\n  topic switch mid-flow:');
  await time('type "IT Services" during city step', { text: 'IT Services' });
  await time('tap Switch',                          { text: 'Switch', buttonId: 'ctl:switch_yes' });

  const worst = Math.max(...times);
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  console.log(`\n  average ${avg}ms | slowest ${worst}ms`);

  // The whole point: no Sheets call may sit in the reply path.
  const BUDGET = 1500;
  const ok = worst <= BUDGET;
  console.log(ok
    ? `\n✅ every reply under ${BUDGET}ms (target was 1000-1500ms)`
    : `\n❌ slowest reply ${worst}ms exceeds the ${BUDGET}ms budget`);
  process.exitCode = ok ? 0 : 1;
})();