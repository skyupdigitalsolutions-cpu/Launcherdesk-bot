// ─────────────────────────────────────────────────────────────
//  Offline flow tests — no MSG91, no MongoDB.
//
//  flowEngine.js is deliberately pure, which lets us walk every
//  category to completion in memory. Run with: npm test
// ─────────────────────────────────────────────────────────────

const engine = require('../src/handlers/flowEngine');
const { FLOWS, MENU_ROWS } = require('../src/config/flows');

let pass = 0, fail = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) { pass++; } else { fail++; failures.push(msg); }
}

// ── WhatsApp platform limits ───────────────────────────────────
console.log('\n── WhatsApp limits ──');
ok(MENU_ROWS.length <= 10, `main menu has ${MENU_ROWS.length} rows (max 10)`);
MENU_ROWS.forEach((r) => {
  ok(r.title.length <= 24, `menu title "${r.title}" is ${r.title.length} chars (max 24)`);
  ok((r.description || '').length <= 72, `menu desc for "${r.title}" too long`);
});

for (const [id, flow] of Object.entries(FLOWS)) {
  flow.steps.forEach((step, i) => {
    const where = `${id} step ${i + 1} (${step.key})`;

    if (step.input === 'buttons') {
      ok(step.options.length <= 3, `${where}: ${step.options.length} buttons (max 3)`);
      step.options.forEach((o) =>
        ok(o.title.length <= 20, `${where}: button "${o.title}" is ${o.title.length} chars (max 20)`)
      );
    }

    if (step.input === 'list' || step.input === 'multi') {
      step.options.forEach((o) => {
        ok(o.title.length <= 24, `${where}: row "${o.title}" is ${o.title.length} chars (max 24)`);
        ok((o.description || '').length <= 72, `${where}: desc for "${o.title}" too long`);
      });
    }
  });
}

// ── Rendered output never exceeds 10 list rows ─────────────────
console.log('── Rendered row counts ──');
for (const [id, flow] of Object.entries(FLOWS)) {
  flow.steps.forEach((step, i) => {
    const r = engine.renderStep(flow, {}, i, { waNumber: '919876543210' });
    if (r.kind === 'list') {
      const total = r.sections.reduce((n, s) => n + s.rows.length, 0);
      ok(total <= 10, `${id} step ${i + 1} renders ${total} list rows (max 10)`);
    }
    if (r.kind === 'buttons') {
      ok(r.buttons.length <= 3, `${id} step ${i + 1} renders ${r.buttons.length} buttons (max 3)`);
    }
  });
}

// ── Walk every flow to completion ──────────────────────────────
console.log('── Full flow walkthroughs ──');

function walk(flowId, chooser, label) {
  const flow = FLOWS[flowId];
  const answers = {};
  let index = engine.nextStepIndex(flow, answers, 0);
  let guard = 0;
  const path = [];

  while (index !== -1 && guard++ < 40) {
    const step = flow.steps[index];
    const rendered = engine.renderStep(flow, answers, index, { waNumber: '919876543210' });
    const prog = engine.progress(flow, answers, index);

    ok(prog.current >= 1 && prog.current <= prog.total,
      `${label}: progress ${prog.current}/${prog.total} out of range at ${step.key}`);

    const input = chooser(step, rendered);
    const result = engine.interpret(flow, answers, index, { ...input, waNumber: '919876543210' });

    ok(result.action !== 'unrecognised',
      `${label}: input for ${step.key} was unrecognised (${JSON.stringify(input)})`);
    ok(result.action !== 'invalid',
      `${label}: input for ${step.key} failed validation${result.error ? ' — ' + result.error : ''}`);

    if (result.action === 'answer') answers[step.key] = result.value;
    if (result.action === 'control' && result.control === 'skip') delete answers[step.key];
    if (result.action === 'multi_add') {
      answers[step.key] = [...(answers[step.key] || []), result.value];
      continue; // multi-select stays on the same step
    }

    path.push(`${step.key}=${JSON.stringify(answers[step.key])}`);

    if (typeof step.branchTo === 'function') {
      const next = step.branchTo(answers[step.key]);
      if (next && FLOWS[next]) {
        console.log(`   ${label}: branched → ${next}`);
        return { branchedTo: next, answers };
      }
    }

    index = engine.nextStepIndex(flow, answers, index + 1);
  }

  ok(guard < 40, `${label}: flow did not terminate (possible loop)`);

  const summary = engine.buildSummary(flow, answers);
  ok(summary.length > 0, `${label}: empty summary`);
  ok(summary.length <= 1024, `${label}: summary is ${summary.length} chars (WhatsApp body max 1024)`);

  return { answers, summary, path };
}

