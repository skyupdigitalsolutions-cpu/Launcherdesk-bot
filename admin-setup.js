#!/usr/bin/env node
/* eslint-disable no-console */

// ─────────────────────────────────────────────────────────────
//  Admin credential tool — the ONLY way to create portal access
//
//  There is no signup route, no user collection, and no admin record in
//  MongoDB. The single permitted account is defined entirely by two
//  environment variables:
//
//      PORTAL_EMAIL           the one address allowed to sign in
//      ADMIN_PASSWORD_HASH    scrypt hash of that account's password
//
//  That is a deliberate choice, not a shortcut. A signup endpoint on an
//  internal tool is a permanent attack surface for something that
//  happens once. With no endpoint, anyone who finds the portal has
//  nothing to POST to — the only way in is a login form that refuses
//  every address except one.
//
//  Commands:
//      node admin-setup.js                        create or rotate
//      node admin-setup.js --status               show current config
//      node admin-setup.js --verify               test a password
//      node admin-setup.js --email X --password Y non-interactive
// ─────────────────────────────────────────────────────────────

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

require('dotenv').config();

const ENV_PATH = path.join(__dirname, '.env');

const c = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const rule = () => console.log(c.dim('─'.repeat(62)));

// ── scrypt hashing (must match src/services/auth.js) ─────────

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedHex] = parts;
  let derived;
  try {
    derived = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  } catch {
    return false;
  }
  const expected = Buffer.from(expectedHex, 'hex');
  if (expected.length !== derived.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

// ── Prompts ──────────────────────────────────────────────────

let rl = null;

function getReadline() {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  return rl;
}

function closeReadline() {
  if (rl) {
    rl.close();
    rl = null;
  }
}

function ask(question) {
  return new Promise((resolve) =>
    getReadline().question(question, (a) => resolve(String(a).trim()))
  );
}

// Suppresses the echo while a password is typed, keeping it out of both
// the screen and the terminal's scrollback — which is where a shell
// history leak usually comes from.
function askHidden(question) {
  return new Promise((resolve) => {
    const r = getReadline();
    process.stdout.write(question);
    const original = r.output.write.bind(r.output);
    r.output.write = () => true;
    r.question('', (answer) => {
      r.output.write = original;
      process.stdout.write('\n');
      resolve(String(answer).trim());
    });
  });
}

// ── Validation ───────────────────────────────────────────────

function emailProblem(email) {
  if (!email) return 'An email address is required.';
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) {
    return 'That does not look like a valid email address.';
  }
  return null;
}

// Length is what actually resists an offline attack against a stolen
// hash, so it is the hard requirement. The rest is advisory.
function passwordProblems(pw) {
  const hard = [];
  const soft = [];
  const s = String(pw || '');

  if (s.length < 12) hard.push(`at least 12 characters (you have ${s.length})`);
  if (/^\s|\s$/.test(s)) hard.push('no leading or trailing spaces — easy to lose when pasting');

  const guessable = ['password', 'admin', '123456', 'qwerty', 'letmein', 'welcome', 'launcherdesk'];
  if (guessable.some((w) => s.toLowerCase().includes(w))) {
    hard.push('not built around a guessable word like "password" or "admin"');
  }

  if (!/[a-z]/.test(s) || !/[A-Z]/.test(s)) soft.push('mix upper and lower case');
  if (!/[0-9]/.test(s)) soft.push('include a digit');
  if (!/[^A-Za-z0-9]/.test(s)) soft.push('include a symbol');

  return { hard, soft };
}

// ── .env editing ─────────────────────────────────────────────

function readEnvFile() {
  try {
    return fs.readFileSync(ENV_PATH, 'utf8');
  } catch {
    return null;
  }
}

// Replaces a key in place if present, appends if not. Every other line
// including comments is preserved — a naive rewrite would silently drop
// the notes explaining what each variable does.
function upsertEnv(content, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
  return re.test(content)
    ? content.replace(re, line)
    : content.replace(/\s*$/, '') + `\n${line}\n`;
}

