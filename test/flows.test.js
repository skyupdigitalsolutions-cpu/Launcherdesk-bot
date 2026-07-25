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