// Chooser that always picks the first option / valid text
const firstChoice = (step) => {
  if (step.input === 'text') {
    if (step.validate === 'email') return { text: 'founder@acme.com' };
    if (step.validate === 'name')  return { text: 'Rahul Sharma' };
    if (step.validate === 'city')  return { text: 'Bengaluru' };
    return { text: 'Acme Technologies' };
  }
  if (step.input === 'mobile_confirm') return { buttonId: 'ctl:mobile_yes' };
  if (step.input === 'multi')          return { listRowId: 'ctl:done' };
  return { listRowId: `opt:${step.options[0].id}` };
};

for (const flowId of Object.keys(FLOWS)) {
  const r = walk(flowId, firstChoice, flowId);
  console.log(`   ✓ ${flowId}${r.branchedTo ? ' → ' + r.branchedTo : ''}`);
  if (r.branchedTo) walk(r.branchedTo, firstChoice, r.branchedTo);
}

// ── Doc §2 logic note: DPIIT skips the new-vs-existing step ────
console.log('── Conditional skip logic ──');
{
  const flow = FLOWS.biz_reg;
  const dpiit = { entity_type: 'dpiit' };
  const normal = { entity_type: 'pvt_ltd' };

  const dpiitSteps = engine.visibleSteps(flow, dpiit).map((s) => s.key);
  const normalSteps = engine.visibleSteps(flow, normal).map((s) => s.key);

  ok(!dpiitSteps.includes('business_stage'),
    'DPIIT path should skip business_stage');
  ok(normalSteps.includes('business_stage'),
    'Pvt Ltd path should include business_stage');
  ok(engine.totalSteps(flow, dpiit) === engine.totalSteps(flow, normal) - 1,
    `DPIIT total should be one less (got ${engine.totalSteps(flow, dpiit)} vs ${engine.totalSteps(flow, normal)})`);

  console.log(`   ✓ DPIIT: ${engine.totalSteps(flow, dpiit)} steps, standard: ${engine.totalSteps(flow, normal)} steps`);
}

// ── IT Services skip when no registered business ───────────────
{
  const flow = FLOWS.it_services;
  const noBiz = engine.visibleSteps(flow, { has_business: 'no' }).map((s) => s.key);
  ok(!noBiz.includes('business_name'), 'no-business path should skip business_name');
  console.log(`   ✓ IT Services skips business name when has_business=no`);
}

// ── Doc §10: 6-step cap ────────────────────────────────────────
console.log('── Doc §10: max 6 questions per flow ──');
for (const [id, flow] of Object.entries(FLOWS)) {
  if (id === 'marketplace') continue; // the split step, branches immediately
  const n = flow.steps.length;
  ok(n <= 6, `${id} has ${n} steps (doc caps flows at 6)`);
  console.log(`   ${n <= 6 ? '✓' : '✗'} ${id}: ${n} steps`);
}

// ── Mobile validation ──────────────────────────────────────────
console.log('── Mobile validation (Doc §10) ──');
const mobileCases = [
  ['9876543210',     true,  'plain 10-digit'],
  ['919876543210',   true,  '91 prefix'],
  ['+91 98765 43210', true, 'formatted with +91'],
  ['09876543210',    true,  '0 prefix'],
  ['12345',          false, 'too short'],
  ['1234567890',     false, 'starts with 1'],
  ['5876543210',     false, 'starts with 5'],
  ['abcdefghij',     false, 'letters'],
  ['98765432101',    false, '11 digits'],
];
for (const [input, expected, desc] of mobileCases) {
  const r = engine.VALIDATORS.mobile(input);
  ok(r.ok === expected, `mobile "${input}" (${desc}) expected ok=${expected}, got ${r.ok}`);
}
console.log(`   ✓ ${mobileCases.length} mobile cases checked`);

