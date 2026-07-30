#!/usr/bin/env node
/* eslint-disable no-console */

// ─────────────────────────────────────────────────────────────
//  Data check — what will the portal actually show?
//
//  Run:  npm run data:check
//
//  Answers "is there anything to see?" before you go looking, and
//  reports the same three segments the portal computes so the numbers
//  can be compared directly.
//
//  READ ONLY. Nothing is written, updated or deleted.
//
//  NOTE: your local .env points at the same MongoDB Atlas cluster as
//  production, so these are LIVE figures — not a local copy. That is
//  what makes the portal useful from localhost, and also why nothing
//  here modifies anything.
// ─────────────────────────────────────────────────────────────

require('dotenv').config();
const mongoose = require('mongoose');

const c = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
const rule = () => console.log(c.dim('─'.repeat(64)));

(async () => {
  if (!process.env.MONGO_URI) {
    console.log(c.red('\n  MONGO_URI is not set in .env — nothing to check.\n'));
    process.exit(1);
  }

  console.log('');
  rule();
  console.log(c.b('  WHAT THE PORTAL WILL SHOW'));
  rule();

  await mongoose.connect(process.env.MONGO_URI);

  const Session      = require('./src/models/Session');
  const Lead         = require('./src/models/Lead');
  const Listing      = require('./src/models/Listing');
  const Conversation = require('./src/models/Conversation');

  const dbName = mongoose.connection.name;
  console.log(`\n  Database: ${c.cyan(dbName)}`);
  console.log(c.dim('  This is the same cluster production uses, so these are live.\n'));

  // ── Raw collection sizes ───────────────────────────────────
  const [sessions, leads, listings, messages] = await Promise.all([
    Session.countDocuments(),
    Lead.countDocuments(),
    Listing.countDocuments(),
    Conversation.countDocuments(),
  ]);

  console.log(c.b('  Collections'));
  const row = (n, label, note) => {
    const mark = n > 0 ? c.green('✓') : c.yellow('·');
    console.log(`    ${mark} ${String(n).padStart(6)}  ${label.padEnd(16)} ${c.dim(note || '')}`);
  };
  row(sessions, 'sessions', 'one per WhatsApp number that ever messaged');
  row(messages, 'messages', 'both directions — powers the transcript view');
  row(leads, 'leads', 'submitted + abandoned');
  row(listings, 'listings', 'marketplace seller submissions');

  if (sessions === 0 && messages === 0) {
    console.log(c.yellow('\n  Nothing recorded yet. Send "Hi" to the bot on WhatsApp,'));
    console.log(c.yellow('  then run this again.\n'));
    await mongoose.disconnect();
    return;
  }

  // ── The three portal segments ─────────────────────────────
  // Computed the same way src/routes/portal.js does, so the figures
  // below should match the funnel exactly.
  const { loadSegments } = require('./src/routes/portal');
  const seg = await loadSegments('all');
  const today = await loadSegments('today');

  console.log('\n' + c.b('  Portal funnel (all time)'));
  const stage = (n, label, why) =>
    console.log(`    ${String(n).padStart(6)}  ${label.padEnd(16)} ${c.dim(why)}`);
  stage(seg.said_hi.length,   'Said hi',   'messaged, never picked a service');
  stage(seg.halfway.length,   'Halfway',   'started a service, never submitted');
  stage(seg.submitted.length, 'Submitted', 'completed the form');

  const reached = seg.said_hi.length + seg.halfway.length + seg.submitted.length;
  if (reached) {
    const rate = Math.round((seg.submitted.length / reached) * 100);
    console.log(c.dim(`\n    ${reached} people total · ${rate}% completed`));
  }

  console.log('\n' + c.b('  Today'));
  stage(today.said_hi.length,   'Said hi', '');
  stage(today.halfway.length,   'Halfway', '');
  stage(today.submitted.length, 'Submitted', '');

  // ── Sample rows, so it's clear what the table will look like ──
  if (seg.submitted.length) {
    console.log('\n' + c.b('  Most recent submissions'));
    for (const r of seg.submitted.slice(0, 5)) {
      const when = new Date(r.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      console.log(`    ${(r.name || '—').padEnd(18)} ${(r.mobile || '').padEnd(13)} ` +
                  `${(r.service || '').padEnd(24)} ${c.dim(when)}`);
    }
  }

  if (seg.halfway.length) {
    console.log('\n' + c.b('  Currently stuck (the list worth calling)'));
    for (const r of seg.halfway.slice(0, 5)) {
      const when = new Date(r.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      console.log(`    ${(r.name || '—').padEnd(18)} ${(r.mobile || '').padEnd(13)} ` +
                  `${(r.service || '').padEnd(24)} ${(r.status || '').padEnd(14)} ${c.dim(when)}`);
    }
  }

  // ── Transcript availability ────────────────────────────────
  // The drawer needs Conversation rows. Sessions without any are
  // usually from before message logging was added.
  if (messages > 0) {
    const withMessages = await Conversation.distinct('phone');
    console.log('\n' + c.b('  Transcripts'));
    console.log(`    ${String(withMessages.length).padStart(6)}  numbers have a readable conversation`);
    if (withMessages.length < sessions) {
      console.log(c.dim(`    ${sessions - withMessages.length} session(s) have no messages logged —`));
      console.log(c.dim('    those predate message logging and will show an empty transcript.'));
    }
  } else {
    console.log(c.yellow('\n  No messages in the Conversation collection, so the transcript'));
    console.log(c.yellow('  panel will be empty. Check the [Logger] lines in your server log.'));
  }

  console.log('');
  rule();
  console.log(`  Open ${c.cyan('http://localhost:5173')} — these are the numbers you should see.`);
  rule();
  console.log('');

  await mongoose.disconnect();
})().catch(async (err) => {
  console.log(c.red(`\n  Failed: ${err.message}`));
  if (/ENOTFOUND|ETIMEDOUT|whitelist|IP address/i.test(err.message)) {
    console.log(c.yellow('\n  That looks like a network or Atlas IP allowlist problem.'));
    console.log(c.yellow('  Atlas → Network Access → add your current IP, or 0.0.0.0/0'));
    console.log(c.yellow('  for testing. Railway already has access; your laptop may not.\n'));
  }
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  process.exit(1);
});