// ── Flags ────────────────────────────────────────────────────

function parseFlags(argv) {
  const out = { write: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--email' || a === '-e') out.email = argv[++i];
    else if (a === '--password' || a === '-p') out.password = argv[++i];
    else if (a === '--write' || a === '-w') out.write = true;
    else if (a === '--no-write') out.write = false;
  }
  return out;
}

// ── Output ───────────────────────────────────────────────────

// Hashes, self-verifies, and reports. Shared by the interactive and
// flag-driven paths so the two cannot drift apart.
async function emit(email, password, writeEnv) {
  const hash = hashPassword(password);
  const secret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
  const newSecret = !process.env.SESSION_SECRET;

  // A hash that fails to verify its own password would lock everyone out
  // with no obvious cause, so check before handing it over.
  if (!verifyPassword(password, hash)) {
    console.log(c.red('\n  Internal check failed: the generated hash does not verify.'));
    console.log(c.red('  Nothing was written. Please report this.\n'));
    process.exitCode = 1;
    return;
  }

  console.log('');
  rule();
  console.log(c.green('  ✓ Credentials generated and self-verified'));
  rule();

  const envContent = readEnvFile();
  if (envContent !== null) {
    let doWrite = writeEnv;
    if (doWrite === null) {
      console.log('\n  A .env file exists in this folder.');
      const answer = await ask('  Update it with these values? (y/N) ');
      doWrite = answer.toLowerCase() === 'y';
    }
    if (doWrite) {
      let updated = envContent;
      updated = upsertEnv(updated, 'PORTAL_EMAIL', email);
      updated = upsertEnv(updated, 'ADMIN_PASSWORD_HASH', hash);
      if (newSecret) updated = upsertEnv(updated, 'SESSION_SECRET', secret);

      // Plaintext must go, or on the next boot it silently competes with
      // the hash for anyone who set it earlier.
      if (/^\s*ADMIN_PASSWORD\s*=/m.test(updated)) {
        updated = updated.replace(
          /^\s*ADMIN_PASSWORD\s*=.*$/m,
          '# ADMIN_PASSWORD removed — superseded by ADMIN_PASSWORD_HASH'
        );
        console.log(c.dim('  Commented out the old plaintext ADMIN_PASSWORD.'));
      }

      fs.writeFileSync(ENV_PATH, updated);
      console.log(c.green(`  Wrote to ${ENV_PATH}`));
    }
  }

  console.log(`\n  ${c.b('Set these in Railway → Variables:')}\n`);
  console.log(`    PORTAL_EMAIL=${email}`);
  console.log(`    ADMIN_PASSWORD_HASH=${hash}`);
  console.log(`    SESSION_SECRET=${secret}`);

  if (!newSecret) {
    console.log(c.dim('\n    SESSION_SECRET was already set, so it is reused —'));
    console.log(c.dim('    existing sessions for this same email keep working.'));
  }

  console.log(`\n  ${c.b('Sign in with:')}`);
  console.log(`    Email     ${email}`);
  console.log(`    Password  ${c.dim('(the one you chose — never shown or stored)')}`);

  console.log(c.yellow('\n  If ADMIN_PASSWORD is set anywhere, delete it. The hash takes'));
  console.log(c.yellow('  priority, so a stale plaintext variable is confusing rather'));
  console.log(c.yellow('  than harmful — but remove it.\n'));
  rule();
  console.log('');
}

// ── Commands ─────────────────────────────────────────────────