// ── Email + name validation ────────────────────────────────────
ok(engine.VALIDATORS.email('a@b.com').ok, 'valid email rejected');
ok(!engine.VALIDATORS.email('not-an-email').ok, 'invalid email accepted');
ok(!engine.VALIDATORS.email('a@b').ok, 'email without TLD accepted');
ok(engine.VALIDATORS.name('rahul sharma').value === 'Rahul Sharma', 'name not title-cased');
ok(!engine.VALIDATORS.name('R2D2').ok, 'name with digits accepted');
ok(!engine.VALIDATORS.city('12345').ok, 'numeric city accepted');

// ── Typed input instead of tapping ─────────────────────────────
console.log('── Typed-instead-of-tapped fallback ──');
{
  const flow = FLOWS.licenses;
  const r = engine.interpret(flow, {}, 0, { text: 'FSSAI' });
  ok(r.action === 'answer' && r.value === 'fssai', 'typing an option title should match it');

  const r2 = engine.interpret(flow, {}, 0, { text: 'BACK' });
  ok(r2.action === 'control' && r2.control === 'back', 'typed BACK should be a control');

  const r3 = engine.interpret(flow, {}, 0, { text: 'complete nonsense here' });
  ok(r3.action === 'unrecognised', 'nonsense should be unrecognised, not an answer');
  console.log('   ✓ typed titles, BACK keyword, and nonsense all handled');
}

// ── Multi-select accumulation ──────────────────────────────────
console.log('── Multi-select workaround ──');
{
  const flow = FLOWS.biz_reg;
  const addonsIndex = flow.steps.findIndex((s) => s.key === 'addons');
  const answers = { entity_type: 'pvt_ltd', business_stage: 'new', city: 'Pune' };

  let r = engine.interpret(flow, answers, addonsIndex, { listRowId: 'opt:gst' });
  ok(r.action === 'multi_add' && r.value === 'gst', 'first multi pick');
  answers.addons = ['gst'];

  r = engine.interpret(flow, answers, addonsIndex, { listRowId: 'opt:msme' });
  ok(r.action === 'multi_add' && r.value === 'msme', 'second multi pick');
  answers.addons = ['gst', 'msme'];

  const rendered = engine.renderStep(flow, answers, addonsIndex, {});
  ok(rendered.body.includes('GST') && rendered.body.includes('MSME'),
    'selected items should be echoed in the body');
  ok(rendered.sections[0].rows.some((x) => x.id === 'ctl:done'), 'Done row missing');
  ok(!rendered.sections[0].rows.some((x) => x.id === 'opt:gst'),
    'already-selected option should be removed from the list');

  const done = engine.interpret(flow, answers, addonsIndex, { listRowId: 'ctl:done' });
  ok(done.action === 'control' && done.control === 'done', 'Done should end the multi step');
  console.log('   ✓ accumulates picks, ticks them off, removes them, exits on Done');
}

// ── Summary card contents ──────────────────────────────────────
console.log('── Summary card ──');
{
  const flow = FLOWS.biz_reg;
  const answers = {
    entity_type: 'pvt_ltd',
    business_stage: 'new',
    city: 'Bengaluru',
    addons: ['gst', 'trademark'],
    name: 'Rahul Sharma',
    mobile: '9876543210',
  };
  const s = engine.buildSummary(flow, answers);
  ok(s.includes('Private Limited Co.'), 'summary should show option label, not raw id');
  ok(s.includes('GST, Trademark'), 'summary should expand multi-select labels');
  ok(s.includes('Rahul Sharma'), 'summary missing name');
  ok(s.includes('9876543210'), 'summary missing mobile');
  ok(!s.includes('pvt_ltd'), 'summary leaked a raw option id');
  console.log('\n' + s.split('\n').map((l) => '     ' + l).join('\n') + '\n');
}

// ── Back navigation ────────────────────────────────────────────
console.log('── Back navigation ──');
{
  const flow = FLOWS.biz_reg;
  ok(engine.prevStepIndex(flow, {}, 0) === -1, 'Back at step 1 should signal exit');
  const dpiitPrev = engine.prevStepIndex(flow, { entity_type: 'dpiit' }, 2);
  ok(dpiitPrev === 0, `Back from city on DPIIT path should land on step 1, got ${dpiitPrev}`);
  console.log('   ✓ Back respects skipped steps');
}

