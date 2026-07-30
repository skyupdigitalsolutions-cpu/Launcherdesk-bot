const express = require('express');
const router = express.Router();

const Session      = require('../models/Session');
const Lead         = require('../models/Lead');
const Listing      = require('../models/Listing');
const Conversation = require('../models/Conversation');
const auth         = require('../services/auth');

// ─────────────────────────────────────────────────────────────
//  Portal API
//
//  Three segments, which together form the lead funnel:
//
//    said_hi    Messaged the bot but never chose a service. They saw
//               the menu and stopped. No lead exists for them.
//
//    halfway    Chose a service and answered at least one question but
//               never tapped Submit. Either still mid-flow right now,
//               or archived as an incomplete lead by the 24h sweeper.
//               This is the segment worth calling — they declared
//               intent and got interrupted.
//
//    submitted  Tapped Submit. A complete lead.
//
//  These are computed from live data rather than stored as a status
//  field, because a stored status drifts the moment anything changes
//  the session and nobody remembers to update it.
// ─────────────────────────────────────────────────────────────

const MID_FLOW_STATES = ['FLOW', 'SUMMARY'];

// ─────────────────────────────────────────────────────────────
//  CORS — only active when the frontend is hosted separately
//
//  If PORTAL_ORIGINS is empty the frontend is served by this same
//  server, no CORS headers are emitted, and the cookie stays
//  SameSite=Lax. Setting PORTAL_ORIGINS switches on cross-origin
//  support for exactly the listed origins.
//
//  Never uses '*'. A wildcard origin is incompatible with
//  credentialed requests, and this API returns customer data.
// ─────────────────────────────────────────────────────────────
router.use((req, res, next) => {
  const allowed = auth.allowedOrigins();
  if (allowed.length === 0) return next();

  const origin = (req.headers.origin || '').replace(/\/$/, '');
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  }

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─────────────────────────────────────────────────────────────
//  CSRF guard for state-changing requests
//
//  Needed specifically because cross-origin mode sets SameSite=None,
//  which tells the browser to attach the session cookie to requests
//  originating from ANY site. Without this check, a page the signed-in
//  user visits could POST to /api/auth/logout, or worse, and the cookie
//  would ride along.
//
//  In same-origin mode SameSite=Lax already blocks that, so the check
//  is a second layer rather than the only one.
// ─────────────────────────────────────────────────────────────
function requireTrustedOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();

  const allowed = auth.allowedOrigins();
  const origin = (req.headers.origin || '').replace(/\/$/, '');

  // No Origin header means a non-browser client (curl, a server-side
  // script). Those have no ambient cookie to abuse, so they are fine.
  if (!origin) return next();

  if (allowed.length === 0) {
    // Same-origin deployment: the only legitimate Origin is this host.
    const host = req.headers.host;
    const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    if (origin === `${proto}://${host}`) return next();
    return res.status(403).json({ error: 'Request blocked: unrecognised origin' });
  }

  if (allowed.includes(origin)) return next();
  return res.status(403).json({ error: 'Request blocked: unrecognised origin' });
}

router.use(requireTrustedOrigin);

// ── Auth ─────────────────────────────────────────────────────

router.post('/api/auth/login', express.json(), async (req, res) => {
  const { email, password } = req.body || {};

  const result = auth.checkCredentials(email, password);

  if (!result.ok && result.reason === 'not_configured') {
    return res.status(503).json({
      error: 'Sign-in is not set up yet',
      detail: `Missing on the server: ${result.missing.join(', ')}`,
    });
  }

  if (!result.ok) {
    // Deliberately identical for a wrong email and a wrong password, so
    // the form can't be used to discover which address is allowed.
    return res.status(401).json({ error: 'That email and password combination is not recognised' });
  }

  auth.setSessionCookie(res, auth.createToken(result.email), req);
  res.json({ ok: true, email: result.email });
});

router.post('/api/auth/logout', (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/api/auth/me', (req, res) => {
  const session = auth.verifyToken(auth.readCookie(req));
  if (!session) return res.status(401).json({ error: 'Not signed in' });
  res.json({ email: session.email, expiresAt: new Date(session.exp).toISOString() });
});

