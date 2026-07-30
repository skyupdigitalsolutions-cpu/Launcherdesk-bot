// Verify segment classification with stubbed models, no MongoDB needed.
const Module = require('module');
const orig = Module.prototype.require;

const SESSIONS = [
  // said hi, nothing more
  { phone: '91100', state: 'MENU', flowId: null, answers: {}, lastMessageAt: new Date(),
    conversation: { totalMessages: 2, lastIncomingMessage: 'Hi' } },
  { phone: '91101', state: 'MENU', flowId: null, answers: {}, lastMessageAt: new Date(),
    conversation: { totalMessages: 1, lastIncomingMessage: 'hello' } },
  // mid-flow right now
  { phone: '91200', state: 'FLOW', flowId: 'finance', stepIndex: 2,
    answers: { finance_service: 'bookkeeping', city: 'Pune' }, lastMessageAt: new Date() },
  { phone: '91201', state: 'SUMMARY', flowId: 'biz_reg', stepIndex: 5,
    answers: { entity_type: 'llp', name: 'Asha', city: 'Kochi' }, lastMessageAt: new Date() },
  // submitted earlier, session reset to MENU — must NOT count as "said hi"
  { phone: '91300', state: 'MENU', flowId: null, answers: {}, lastMessageAt: new Date(),
    conversation: { totalMessages: 14 } },
  // abandoned, archived as a partial lead
  { phone: '91400', state: 'MENU', flowId: null, answers: {}, lastMessageAt: new Date() },
];

const LEADS = [
  { _id: 'a', phone: '91300', name: 'Bhojraj', mobile: '8722992405', isPartial: false,
    categoryLabel: 'Finance & Accounts', city: 'Bengaluru', status: 'new',
    createdAt: new Date(), answers: { finance_service: 'bookkeeping' } },
  { _id: 'b', phone: '91400', name: 'Ravi', mobile: '9845000000', isPartial: true,
    categoryLabel: 'Legal & Compliance', city: 'Chennai', abandonedAtStep: 'city',
    createdAt: new Date(), answers: { legal_service: 'trademark' } },
];

const mkQuery = (data) => {
  const q = { sort: () => q, limit: () => q, lean: async () => data };
  return q;
};

Module.prototype.require = function (p) {
  if (p.includes('models/Session'))      return { find: () => mkQuery(SESSIONS), countDocuments: async () => 0 };
  if (p.includes('models/Lead'))         return { find: () => mkQuery(LEADS) };
  if (p.includes('models/Listing'))      return { countDocuments: async () => 3 };
  if (p.includes('models/Conversation')) return { find: () => mkQuery([]) };
  return orig.apply(this, arguments);
};

const { loadSegments } = require('../src/routes/portal.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

(async () => {
  const s = await loadSegments('all');
  const phones = (arr) => arr.map((r) => r.phone).sort().join(',');

  console.log('\n── Segment classification ──');
  console.log('  said_hi   :', phones(s.said_hi));
  console.log('  halfway   :', phones(s.halfway));
  console.log('  submitted :', phones(s.submitted));
  console.log('');

  ok(phones(s.said_hi) === '91100,91101',
    `said_hi should be 91100,91101 — got ${phones(s.said_hi)}`);
  ok(phones(s.halfway) === '91200,91201,91400',
    `halfway should be 91200,91201,91400 — got ${phones(s.halfway)}`);
  ok(phones(s.submitted) === '91300',
    `submitted should be 91300 — got ${phones(s.submitted)}`);

  // The important edge cases
  ok(!s.said_hi.some((r) => r.phone === '91300'),
    'a completed lead whose session reset to MENU must NOT appear in said_hi');
  ok(!s.said_hi.some((r) => r.phone === '91400'),
    'someone with a partial lead must NOT appear in said_hi');
  ok(s.halfway.some((r) => r.phone === '91400' && !r.live),
    'an archived partial lead should appear in halfway, flagged not-live');
  ok(s.halfway.some((r) => r.phone === '91200' && r.live),
    'a currently mid-flow session should appear in halfway, flagged live');

  // Nobody may appear in two segments at once
  const all = [...s.said_hi, ...s.halfway, ...s.submitted].map((r) => r.phone);
  ok(new Set(all).size === all.length, 'no phone may appear in more than one segment');

  // Display fields the table depends on
  const sub = s.submitted[0];
  ok(sub.name === 'Bhojraj' && sub.mobile === '8722992405', 'submitted row carries name and mobile');
  ok(sub.service === 'Finance & Accounts', 'submitted row carries the service label');
  ok(sub.subService === 'Bookkeeping', `sub-service should be prettified, got "${sub.subService}"`);

  const live = s.halfway.find((r) => r.phone === '91200');
  ok(live.service === 'Finance & Accounts', `halfway should resolve flowId to a label, got "${live.service}"`);
  ok(/^step \d+$/.test(live.status), `halfway status should show progress, got "${live.status}"`);

  const atSummary = s.halfway.find((r) => r.phone === '91201');
  ok(atSummary.status === 'at summary', `a SUMMARY session should read "at summary", got "${atSummary.status}"`);

  console.log(fail === 0
    ? `✅ all ${pass} segment assertions passed`
    : `❌ ${fail} failed / ${pass} passed`);
  process.exitCode = fail === 0 ? 0 : 1;
})();