// ── Taps delivered as PLAIN TEXT (observed MSG91 behaviour) ─────
// The production webhook delivers list/button taps as text messages
// containing the row title, with listRowId and buttonId both null.
// Every flow must therefore be completable using titles alone.
console.log('── Tap-as-plain-text (no row id) ──');

const titleOnly = (step, rendered) => {
  if (step.input === 'text') {
    if (step.validate === 'email') return { text: 'founder@acme.com' };
    if (step.validate === 'name')  return { text: 'Rahul Sharma' };
    if (step.validate === 'city')  return { text: 'Bengaluru' };
    return { text: 'Acme Technologies' };
  }
  // Send the visible label as text, exactly as MSG91 does — no ids.
  if (step.input === 'mobile_confirm') return { text: 'Yes, use this' };
  if (step.input === 'multi')          return { text: 'None of these' };
  return { text: step.options[0].title };
};

for (const flowId of Object.keys(FLOWS)) {
  const r = walk(flowId, titleOnly, `${flowId} (text-only)`);
  console.log(`   ✓ ${flowId} completes with titles only${r.branchedTo ? ' → ' + r.branchedTo : ''}`);
  if (r.branchedTo) walk(r.branchedTo, titleOnly, `${r.branchedTo} (text-only)`);
}

// Control rows specifically, since these have no option to fall back on
{
  const flow = FLOWS.biz_reg;
  const addonsIndex = flow.steps.findIndex((s) => s.key === 'addons');
  const mobileIndex = flow.steps.findIndex((s) => s.key === 'mobile');

  const cases = [
    [addonsIndex, 'Done',          'control', 'done'],
    [addonsIndex, 'None of these', 'control', 'done'],
    [addonsIndex, 'Back',          'control', 'back'],
    [addonsIndex, 'Skip',          'control', 'skip'],
    [0,           'Start Over',    'control', 'restart'],
  ];
  for (const [idx, text, action, control] of cases) {
    const r = engine.interpret(flow, { addons: ['gst'] }, idx, { text, waNumber: '919876543210' });
    ok(r.action === action && r.control === control,
      `typed "${text}" should be control:${control}, got ${r.action}:${r.control}`);
  }

  // "Yes, use this" must resolve to the WhatsApp number as the answer
  const m = engine.interpret(flow, {}, mobileIndex, { text: 'Yes, use this', waNumber: '919876543210' });
  ok(m.action === 'answer' && m.value === '9876543210',
    `typed "Yes, use this" should answer with 9876543210, got ${m.action}:${m.value}`);

  const other = engine.interpret(flow, {}, mobileIndex, { text: 'Use another', waNumber: '919876543210' });
  ok(other.action === 'control' && other.control === 'mobile_other',
    'typed "Use another" should request typed entry');

  // A required step must not be skippable by typing Skip
  const req = engine.interpret(flow, {}, 0, { text: 'Skip', waNumber: '919876543210' });
  ok(req.action !== 'control' || req.control !== 'skip',
    'typed "Skip" must not skip a required step');

  console.log('   ✓ Done / None of these / Back / Skip / Start Over / mobile confirm all resolve from text');
}

