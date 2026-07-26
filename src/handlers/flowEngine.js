const { FLOWS } = require('../config/flows');

// ─────────────────────────────────────────────────────────────
//  Flow Engine
//
//  Pure logic — no network, no database, no side effects. Given a
//  flow id, an answers object and the user's latest input, it
//  decides what happens next. That makes the whole conversation
//  layer unit-testable without MSG91 or MongoDB.
//
//  Everything stateful lives in the session; everything
//  declarative lives in config/flows.js.
// ─────────────────────────────────────────────────────────────

const WA_LIST_MAX_ROWS = 10;

// ── Validators (Doc §10) ──────────────────────────────────────
const VALIDATORS = {
  // Doc: "Validate mobile number as a 10-digit Indian number".
  // Accepts +91/91/0 prefixes and spacing, then checks the core 10
  // digits start with 6-9, which is the real Indian mobile range.
  mobile: (raw) => {
    const digits = String(raw || '').replace(/\D/g, '');
    let core = digits;
    if (core.length === 12 && core.startsWith('91')) core = core.slice(2);
    if (core.length === 11 && core.startsWith('0'))  core = core.slice(1);
    if (core.length !== 10) {
      return { ok: false, error: 'That needs to be a 10-digit mobile number.' };
    }
    if (!/^[6-9]/.test(core)) {
      return { ok: false, error: 'An Indian mobile number starts with 6, 7, 8 or 9.' };
    }
    return { ok: true, value: core };
  },

  email: (raw) => {
    const v = String(raw || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v)) {
      return { ok: false, error: "That doesn't look like a valid email.\n_Example: name@company.com_" };
    }
    return { ok: true, value: v };
  },

  name: (raw) => {
    const v = String(raw || '').trim();
    if (v.length < 2) return { ok: false, error: 'Please enter your full name (at least 2 characters).' };
    if (v.length > 60) return { ok: false, error: "That's a bit long — please enter just your name." };
    if (/\d/.test(v))  return { ok: false, error: "Names shouldn't contain numbers. Please try again." };
    // Second line of defence — interpret() catches greetings before
    // this, but a name field is the one place a stray "Hi" does the
    // most damage, so it is rejected here too.
    if (['hi', 'hii', 'hello', 'hey', 'test', 'ok', 'yes', 'no'].includes(v.toLowerCase())) {
      return { ok: false, error: "That doesn't look like a name. What should we call you?" };
    }
    return { ok: true, value: titleCase(v) };
  },

  city: (raw) => {
    const v = String(raw || '').trim();
    if (v.length < 2) return { ok: false, error: 'Please enter your city name.' };
    if (/^\d+$/.test(v)) return { ok: false, error: "That looks like a number — which city are you in?" };
    return { ok: true, value: titleCase(v) };
  },

  free: (raw) => {
    const v = String(raw || '').trim();
    if (v.length < 2) return { ok: false, error: 'Please enter at least 2 characters.' };
    return { ok: true, value: v };
  },
};