function showStatus() {
  rule();
  console.log(c.b('  PORTAL ACCESS — current state'));
  rule();

  const email = (process.env.PORTAL_EMAIL || '').trim();
  const hash = process.env.ADMIN_PASSWORD_HASH || '';
  const plain = process.env.ADMIN_PASSWORD || '';
  const secret = process.env.SESSION_SECRET || process.env.ADMIN_SECRET || '';

  console.log('\n  There is no admin record in MongoDB. Access is defined');
  console.log('  entirely by these environment variables.\n');

  const row = (ok, label, detail) =>
    console.log(`  ${ok ? c.green('✓') : c.red('✗')} ${label.padEnd(22)} ${c.dim(detail)}`);

  row(Boolean(email), 'PORTAL_EMAIL', email || 'not set — nobody can sign in');

  if (hash) {
    const wellFormed = /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(hash);
    row(
      wellFormed,
      'ADMIN_PASSWORD_HASH',
      wellFormed ? 'set, well-formed scrypt hash' : 'set but MALFORMED — sign-in will always fail'
    );
  } else if (plain) {
    row(true, 'ADMIN_PASSWORD', 'set as plaintext, hashed at boot');
    console.log(c.yellow("\n      Works, but it sits readable in Railway's dashboard."));
    console.log(c.yellow('      Run this script to switch to ADMIN_PASSWORD_HASH.'));
  } else {
    row(false, 'ADMIN_PASSWORD_HASH', 'not set — nobody can sign in');
  }

  row(
    Boolean(secret),
    'SESSION_SECRET',
    secret ? `set (${secret.length} chars)` : 'not set — falls back to ADMIN_SECRET'
  );

  const origins = (process.env.PORTAL_ORIGINS || '').trim();
  console.log(
    `  ${c.dim('·')} PORTAL_ORIGINS         ` +
    c.dim(origins || 'unset — same-origin mode, cookie is SameSite=Lax')
  );

  const ready = Boolean(email) && (Boolean(hash) || Boolean(plain)) && Boolean(secret);
  console.log('');
  rule();
  console.log(
    ready
      ? `  ${c.green('READY')} — ${c.b(email)} can sign in. Nobody else can.`
      : `  ${c.red('NOT READY')} — run ${c.cyan('node admin-setup.js')} to set it up.`
  );
  rule();
  console.log('');
}

async function verifyCommand(flags) {
  const hash = process.env.ADMIN_PASSWORD_HASH;
  if (!hash) {
    console.log(c.red('\n  ADMIN_PASSWORD_HASH is not set, so there is nothing to verify.\n'));
    process.exitCode = 1;
    return;
  }

  let pw = flags.password;
  if (!pw) {
    if (!process.stdin.isTTY) {
      console.log(c.red('\n  Not a terminal. Pass the password as a flag:\n'));
      console.log(c.cyan('    node admin-setup.js --verify --password "..."\n'));
      process.exitCode = 1;
      return;
    }
    console.log('');
    pw = await askHidden('  Password to test: ');
  }

  const ok = verifyPassword(pw, hash);
  console.log(
    ok
      ? c.green('\n  ✓ That password matches the configured hash.\n')
      : c.red('\n  ✗ That password does NOT match.\n')
  );
  process.exitCode = ok ? 0 : 1;
}