// ── Regression: bugs seen in production ────────────────────────
// Both caused by MSG91 delivering taps as plain text with no row id.
console.log('── Production bug regressions ──');
{
  const flow = FLOWS.biz_reg;
  const cityIndex = flow.steps.findIndex((s) => s.key === 'city');
  const nameIndex = flow.steps.findIndex((s) => s.key === 'name');

  // BUG 1: "City: Already Registered"
  // User tapped a button belonging to the PREVIOUS question while the
  // city question was open; it arrived as text and was stored as city.
  const stale = engine.interpret(flow, {}, cityIndex, { text: 'Already Registered' });
  ok(stale.action === 'stale_tap',
    `stale button text must not become a city answer (got ${stale.action})`);
  ok(stale.tapped === 'Already Registered', 'stale tap should report which button');

  // Every option title from every other step must be rejected as a city
  let leaks = 0;
  for (let i = 0; i < flow.steps.length; i++) {
    if (i === cityIndex || !flow.steps[i].options) continue;
    for (const opt of flow.steps[i].options) {
      const r = engine.interpret(flow, {}, cityIndex, { text: opt.title });
      if (r.action === 'answer') leaks++;
    }
  }
  ok(leaks === 0, `${leaks} option titles still accepted as a city`);

  // BUG 2: "Name: Hi"
  // User sent a greeting to restart; it was stored as their name.
  for (const g of ['Hi', 'hi', 'HELLO', 'hey', 'Hii']) {
    const r = engine.interpret(flow, {}, nameIndex, { text: g });
    ok(r.action === 'greeting', `"${g}" must not become a name (got ${r.action})`);
  }
  ok(!engine.VALIDATORS.name('Hi').ok, 'name validator should reject "Hi"');
  ok(!engine.VALIDATORS.name('test').ok, 'name validator should reject "test"');

  // Real answers must still work
  ok(engine.interpret(flow, {}, cityIndex, { text: 'Bengaluru' }).action === 'answer',
    'a real city must still be accepted');
  ok(engine.interpret(flow, {}, nameIndex, { text: 'Rahul Sharma' }).action === 'answer',
    'a real name must still be accepted');
  ok(engine.interpret(flow, {}, cityIndex, { text: 'Hyderabad' }).action === 'answer',
    'city Hyderabad must still be accepted');

  console.log('   ✓ stale taps rejected, greetings caught, real answers unaffected');
}


// ── No question may render as plain text ───────────────────────
// Plain-text sends were not being delivered by MSG91 in production,
// so any step that renders as kind:'text' is an invisible question.
console.log('── Every question must be interactive ──');
{
  let plain = [];
  for (const [id, flow] of Object.entries(FLOWS)) {
    flow.steps.forEach((step, i) => {
      const r = engine.renderStep(flow, {}, i, { waNumber: '919876543210' });
      if (r.kind === 'text') plain.push(`${id} step ${i + 1} (${step.key})`);
      ok(r.kind !== 'text', `${id} step ${i + 1} (${step.key}) renders as plain text — will not be delivered`);
      // Interactive payloads still have to respect the platform caps
      if (r.kind === 'buttons') {
        ok(r.buttons.length >= 1 && r.buttons.length <= 3,
          `${id} step ${i + 1}: ${r.buttons.length} buttons (must be 1-3)`);
        r.buttons.forEach((b) => ok(b.title.length <= 20,
          `${id} step ${i + 1}: button "${b.title}" is ${b.title.length} chars (max 20)`));
      }
    });
  }
  console.log(`   ${plain.length === 0 ? '✓' : '✗'} all steps interactive${plain.length ? ': ' + plain.join(', ') : ''}`);
}

// ── Stray "Done" must not wipe a text answer ───────────────────
// A second tap on the add-ons Done button landed on the name step,
// stored [] and advanced — producing a lead with an empty Name.
console.log('── Stray Done on a text step ──');
{
  const flow = FLOWS.biz_reg;
  const nameIndex = flow.steps.findIndex((s) => s.key === 'name');
  const addonsIndex = flow.steps.findIndex((s) => s.key === 'addons');
  ok(flow.steps[nameIndex].input !== 'multi', 'name step must not be multi');
  ok(flow.steps[addonsIndex].input === 'multi', 'addons step must be multi');
  const r = engine.interpret(flow, {}, nameIndex, { text: 'Done' });
  ok(r.action === 'control' && r.control === 'done',
    'Done is still recognised as a control; the state machine must reject it off-multi');
  console.log('   ✓ Done routed as a control, guarded in handleControl');
}

// ── Flow intro ─────────────────────────────────────────────────
console.log('── Flow intro message ──');
{
  for (const [id, flow] of Object.entries(FLOWS)) {
    if (flow.hidden) continue;
    const intro = engine.buildIntro(flow, {});
    ok(intro.count === engine.visibleSteps(flow, {}).length, `${id} intro count wrong`);
    ok(intro.text.length <= 1024, `${id} intro is ${intro.text.length} chars (WhatsApp body max 1024)`);
    ok(intro.lines.length === intro.count, `${id} intro line count mismatch`);
  }
  // Conditional skips must shrink the intro too
  const dpiit = engine.buildIntro(FLOWS.biz_reg, { entity_type: 'dpiit' });
  const normal = engine.buildIntro(FLOWS.biz_reg, {});
  ok(dpiit.count === normal.count - 1, `DPIIT intro should list one fewer step (${dpiit.count} vs ${normal.count})`);
  ok(!dpiit.text.includes('Stage'), 'DPIIT intro must not list the skipped Stage question');
  console.log(`   ✓ intro lists steps, marks optional, respects skips (${normal.count} vs DPIIT ${dpiit.count})`);
}