function titleCase(str) {
  return str.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

// ─────────────────────────────────────────────────────────────
//  Step resolution
// ─────────────────────────────────────────────────────────────

function getFlow(flowId) {
  return FLOWS[flowId] || null;
}

// Steps whose skipIf() is false given the current answers. This is
// what makes "Step 3 of 6" honest — when DPIIT skips the
// new-vs-existing question the total drops to 5 automatically,
// rather than showing the user a step count that never completes.
function visibleSteps(flow, answers) {
  return flow.steps.filter((s) => !(typeof s.skipIf === 'function' && s.skipIf(answers)));
}

function totalSteps(flow, answers) {
  return visibleSteps(flow, answers).length;
}

// Walk forward from `index` to the next step that isn't skipped.
function nextStepIndex(flow, answers, index) {
  let i = index;
  while (i < flow.steps.length) {
    const step = flow.steps[i];
    if (!(typeof step.skipIf === 'function' && step.skipIf(answers))) return i;
    i++;
  }
  return -1; // flow complete
}

// Walk backwards for the Back control.
function prevStepIndex(flow, answers, index) {
  let i = index - 1;
  while (i >= 0) {
    const step = flow.steps[i];
    if (!(typeof step.skipIf === 'function' && step.skipIf(answers))) return i;
    i--;
  }
  return -1; // already at the first step
}

// Human-readable position, e.g. { current: 3, total: 6 }
function progress(flow, answers, index) {
  const visible = visibleSteps(flow, answers);
  const step = flow.steps[index];
  const pos = visible.findIndex((s) => s.key === step.key);
  return { current: pos + 1, total: visible.length };
}

// ─────────────────────────────────────────────────────────────
//  Rendering — turn a step definition into a send instruction
//
//  Returns a plain object the messages layer knows how to send.
//  Control rows (Back / Skip / Start Over) are appended only while
//  there is room inside WhatsApp's 10-row list ceiling. Priority is
//  Skip > Back > Start Over, because Skip is the only one the user
//  cannot trigger by typing a keyword.
// ─────────────────────────────────────────────────────────────

function renderStep(flow, answers, index, opts = {}) {
  const step = flow.steps[index];
  const { current, total } = progress(flow, answers, index);
  const canGoBack = prevStepIndex(flow, answers, index) !== -1 || opts.backToMenu !== false;

  const header = `Step ${current} of ${total}`;
  let prompt = step.prompt;
  if (!step.required) prompt += '\n_(Optional — tap Skip)_';

  const base = { stepKey: step.key, header, footer: 'LauncherDesk', input: step.input };

  // ── Fixed-choice, 3 or fewer: reply buttons ────────────────
  if (step.input === 'buttons') {
    const buttons = step.options.map((o) => ({ id: `opt:${o.id}`, title: o.title }));
    // Buttons cap at 3 and the options already fill them, so Back
    // and Skip are offered as typed keywords in the footer instead.
    const hints = [];
    if (canGoBack) hints.push('BACK');
    if (!step.required) hints.push('SKIP');
    hints.push('MENU');
    return {
      ...base,
      kind: 'buttons',
      body: prompt,
      buttons,
      footer: `Type ${hints.join(' / ')}`,
    };
  }

  // ── Fixed-choice, more than 3: interactive list ────────────
  if (step.input === 'list') {
    const rows = step.options.map((o) => ({
      id: `opt:${o.id}`,
      title: o.title,
      description: o.description || '',
    }));
    const controls = [];
    if (!step.required) controls.push({ id: 'ctl:skip', title: 'Skip', description: 'Leave this blank' });
    if (canGoBack)      controls.push({ id: 'ctl:back', title: 'Back', description: 'Previous question' });
    controls.push({ id: 'ctl:restart', title: 'Start Over', description: 'Return to main menu' });

    const room = WA_LIST_MAX_ROWS - rows.length;
    const kept = controls.slice(0, Math.max(0, room));
    const dropped = controls.length - kept.length;

    const sections = [{ title: 'Options', rows }];
    if (kept.length) sections.push({ title: 'Navigation', rows: kept });

    return {
      ...base,
      kind: 'list',
      body: prompt,
      listButton: step.listButton || 'Select',
      sections,
      // If a control row had to be dropped for space, surface the
      // typed equivalent so the user is never stuck.
      footer: dropped > 0 ? 'Type BACK or MENU anytime' : 'LauncherDesk',
    };
  }

  // ── Multi-select workaround ────────────────────────────────
  // WhatsApp has no multi-select control. This renders a list of the
  // remaining options plus a Done row; each tap adds one selection
  // and re-renders with the chosen items ticked off, so the user can
  // pick several without leaving the step.
  if (step.input === 'multi') {
    const chosen = Array.isArray(answers[step.key]) ? answers[step.key] : [];
    const remaining = step.options.filter((o) => !chosen.includes(o.id));

    let body = prompt;
    if (chosen.length) {
      const labels = chosen.map((id) => step.options.find((o) => o.id === id)?.title || id);
      body = `${step.prompt}\n\n*Selected:* ${labels.map((l) => `\u2705 ${l}`).join(', ')}\n\n_Tap another, or tap Done to continue._`;
    }

    const rows = remaining.map((o) => ({
      id: `opt:${o.id}`,
      title: o.title,
      description: o.description || '',
    }));
    rows.push({
      id: 'ctl:done',
      title: chosen.length ? 'Done' : 'None of these',
      description: chosen.length ? 'Continue with selection' : 'Skip this question',
    });
    if (rows.length < WA_LIST_MAX_ROWS) {
      rows.push({ id: 'ctl:back', title: 'Back', description: 'Previous question' });
    }

    return {
      ...base,
      kind: 'list',
      body,
      listButton: step.listButton || 'Select',
      sections: [{ title: 'Options', rows }],
      footer: 'Pick as many as you need',
    };
  }

  // ── Mobile number: pre-filled confirmation ─────────────────
  if (step.input === 'mobile_confirm') {
    const guess = VALIDATORS.mobile(opts.waNumber || '');
    if (guess.ok) {
      return {
        ...base,
        kind: 'buttons',
        body: `${prompt}\n\nWe have this one from WhatsApp:\n\u{1F4F1} *${guess.value}*`,
        buttons: [
          { id: 'ctl:mobile_yes', title: 'Yes, use this' },
          { id: 'ctl:mobile_other', title: 'Use another' },
        ],
        footer: 'Type BACK to change an answer',
      };
    }
    // Couldn't derive a valid number from the WhatsApp id — just ask.
    return {
      ...base,
      kind: 'buttons',
      body: `${prompt}\n\n_Type your 10-digit number below_`,
      buttons: [{ id: 'ctl:back', title: 'Back' }],
      footer: 'Type MENU to start over',
    };
  }

  // ── Free text ──────────────────────────────────────────────
  // Rendered as an INTERACTIVE message, not plain text.
  //
  // In production, plain-text sends via MSG91 were not being
  // delivered to the handset while interactive ones always arrived.
  // A question the user never sees is worse than any other bug here:
  // they sit waiting, then re-tap a stale button, which corrupts the
  // answer. Attaching a control turns every question into an
  // interactive payload, which is the path known to work.
  const textButtons = [];
  if (!step.required) textButtons.push({ id: 'ctl:skip', title: 'Skip' });
  if (canGoBack)      textButtons.push({ id: 'ctl:back', title: 'Back' });

  const typeHint = {
    name:   '_Type your full name below_',
    city:   '_Type your city below_',
    email:  '_Type your email below_',
    mobile: '_Type your 10-digit number below_',
  }[step.validate] || '_Type your answer below_';

  return {
    ...base,
    kind: 'buttons',
    body: `${prompt}\n\n${typeHint}`,
    buttons: textButtons.length ? textButtons : [{ id: 'ctl:restart', title: 'Start Over' }],
    // `header` already carries "Step 3 of 5" at the top of the bubble;
    // repeating it in the footer printed the counter twice.
    footer: 'Type MENU to start over',
  };
}

// ─────────────────────────────────────────────────────────────
//  Input interpretation
//
//  Normalises taps and typed text into one of:
//   { action: 'control', control }         Back / Skip / Restart / Done
//   { action: 'answer', value }            a validated answer
//   { action: 'multi_add', value }         one pick in a multi-select
//   { action: 'invalid', error }           validation failed
//   { action: 'unrecognised' }             couldn't interpret
// ─────────────────────────────────────────────────────────────

// Some MSG91 webhook configurations deliver a list/button tap as a
// plain TEXT message containing the row title, with no interactive
// payload and no row id. When that happens every control row arrives
// as bare text like "Done" or "Use another", so matching on id alone
// would strand the user mid-step. This maps the visible title of every
// control back to its control id.
const CONTROL_TITLES = {
  'back':             'back',
  'skip':             'skip',
  'start over':       'restart',
  'restart':          'restart',
  'done':             'done',
  'none of these':    'done',
  'yes, use this':    'mobile_yes',
  'use another':      'mobile_other',
  'back to menu':     'restart',
};

// Bare greetings. MSG91 delivers button taps as plain text, and users
// also send these mid-flow when they want to start again. Either way
// they must never be silently accepted as a name or city.
const GREETINGS = new Set(['hi', 'hii', 'hiii', 'hello', 'helo', 'hey', 'hlo', 'start']);

// A tap on a button from an EARLIER question arrives as plain text
// identical to that button's title. Without this check it would be
// accepted as the answer to whatever free-text question is currently
// open — which is how "City: Already Registered" happens.
function matchesOtherStepOption(flow, index, typed) {
  const t = typed.toLowerCase();
  for (let i = 0; i < flow.steps.length; i++) {
    if (i === index) continue;
    const step = flow.steps[i];
    if (!step.options) continue;
    if (step.options.some((o) => o.title.toLowerCase() === t)) {
      return step.options.find((o) => o.title.toLowerCase() === t).title;
    }
  }
  return null;
}

function interpret(flow, answers, index, input) {
  const step = flow.steps[index];
  const tapped = input.listRowId || input.buttonId || '';
  const typed = String(input.text || '').trim();
  const upper = typed.toUpperCase();

  // ── Typed navigation keywords work at every step ───────────
  if (upper === 'BACK')    return { action: 'control', control: 'back' };
  if (upper === 'RESTART' || upper === 'START OVER') return { action: 'control', control: 'restart' };
  if (upper === 'SKIP' && !step.required)           return { action: 'control', control: 'skip' };

  // ── Tapped control rows ────────────────────────────────────
  if (tapped.startsWith('ctl:')) {
    const control = tapped.slice(4);
    if (control === 'mobile_yes') {
      return { action: 'answer', value: VALIDATORS.mobile(input.waNumber).value };
    }
    if (control === 'mobile_other') return { action: 'control', control: 'mobile_other' };
    return { action: 'control', control };
  }

  // ── Control row arriving as plain text (see CONTROL_TITLES) ──
  // Checked before option matching so a control is never mistaken for
  // an answer, and only for exact matches so it can't swallow a
  // legitimate free-text reply.
  const controlByTitle = CONTROL_TITLES[typed.toLowerCase()];
  if (controlByTitle) {
    if (controlByTitle === 'mobile_yes') {
      const m = VALIDATORS.mobile(input.waNumber);
      if (m.ok) return { action: 'answer', value: m.value };
    }
    if (controlByTitle === 'skip' && step.required) {
      // "Skip" typed on a required step isn't a valid control.
    } else {
      return { action: 'control', control: controlByTitle };
    }
  }

  // ── Tapped an option ───────────────────────────────────────
  if (tapped.startsWith('opt:')) {
    const id = tapped.slice(4);
    const option = step.options?.find((o) => o.id === id);
    if (!option) return { action: 'unrecognised' };
    if (step.input === 'multi') return { action: 'multi_add', value: id };
    return { action: 'answer', value: id, label: option.title };
  }

  // ── Typed text where a choice was expected ─────────────────
  // Users regularly type "GST" instead of tapping. Matching the text
  // against option titles avoids a pointless "I didn't understand".
  if (step.options && typed) {
    const match = step.options.find(
      (o) => o.title.toLowerCase() === typed.toLowerCase() || o.id === typed.toLowerCase()
    );
    if (match) {
      if (step.input === 'multi') return { action: 'multi_add', value: match.id };
      return { action: 'answer', value: match.id, label: match.title };
    }
    return { action: 'unrecognised' };
  }

  // ── Free text / mobile entry ───────────────────────────────
  if (step.input === 'text' || step.input === 'mobile_confirm') {
    // A bare greeting is never a real answer. Users send these to
    // restart, and accepting one silently produces "Name: Hi".
    if (GREETINGS.has(typed.toLowerCase())) {
      return { action: 'greeting' };
    }

    // Text identical to a button from another question is almost
    // certainly a stale tap, not a typed answer.
    const stale = matchesOtherStepOption(flow, index, typed);
    if (stale) {
      return { action: 'stale_tap', tapped: stale };
    }

    const validator = VALIDATORS[step.validate] || VALIDATORS.free;
    const result = validator(typed);
    if (!result.ok) return { action: 'invalid', error: result.error };
    return { action: 'answer', value: result.value };
  }

  return { action: 'unrecognised' };
}

// ─────────────────────────────────────────────────────────────
//  Summary card (Doc §11)
//  Built from the flow definition, so a category with different
//  fields produces a matching summary with no extra code.
// ─────────────────────────────────────────────────────────────

function buildSummary(flow, answers) {
  const lines = [];
  const label = flow.label || flow.id;
  lines.push(`\u{1F3AF} *Service:* ${label}`);

  for (const step of flow.steps) {
    const raw = answers[step.key];
    if (raw === undefined || raw === null || raw === '') continue;
    if (Array.isArray(raw) && raw.length === 0) continue;
    if (step.key === 'name' || step.key === 'mobile') continue; // pinned below

    let display;
    if (Array.isArray(raw)) {
      display = raw
        .map((id) => step.options?.find((o) => o.id === id)?.title || id)
        .join(', ');
    } else if (step.options) {
      display = step.options.find((o) => o.id === raw)?.title || raw;
    } else {
      display = raw;
    }
    lines.push(`\u2022 *${step.label}:* ${display}`);
  }

  if (answers.name)   lines.push(`\u{1F464} *Name:* ${answers.name}`);
  if (answers.mobile) lines.push(`\u{1F4F1} *Mobile:* ${answers.mobile}`);

  // Any question the user chose to skip, shown so they can go back.
  const skipped = flow.steps
    .filter((s) => !s.required && (answers[s.key] === undefined || answers[s.key] === ''))
    .map((s) => s.label);
  if (skipped.length) lines.push(`\n_Not provided: ${skipped.join(', ')}_`);

  return lines.join('\n');
}


// ─────────────────────────────────────────────────────────────
//  Flow intro — "here's what I'll need"
//
//  Sent once when a category is chosen, before the first question.
//  On WhatsApp the user cannot see how long a form is, so without
//  this they have no idea whether they are answering 2 questions or
//  20. Showing the list up front sets expectations, reduces mid-flow
//  drop-off, and makes a silent moment feel like a pause rather than
//  a broken bot.
// ─────────────────────────────────────────────────────────────
function buildIntro(flow, answers = {}) {
  const visible = visibleSteps(flow, answers);
  const items = visible.map((s, i) => {
    const optional = s.required === false ? ' _(optional)_' : '';
    return `${i + 1}. ${s.label}${optional}`;
  });
  return {
    count: visible.length,
    label: flow.label,
    lines: items,
    text:
      `\u{1F4CB} *${flow.label}*\n\n` +
      `I'll need ${visible.length} quick details:\n\n` +
      items.join('\n') +
      `\n\n_Takes about a minute. You can type BACK anytime to change an answer._`,
  };
}

module.exports = {
  getFlow,
  visibleSteps,
  totalSteps,
  nextStepIndex,
  prevStepIndex,
  progress,
  renderStep,
  interpret,
  buildSummary,
  buildIntro,
  VALIDATORS,
  titleCase,
};