async function setupCommand(flags) {
  // Node's readline does not reliably deliver more than one question
  // callback when stdin is a pipe, so a piped script cannot drive the
  // prompts. Flags cover CI and any non-terminal context.
  const scripted = Boolean(flags.email || flags.password) || !process.stdin.isTTY;

  if (scripted) {
    if (!flags.email || !flags.password) {
      console.log(c.red('\n  Not running in a terminal, so the prompts are unavailable.'));
      console.log('  Pass both values as flags:\n');
      console.log(c.cyan('    node admin-setup.js --email you@example.com --password "your password"\n'));
      console.log(c.yellow('  The password will be visible in your shell history this way.'));
      console.log(c.yellow('  Prefer the interactive form in a real terminal.\n'));
      process.exitCode = 1;
      return;
    }

    const emailErr = emailProblem(flags.email);
    if (emailErr) {
      console.log(c.red(`\n  ${emailErr}\n`));
      process.exitCode = 1;
      return;
    }

    const { hard } = passwordProblems(flags.password);
    if (hard.length) {
      console.log(c.red('\n  That password needs:'));
      hard.forEach((h) => console.log(c.red(`    · ${h}`)));
      console.log('');
      process.exitCode = 1;
      return;
    }

    return emit(flags.email.toLowerCase(), flags.password, flags.write === true);
  }

  rule();
  console.log(c.b('  CREATE PORTAL ACCESS'));
  rule();
  console.log('\n  One account, one email. No signup route exists, so this');
  console.log('  script is the only way to grant access.\n');

  const existing = (process.env.PORTAL_EMAIL || '').trim();
  if (existing) {
    console.log(c.yellow(`  Currently configured: ${c.b(existing)}`));
    console.log(c.dim('  Continuing replaces it. Any active session for the'));
    console.log(c.dim('  previous address stops working immediately.\n'));
    const go = await ask('  Replace it? (y/N) ');
    if (go.toLowerCase() !== 'y') {
      console.log(c.dim('\n  Cancelled. Nothing changed.\n'));
      return;
    }
    console.log('');
  }

  let email = '';
  for (;;) {
    email = await ask('  Email allowed to sign in: ');
    const problem = emailProblem(email);
    if (!problem) break;
    console.log(c.red(`  ${problem}\n`));
  }
  email = email.toLowerCase();

  let password = '';
  for (;;) {
    password = await askHidden('  Password: ');
    const { hard, soft } = passwordProblems(password);

    if (hard.length) {
      console.log(c.red('\n  That password needs:'));
      hard.forEach((h) => console.log(c.red(`    · ${h}`)));
      console.log('');
      continue;
    }

    const again = await askHidden('  Confirm password: ');
    if (again !== password) {
      console.log(c.red('\n  Those did not match. Try again.\n'));
      continue;
    }

    if (soft.length) {
      console.log(c.yellow('\n  Accepted, though it would be stronger if you also:'));
      soft.forEach((s) => console.log(c.yellow(`    · ${s}`)));
    }
    break;
  }

  return emit(email, password, null);
}

function showHelp() {
  console.log(`
  ${c.b('Portal admin credentials')}

    node admin-setup.js              create or rotate the account
    node admin-setup.js --status     show what is configured
    node admin-setup.js --verify     test a password against the hash

  Non-interactive, for CI or where prompts are unavailable:

    node admin-setup.js --email you@example.com --password "..." [--write]

    --write updates .env in place. The password appears in your shell
    history this way, so prefer the interactive form where you can.

  There is no signup route and no admin record in the database. This
  script is the only way to grant portal access.
`);
}

// ── Entry ────────────────────────────────────────────────────

(async () => {
  const argv = process.argv.slice(2);
  const flags = parseFlags(argv);

  const command = argv.find((a) => ['--status', '--verify', '--check', '--help', '-h'].includes(a));

  if (command === '--status') return showStatus();
  if (command === '--verify' || command === '--check') return verifyCommand(flags);
  if (command === '--help' || command === '-h') return showHelp();

  const unknown = argv.find(
    (a, i) =>
      a.startsWith('-') &&
      !['--email', '-e', '--password', '-p', '--write', '-w', '--no-write'].includes(a) &&
      !(i > 0 && ['--email', '-e', '--password', '-p'].includes(argv[i - 1]))
  );
  if (unknown) {
    console.log(c.red(`\n  Unknown option "${unknown}". Try --help.\n`));
    process.exitCode = 1;
    return;
  }

  await setupCommand(flags);
})()
  .catch((err) => {
    console.error(c.red(`\n  Failed: ${err.message}\n`));
    process.exitCode = 1;
  })
  .finally(() => {
    // Without this the process hangs on an open stdin handle.
    closeReadline();
  });