// ── Step counter must not be printed twice ─────────────────────
// The header already shows "Step 3 of 5" at the top of the bubble;
// putting it in the footer too printed it once above and once below.
console.log('── No duplicate step counter ──');
{
  let dupes = 0;
  for (const [id, flow] of Object.entries(FLOWS)) {
    flow.steps.forEach((step, i) => {
      const r = engine.renderStep(flow, {}, i, { waNumber: '919876543210' });
      const inHeader = r.header && /Step \d+ of \d+/.test(r.header);
      const inFooter = r.footer && /Step \d+ of \d+/.test(r.footer);
      const inBody   = /Step \d+ of \d+/.test(r.body);
      const places = [inHeader, inFooter, inBody].filter(Boolean).length;
      if (places > 1) dupes++;
      ok(places <= 1, `${id} step ${i + 1}: step counter appears in ${places} places`);
      ok(inHeader || inBody, `${id} step ${i + 1}: step counter missing entirely`);
    });
  }
  console.log(`   ${dupes === 0 ? '✓' : '✗'} counter shown exactly once per step`);
}


// ── Topic switching mid-flow ───────────────────────────────────
console.log('── Topic switch detection ──');
{
  const flow = FLOWS.biz_reg;
  const cityIdx = flow.steps.findIndex((s) => s.key === 'city');
  const nameIdx = flow.steps.findIndex((s) => s.key === 'name');
  const entityIdx = 0;

  // Naming another service should offer a switch, not become the answer
  const switchCases = [
    ['IT Services',                        'it_services'],
    ['Office Setup',                       'office'],
    ['Legal & Compliance',                 'legal'],
    ['actually i need legal & compliance',  'legal'],
    ['Finance & Accounts',                 'finance'],
    ['Talk to an Expert',                  'expert'],
  ];
  for (const [text, expected] of switchCases) {
    const r = engine.interpret(flow, {}, cityIdx, { text });
    ok(r.action === 'topic_switch' && r.flowId === expected,
      `"${text}" should offer switch to ${expected}, got ${r.action}/${r.flowId}`);
  }

  // Real answers must be untouched
  for (const city of ['Bengaluru', 'Mumbai', 'New Delhi', 'Pune', 'Kochi']) {
    const r = engine.interpret(flow, {}, cityIdx, { text: city });
    ok(r.action === 'answer', `city "${city}" must still be accepted, got ${r.action}`);
  }
  ok(engine.interpret(flow, {}, nameIdx, { text: 'Rahul Sharma' }).action === 'answer',
    'real name must still be accepted');

  // A legitimate option in the CURRENT step must win over any switch
  const optCheck = engine.interpret(FLOWS.it_services, {}, 0, { text: 'CRM' });
  ok(optCheck.action === 'answer' && optCheck.value === 'crm',
    'CRM inside IT Services must be an answer, not a switch');

  // Short strings must not trigger switches by accident
  for (const t of ['GST', 'ISO', 'IEC', 'UK', 'no']) {
    const r = engine.interpret(flow, {}, cityIdx, { text: t });
    ok(r.action !== 'topic_switch', `short token "${t}" must not trigger a topic switch`);
  }

  // Must never offer to switch to the flow you're already in
  const same = engine.interpret(flow, {}, cityIdx, { text: 'Business Registration' });
  ok(same.action !== 'topic_switch' || same.flowId !== 'biz_reg',
    'must not offer to switch to the current flow');

  console.log('   ✓ switches offered, real answers and in-flow options unaffected');
}

// ── Results ────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(58));
if (fail === 0) {
  console.log(`✅  ALL ${pass} ASSERTIONS PASSED`);
} else {
  console.log(`❌  ${fail} FAILED / ${pass} passed\n`);
  failures.forEach((f) => console.log('   • ' + f));
}
console.log('═'.repeat(58) + '\n');

process.exit(fail === 0 ? 0 : 1);