// Everything past this point requires a valid session.
router.use('/api/data', auth.requireLogin);

// ── Segment queries ──────────────────────────────────────────

function sinceFilter(range) {
  if (range === 'today') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (range === '7d')  return new Date(Date.now() - 7  * 864e5);
  if (range === '30d') return new Date(Date.now() - 30 * 864e5);
  return null;   // all time
}

async function loadSegments(range) {
  const since = sinceFilter(range);
  const leadWhen    = since ? { createdAt: { $gte: since } } : {};
  const sessionWhen = since ? { lastMessageAt: { $gte: since } } : {};

  const [allLeads, sessions] = await Promise.all([
    Lead.find(leadWhen).sort({ createdAt: -1 }).limit(5000).lean(),
    Session.find(sessionWhen).sort({ lastMessageAt: -1 }).limit(5000).lean(),
  ]);

  const completed = allLeads.filter((l) => !l.isPartial);
  const partial   = allLeads.filter((l) => l.isPartial);

  const completedPhones = new Set(completed.map((l) => l.phone));
  const partialPhones   = new Set(partial.map((l) => l.phone));

  // submitted — one entry per completed lead
  const submitted = completed.map((l) => ({
    phone: l.phone,
    name: l.name || 'Unknown',
    mobile: l.mobile || l.phone,
    service: l.categoryLabel || l.flowId || '',
    subService: subServiceOf(l.answers),
    city: l.city || '',
    business: l.businessName || '',
    email: l.email || '',
    status: l.status || 'new',
    at: l.createdAt,
    answers: l.answers || {},
    leadId: String(l._id),
  }));

  // halfway — live mid-flow sessions, plus archived partial leads.
  // A phone that later completed is excluded: they're not stuck.
  const halfwayMap = new Map();

  for (const s of sessions) {
    if (!MID_FLOW_STATES.includes(s.state)) continue;
    if (completedPhones.has(s.phone)) continue;
    const a = s.answers || {};
    halfwayMap.set(s.phone, {
      phone: s.phone,
      name: a.name || 'Unknown',
      mobile: a.mobile || s.phone,
      service: labelForFlow(s.flowId),
      subService: subServiceOf(a),
      city: a.city || '',
      business: a.business_name || a.product_name || '',
      email: a.work_email || '',
      status: s.state === 'SUMMARY' ? 'at summary' : `step ${(s.stepIndex || 0) + 1}`,
      at: s.lastMessageAt,
      answers: a,
      live: true,
    });
  }

  for (const l of partial) {
    if (completedPhones.has(l.phone)) continue;
    if (halfwayMap.has(l.phone)) continue;
    halfwayMap.set(l.phone, {
      phone: l.phone,
      name: l.name || 'Unknown',
      mobile: l.mobile || l.phone,
      service: l.categoryLabel || '',
      subService: subServiceOf(l.answers),
      city: l.city || '',
      business: l.businessName || '',
      email: l.email || '',
      status: l.abandonedAtStep ? `left at ${l.abandonedAtStep}` : 'abandoned',
      at: l.createdAt,
      answers: l.answers || {},
      live: false,
    });
  }
  const halfway = [...halfwayMap.values()].sort((a, b) => new Date(b.at) - new Date(a.at));

  // said_hi — messaged, never picked a service, nothing recorded
  const saidHi = sessions
    .filter((s) => {
      if (completedPhones.has(s.phone) || partialPhones.has(s.phone)) return false;
      if (MID_FLOW_STATES.includes(s.state)) return false;
      const a = s.answers || {};
      // If any answer exists they progressed past the menu, so they
      // belong in halfway rather than here.
      return Object.keys(a).length === 0;
    })
    .map((s) => ({
      phone: s.phone,
      name: 'Unknown',
      mobile: s.phone,
      service: '',
      subService: '',
      city: '',
      business: '',
      email: '',
      status: s.botPaused ? 'with an agent' : 'browsing',
      at: s.lastMessageAt,
      firstSeen: s.conversation?.firstMessageAt || s.createdAt,
      messages: s.conversation?.totalMessages || 0,
      lastSaid: s.conversation?.lastIncomingMessage || '',
      answers: {},
    }));

  return { said_hi: saidHi, halfway, submitted };
}

