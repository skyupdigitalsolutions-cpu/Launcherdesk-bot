const express = require('express');
const router = express.Router();

const Session      = require('../models/Session');
const Lead         = require('../models/Lead');
const Listing      = require('../models/Listing');
const Conversation = require('../models/Conversation');

// ─────────────────────────────────────────────────────────────
//  Admin console
//
//  One page for the ops team: who messaged, what they asked for,
//  and the exact transcript the customer saw.
//
//  AUTH: every route here requires ?secret= matching ADMIN_SECRET.
//  The pre-existing /api/customers and /api/conversations routes had
//  no auth at all — anyone with the URL could read the full customer
//  list. Those are now gated by the same middleware in index.js.
// ─────────────────────────────────────────────────────────────

function requireSecret(req, res, next) {
  const supplied = req.query.secret || req.body?.secret || req.get('x-admin-secret');
  if (!process.env.ADMIN_SECRET) {
    return res.status(503).json({ error: 'ADMIN_SECRET is not configured on the server' });
  }
  if (supplied !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Data: everything the console needs in one call ────────────
router.get('/api/overview', requireSecret, async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [leads, listings, sessions, totalLeads, todayLeads, partialLeads, activeSessions] =
      await Promise.all([
        Lead.find().sort({ createdAt: -1 }).limit(200).lean(),
        Listing.find().sort({ createdAt: -1 }).limit(50).lean(),
        Session.find().sort({ lastMessageAt: -1 }).limit(200).lean(),
        Lead.countDocuments(),
        Lead.countDocuments({ createdAt: { $gte: since } }),
        Lead.countDocuments({ isPartial: true }),
        Session.countDocuments({ state: { $in: ['FLOW', 'SUMMARY'] } }),
      ]);

    // Which category is pulling the most interest — the one number
    // the client will actually ask about.
    const byCategory = {};
    leads.forEach((l) => {
      const k = l.categoryLabel || 'Unknown';
      byCategory[k] = (byCategory[k] || 0) + 1;
    });

    res.json({
      stats: { totalLeads, todayLeads, partialLeads, activeSessions, listings: listings.length },
      byCategory,
      leads,
      listings,
      sessions,
    });
  } catch (err) {
    console.error('[Admin] overview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Full transcript for one number ────────────────────────────
router.get('/api/thread/:phone', requireSecret, async (req, res) => {
  try {
    const phone = req.params.phone;
    const [messages, session, leads] = await Promise.all([
      Conversation.find({ phone }).sort({ createdAt: 1 }).limit(500).lean(),
      Session.findOne({ phone }).lean(),
      Lead.find({ phone }).sort({ createdAt: -1 }).lean(),
    ]);
    res.json({ phone, messages, session, leads });
  } catch (err) {
    console.error('[Admin] thread error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Pause / resume the bot for one number ─────────────────────
router.post('/api/bot/:phone/:action', requireSecret, async (req, res) => {
  try {
    const { phone, action } = req.params;
    if (!['pause', 'resume'].includes(action)) {
      return res.status(400).json({ error: 'action must be pause or resume' });
    }
    const session = await Session.findOne({ phone });
    if (!session) return res.status(404).json({ error: 'No session for that number' });

    session.botPaused = action === 'pause';
    session.state = action === 'pause' ? 'HUMAN' : 'MENU';
    if (action === 'resume') session.resetFlow();
    await session.save();

    res.json({ ok: true, phone, botPaused: session.botPaused });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── The console itself ────────────────────────────────────────
router.get('/', requireSecret, (req, res) => {
  res.type('html').send(PAGE);
});

const PAGE = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LauncherDesk — Inbox</title>
<style>
  /* Palette: cold office paper against ink, with a single amber
     signal reserved for "someone is waiting on you". Nothing else
     in the UI is allowed to use amber, so it always means the same
     thing at a glance across the room. */
  :root {
    --ink:      #12181f;
    --ink-soft: #5b6673;
    --paper:    #f7f8fa;
    --card:     #ffffff;
    --rule:     #e3e7ec;
    --signal:   #d97a1a;   /* new / waiting */
    --settled:  #2f7a63;   /* submitted */
    --stale:    #98a2b0;   /* abandoned */
    --mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace;
    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--paper); color: var(--ink);
    font-family: var(--sans); font-size: 14px; line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  header {
    display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap;
    padding: 18px 24px; background: var(--card); border-bottom: 1px solid var(--rule);
    position: sticky; top: 0; z-index: 10;
  }
  h1 {
    margin: 0; font-size: 15px; font-weight: 650; letter-spacing: -0.01em;
  }
  h1 span { color: var(--ink-soft); font-weight: 400; }
  .stats { display: flex; gap: 22px; margin-left: auto; flex-wrap: wrap; }
  .stat { display: flex; align-items: baseline; gap: 6px; }
  .stat b { font-family: var(--mono); font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .stat span { color: var(--ink-soft); font-size: 12px; }
  .stat.alert b { color: var(--signal); }

  main { display: grid; grid-template-columns: minmax(320px, 420px) 1fr; gap: 0; height: calc(100vh - 61px); }
  @media (max-width: 860px) { main { grid-template-columns: 1fr; height: auto; } .thread { min-height: 60vh; } }

  .list { border-right: 1px solid var(--rule); overflow-y: auto; background: var(--card); }
  .tabs { display: flex; border-bottom: 1px solid var(--rule); position: sticky; top: 0; background: var(--card); z-index: 2; }
  .tab {
    flex: 1; padding: 11px 8px; text-align: center; cursor: pointer; border: 0;
    background: none; font: inherit; font-size: 12.5px; color: var(--ink-soft);
    border-bottom: 2px solid transparent;
  }
  .tab[aria-selected="true"] { color: var(--ink); font-weight: 600; border-bottom-color: var(--ink); }
  .tab:focus-visible { outline: 2px solid var(--ink); outline-offset: -2px; }

  .search { padding: 10px 12px; border-bottom: 1px solid var(--rule); position: sticky; top: 39px; background: var(--card); z-index: 1; }
  .search input {
    width: 100%; padding: 8px 10px; border: 1px solid var(--rule); border-radius: 5px;
    font: inherit; background: var(--paper);
  }
  .search input:focus { outline: 2px solid var(--ink); outline-offset: -1px; }

  .row {
    display: block; width: 100%; text-align: left; padding: 12px 14px;
    border: 0; border-bottom: 1px solid var(--rule); background: none;
    font: inherit; cursor: pointer;
  }
  .row:hover { background: var(--paper); }
  .row[aria-current="true"] { background: #eef2f7; box-shadow: inset 3px 0 0 var(--ink); }
  .row:focus-visible { outline: 2px solid var(--ink); outline-offset: -2px; }
  .row-top { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
  .row-name { font-weight: 600; }
  .row-time { font-size: 11px; color: var(--ink-soft); font-family: var(--mono); white-space: nowrap; }
  .row-sub { color: var(--ink-soft); font-size: 12.5px; margin-top: 2px; }
  .row-phone { font-family: var(--mono); font-size: 12px; color: var(--ink-soft); }

  .pill {
    display: inline-block; padding: 1px 7px; border-radius: 3px; font-size: 10.5px;
    font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase; vertical-align: 1px;
  }
  .pill.new      { background: #fdf0e2; color: var(--signal); }
  .pill.partial  { background: #f1f3f6; color: var(--stale); }
  .pill.done     { background: #e6f2ee; color: var(--settled); }
  .pill.listing  { background: #eceaf7; color: #5b4bb5; }

  /* Signature: the transcript is rendered as the customer saw it.
     An ops person reading a flat log has to imagine the chat; showing
     the actual bubbles means they can spot a confusing message
     immediately, which is exactly the bug class we keep hitting. */
  .thread { overflow-y: auto; padding: 0; display: flex; flex-direction: column; }
  .thread-head {
    padding: 14px 20px; border-bottom: 1px solid var(--rule); background: var(--card);
    position: sticky; top: 0; display: flex; gap: 14px; align-items: center; flex-wrap: wrap;
  }
  .thread-head h2 { margin: 0; font-size: 14px; font-family: var(--mono); }
  .thread-head .meta { color: var(--ink-soft); font-size: 12.5px; }
  .btn {
    margin-left: auto; padding: 6px 12px; border: 1px solid var(--rule); border-radius: 5px;
    background: var(--card); font: inherit; font-size: 12.5px; cursor: pointer;
  }
  .btn:hover { background: var(--paper); }
  .btn:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }

  .answers { padding: 14px 20px; background: #fbfcfd; border-bottom: 1px solid var(--rule); }
  .answers dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 3px 14px; font-size: 13px; }
  .answers dt { color: var(--ink-soft); }
  .answers dd { margin: 0; font-weight: 500; }

  .bubbles { padding: 18px 20px; display: flex; flex-direction: column; gap: 9px; }
  .b { max-width: 74%; padding: 8px 12px; border-radius: 10px; font-size: 13.5px; white-space: pre-wrap; word-break: break-word; }
  .b.in  { align-self: flex-start; background: var(--card); border: 1px solid var(--rule); border-bottom-left-radius: 3px; }
  .b.out { align-self: flex-end; background: #dff3e7; border-bottom-right-radius: 3px; }
  .b-meta { font-size: 10.5px; color: var(--ink-soft); margin-top: 4px; font-family: var(--mono); }

  .empty { padding: 60px 24px; text-align: center; color: var(--ink-soft); }
  .empty p { margin: 0 0 4px; }
  .cats { padding: 12px 14px; border-bottom: 1px solid var(--rule); font-size: 12.5px; }
  .cats div { display: flex; justify-content: space-between; padding: 2px 0; }
  .cats b { font-family: var(--mono); font-variant-numeric: tabular-nums; }
  @media (prefers-reduced-motion: no-preference) { .row, .btn { transition: background .12s ease; } }
</style>
</head>
<body>
<header>
  <h1>LauncherDesk <span>Inbox</span></h1>
  <div class="stats" id="stats"></div>
  <button class="btn" id="refresh">Refresh</button>
</header>

<main>
  <section class="list">
    <div class="tabs" role="tablist">
      <button class="tab" role="tab" aria-selected="true"  data-view="leads">Leads</button>
      <button class="tab" role="tab" aria-selected="false" data-view="sessions">Conversations</button>
      <button class="tab" role="tab" aria-selected="false" data-view="listings">Listings</button>
    </div>
    <div class="search"><input id="q" type="search" placeholder="Search name, number, city…" autocomplete="off"></div>
    <div id="cats" class="cats" hidden></div>
    <div id="rows"></div>
  </section>

  <section class="thread" id="thread">
    <div class="empty"><p>Pick someone on the left.</p><p>Their full WhatsApp transcript appears here.</p></div>
  </section>
</main>

<script>
const SECRET = new URLSearchParams(location.search).get('secret') || '';
let DATA = { leads: [], sessions: [], listings: [], stats: {}, byCategory: {} };
let view = 'leads';
let current = null;

const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function ago(d) {
  if (!d) return '';
  const secs = (Date.now() - new Date(d)) / 1000;
  if (secs < 60)    return Math.floor(secs) + 's';
  if (secs < 3600)  return Math.floor(secs / 60) + 'm';
  if (secs < 86400) return Math.floor(secs / 3600) + 'h';
  return Math.floor(secs / 86400) + 'd';
}

async function api(path) {
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(path + sep + 'secret=' + encodeURIComponent(SECRET));
  if (!r.ok) throw new Error(r.status === 401 ? 'Wrong secret in the URL.' : 'Request failed (' + r.status + ')');
  return r.json();
}

async function load() {
  try {
    DATA = await api('/admin/api/overview');
    renderStats(); renderRows();
  } catch (e) {
    el('rows').innerHTML = '<div class="empty"><p>' + esc(e.message) + '</p></div>';
  }
}

function renderStats() {
  const s = DATA.stats;
  el('stats').innerHTML =
    stat(s.todayLeads, 'today') +
    stat(s.totalLeads, 'total leads') +
    stat(s.activeSessions, 'mid-chat', s.activeSessions > 0) +
    stat(s.partialLeads, 'abandoned') +
    stat(s.listings, 'listings');
}
const stat = (n, label, alert) =>
  '<div class="stat' + (alert ? ' alert' : '') + '"><b>' + (n ?? 0) + '</b><span>' + label + '</span></div>';

function renderRows() {
  const q = el('q').value.trim().toLowerCase();
  const cats = el('cats');

  if (view === 'leads') {
    const entries = Object.entries(DATA.byCategory || {}).sort((a, b) => b[1] - a[1]);
    cats.hidden = entries.length === 0;
    cats.innerHTML = entries.map(([k, v]) => '<div><span>' + esc(k) + '</span><b>' + v + '</b></div>').join('');
  } else { cats.hidden = true; }

  let items = [];
  if (view === 'leads') {
    items = DATA.leads.filter(l => !q ||
      [l.name, l.phone, l.mobile, l.city, l.categoryLabel, l.businessName]
        .some(f => (f || '').toLowerCase().includes(q)))
      .map(l => ({
        phone: l.phone,
        title: l.name || 'Unknown',
        sub: l.categoryLabel + (l.city ? ' · ' + l.city : ''),
        time: l.createdAt,
        pill: l.isPartial ? '<span class="pill partial">abandoned</span>'
             : '<span class="pill new">' + esc(l.status || 'new') + '</span>',
        mobile: l.mobile || l.phone,
      }));
  } else if (view === 'sessions') {
    items = DATA.sessions.filter(s => !q ||
      [s.phone, s.answers?.name, s.answers?.city].some(f => (f || '').toLowerCase().includes(q)))
      .map(s => ({
        phone: s.phone,
        title: (s.answers && s.answers.name) || s.phone,
        sub: s.state + (s.flowId ? ' · ' + s.flowId : '') +
             (s.conversation?.lastIncomingMessage ? ' · "' + s.conversation.lastIncomingMessage.slice(0, 34) + '"' : ''),
        time: s.lastMessageAt,
        pill: s.botPaused ? '<span class="pill partial">human</span>'
             : ['FLOW','SUMMARY'].includes(s.state) ? '<span class="pill new">mid-chat</span>'
             : '<span class="pill done">' + esc(s.state) + '</span>',
        mobile: s.phone,
      }));
  } else {
    items = DATA.listings.filter(l => !q ||
      [l.productName, l.mobile, l.contactName].some(f => (f || '').toLowerCase().includes(q)))
      .map(l => ({
        phone: l.phone || l.mobile,
        title: l.productName,
        sub: (l.productCategory || '') + ' · ' + (l.contactName || ''),
        time: l.createdAt,
        pill: '<span class="pill listing">' + esc(l.status || '') + '</span>',
        mobile: l.mobile,
      }));
  }

  el('rows').innerHTML = items.length ? items.map(i =>
    '<button class="row" data-phone="' + esc(i.phone) + '"' + (current === i.phone ? ' aria-current="true"' : '') + '>' +
      '<div class="row-top"><span class="row-name">' + esc(i.title) + '</span>' +
      '<span class="row-time">' + ago(i.time) + '</span></div>' +
      '<div class="row-sub">' + i.pill + ' ' + esc(i.sub) + '</div>' +
      '<div class="row-phone">' + esc(i.mobile) + '</div>' +
    '</button>').join('')
    : '<div class="empty"><p>Nothing here yet.</p></div>';

  document.querySelectorAll('.row').forEach(r =>
    r.addEventListener('click', () => openThread(r.dataset.phone)));
}

async function openThread(phone) {
  current = phone;
  renderRows();
  el('thread').innerHTML = '<div class="empty"><p>Loading…</p></div>';
  try {
    const t = await api('/admin/api/thread/' + encodeURIComponent(phone));
    const paused = t.session?.botPaused;

    let answers = '';
    const a = t.session?.answers || {};
    const keys = Object.keys(a);
    if (keys.length) {
      answers = '<div class="answers"><dl>' + keys.map(k =>
        '<dt>' + esc(k) + '</dt><dd>' + esc(Array.isArray(a[k]) ? a[k].join(', ') : a[k]) + '</dd>').join('') +
        '</dl></div>';
    }

    const bubbles = (t.messages || []).map(m =>
      '<div class="b ' + (m.direction === 'Incoming' ? 'in' : 'out') + '">' + esc(m.message) +
      '<div class="b-meta">' + new Date(m.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) +
      (m.state ? ' · ' + esc(m.state) : '') + '</div></div>').join('');

    el('thread').innerHTML =
      '<div class="thread-head"><h2>' + esc(phone) + '</h2>' +
        '<span class="meta">' + (t.messages?.length || 0) + ' messages · ' +
        (t.leads?.length || 0) + ' lead(s)</span>' +
        '<button class="btn" id="toggleBot">' + (paused ? 'Resume bot' : 'Pause bot (take over)') + '</button>' +
      '</div>' + answers +
      '<div class="bubbles">' + (bubbles || '<div class="empty"><p>No messages logged.</p></div>') + '</div>';

    const tb = el('toggleBot');
    if (tb) tb.addEventListener('click', async () => {
      tb.disabled = true;
      await fetch('/admin/api/bot/' + encodeURIComponent(phone) + '/' + (paused ? 'resume' : 'pause') +
                  '?secret=' + encodeURIComponent(SECRET), { method: 'POST' });
      openThread(phone); load();
    });

    const wrap = el('thread');
    wrap.scrollTop = wrap.scrollHeight;
  } catch (e) {
    el('thread').innerHTML = '<div class="empty"><p>' + esc(e.message) + '</p></div>';
  }
}

document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.setAttribute('aria-selected', 'false'));
  t.setAttribute('aria-selected', 'true');
  view = t.dataset.view;
  renderRows();
}));
el('q').addEventListener('input', renderRows);
el('refresh').addEventListener('click', load);
setInterval(load, 30000);   // quiet background refresh
load();
</script>
</body>
</html>`;

module.exports = { router, requireSecret };