// The most specific thing the person chose — without it every row just
// reads "Business Registration" with no clue whether it's an LLP or a Trust.
function subServiceOf(a = {}) {
  const keys = ['entity_type', 'license_type', 'finance_service', 'it_need',
                'legal_service', 'intl_need', 'office_need', 'tool_category',
                'product_category', 'country'];
  for (const k of keys) if (a[k]) return prettify(a[k]);
  return '';
}

function prettify(v) {
  if (Array.isArray(v)) return v.map(prettify).join(', ');
  return String(v).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

let FLOW_LABELS = null;
function labelForFlow(flowId) {
  if (!flowId) return '';
  if (!FLOW_LABELS) {
    try {
      const { FLOWS } = require('../config/flows');
      FLOW_LABELS = Object.fromEntries(
        Object.values(FLOWS).map((f) => [f.id, f.label])
      );
    } catch {
      FLOW_LABELS = {};
    }
  }
  return FLOW_LABELS[flowId] || prettify(flowId);
}

// ── Overview: counts, funnel, breakdowns ─────────────────────

router.get('/api/data/overview', async (req, res) => {
  try {
    const range = req.query.range || 'all';
    const segments = await loadSegments(range);

    const counts = {
      said_hi: segments.said_hi.length,
      halfway: segments.halfway.length,
      submitted: segments.submitted.length,
    };
    const reached = counts.said_hi + counts.halfway + counts.submitted;

    // Service breakdown across everyone who declared one
    const byService = {};
    for (const row of [...segments.halfway, ...segments.submitted]) {
      if (!row.service) continue;
      byService[row.service] = (byService[row.service] || 0) + 1;
    }

    const [listings, agentCount] = await Promise.all([
      Listing.countDocuments(),
      Session.countDocuments({ botPaused: true }),
    ]);

    res.json({
      range,
      counts,
      totalPeople: reached,
      // Share of everyone who arrived that got all the way through.
      completionRate: reached ? Math.round((counts.submitted / reached) * 100) : 0,
      byService,
      listings,
      withAgent: agentCount,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Portal] overview failed:', err.message);
    res.status(500).json({ error: 'Could not load the overview' });
  }
});

// ── One segment, searchable ──────────────────────────────────

router.get('/api/data/segment/:name', async (req, res) => {
  try {
    const name = req.params.name;
    if (!['said_hi', 'halfway', 'submitted'].includes(name)) {
      return res.status(400).json({ error: 'Unknown segment' });
    }

    const segments = await loadSegments(req.query.range || 'all');
    let rows = segments[name];

    const q = String(req.query.q || '').trim().toLowerCase();
    if (q) {
      rows = rows.filter((r) =>
        [r.name, r.phone, r.mobile, r.city, r.service, r.subService, r.business, r.email]
          .some((f) => String(f || '').toLowerCase().includes(q))
      );
    }

    res.json({ segment: name, total: rows.length, rows: rows.slice(0, 500) });
  } catch (err) {
    console.error('[Portal] segment failed:', err.message);
    res.status(500).json({ error: 'Could not load that list' });
  }
});

// ── Full transcript for one number ───────────────────────────

router.get('/api/data/thread/:phone', async (req, res) => {
  try {
    const phone = req.params.phone;
    const [messages, session, leads] = await Promise.all([
      Conversation.find({ phone }).sort({ createdAt: 1 }).limit(400).lean(),
      Session.findOne({ phone }).lean(),
      Lead.find({ phone }).sort({ createdAt: -1 }).lean(),
    ]);
    res.json({
      phone,
      messages: messages.map((m) => ({
        direction: m.direction,
        message: m.message,
        at: m.createdAt,
        state: m.state,
      })),
      answers: session?.answers || {},
      state: session?.state || null,
      botPaused: Boolean(session?.botPaused),
      leads: leads.map((l) => ({
        service: l.categoryLabel, at: l.createdAt,
        isPartial: l.isPartial, status: l.status,
      })),
    });
  } catch (err) {
    console.error('[Portal] thread failed:', err.message);
    res.status(500).json({ error: 'Could not load that conversation' });
  }
});

// ── Pause / resume the bot for a number ──────────────────────

router.post('/api/data/bot/:phone/:action', async (req, res) => {
  try {
    const { phone, action } = req.params;
    if (!['pause', 'resume'].includes(action)) {
      return res.status(400).json({ error: 'action must be pause or resume' });
    }
    const session = await Session.findOne({ phone });
    if (!session) return res.status(404).json({ error: 'No conversation for that number' });

    session.botPaused = action === 'pause';
    session.state = action === 'pause' ? 'HUMAN' : 'MENU';
    if (action === 'resume' && typeof session.resetFlow === 'function') session.resetFlow();
    await session.save();
    res.json({ ok: true, botPaused: session.botPaused });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CSV export ───────────────────────────────────────────────

// Excel on Windows assumes the system codepage unless a UTF-8 BOM is
// present, which turns ₹ into mojibake. The client's budget fields are
// full of ₹, so the BOM is not optional here.
const BOM = '\uFEFF';

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = Array.isArray(value) ? value.join('; ') : String(value);
  // A leading =, +, - or @ makes Excel treat the cell as a formula.
  // Phone numbers beginning with + are the common case.
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  if (/["\n\r,;]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return BOM + lines.join('\r\n') + '\r\n';
}

const CSV_SHAPES = {
  said_hi: {
    headers: ['WhatsApp Number', 'First Seen', 'Last Message At', 'Messages', 'Last Thing They Said', 'Status'],
    row: (r) => [r.phone, fmt(r.firstSeen), fmt(r.at), r.messages, r.lastSaid, r.status],
  },
  halfway: {
    headers: ['Name', 'Mobile', 'WhatsApp Number', 'Service', 'Sub-Service', 'City',
              'Business', 'Email', 'Got As Far As', 'Last Active'],
    row: (r) => [r.name, r.mobile, r.phone, r.service, r.subService, r.city,
                 r.business, r.email, r.status, fmt(r.at)],
  },
  submitted: {
    headers: ['Name', 'Mobile', 'WhatsApp Number', 'Service', 'Sub-Service', 'City',
              'Business', 'Email', 'Status', 'Submitted At', 'All Answers'],
    row: (r) => [r.name, r.mobile, r.phone, r.service, r.subService, r.city,
                 r.business, r.email, r.status, fmt(r.at), flatten(r.answers)],
  },
};

function fmt(d) {
  if (!d) return '';
  return new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}

function flatten(answers = {}) {
  return Object.entries(answers)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join('/') : v}`)
    .join(' | ');
}

router.get('/api/data/export/:name.csv', async (req, res) => {
  try {
    const name = req.params.name;
    const shape = CSV_SHAPES[name];
    if (!shape) return res.status(400).json({ error: 'Unknown segment' });

    const range = req.query.range || 'all';
    const segments = await loadSegments(range);
    let rows = segments[name];

    const q = String(req.query.q || '').trim().toLowerCase();
    if (q) {
      rows = rows.filter((r) =>
        [r.name, r.phone, r.mobile, r.city, r.service, r.subService, r.business, r.email]
          .some((f) => String(f || '').toLowerCase().includes(q))
      );
    }

    const csv = toCsv(shape.headers, rows.map(shape.row));
    const stamp = new Date().toISOString().slice(0, 10);
    const label = { said_hi: 'said-hi', halfway: 'halfway', submitted: 'submitted' }[name];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="launcherdesk-${label}-${range}-${stamp}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('[Portal] export failed:', err.message);
    res.status(500).json({ error: 'Could not build the file' });
  }
});

// The built React app is served by src/index.js via express.static,
// mounted AFTER this router so /portal/api/* always wins. Serving the
// SPA from here would swallow requests for /portal/assets/*.

module.exports = { router, toCsv, csvCell, loadSegments, requireTrustedOrigin };