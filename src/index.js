const path = require('path');

require('dotenv').config({
  path: path.resolve(__dirname, '../.env'),
});

console.log('ENV FILE:', path.resolve(__dirname, '../.env'));
console.log('MONGO_URI:', process.env.MONGO_URI ? 'Loaded ✅' : 'Missing ❌');

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const { parseInbound }  = require('./handlers/parser');
const { handleInbound } = require('./handlers/stateMachine');
const { pauseBot, resumeBot } = require('./services/botControl');
const { setIO } = require('./socket');
const reminders = require('./services/reminders');
const sheetQueue = require('./services/sheetQueue');

const dashboardRoutes     = require('./routes/dashboard');
const customerRoutes      = require('./routes/customers');
const conversationRoutes  = require('./routes/conversations');
// Admin console + the shared secret middleware used to gate the
// /api routes below, which were previously unauthenticated.
const { router: adminRouter, requireSecret } = require('./routes/admin');
// Portal: the email-login frontend for the client's team.
const { router: portalRouter } = require('./routes/portal');

// ─────────────────────────────────────────────────────────────
//  LauncherDesk WhatsApp Bot — Express Server
// ─────────────────────────────────────────────────────────────

const app  = express();
const PORT = process.env.PORT || 3000;

const httpServer = http.createServer(app);

// ── Socket.IO Server (real-time events for admin/agent UI) ────
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});
setIO(io);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Health check (Render/Railway ping to prevent cold start) ──
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'LauncherDesk WhatsApp Bot', time: new Date().toISOString() });
});

// ── Ignore messages sent to other numbers on the same MSG91 account ──
function normalizeNumber(num) {
  let digits = String(num || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

// ── MSG91 Inbound Webhook ─────────────────────────────────────
// Configure this URL in MSG91: WhatsApp → Settings → Inbound webhook
// URL: https://your-render-url.onrender.com/webhook/whatsapp
app.post('/webhook/whatsapp', async (req, res) => {
  // Always respond 200 immediately — MSG91 retries if it gets no quick response
  res.sendStatus(200);
  const toNumber = req.body?.integratedNumber;
  const ownNumber = process.env.MSG91_WHATSAPP_NUMBER;
  if (toNumber && ownNumber && normalizeNumber(toNumber) !== normalizeNumber(ownNumber)) {
    console.log(`[Webhook] Ignoring message for other number ${toNumber}`);
    return;
  }

  try {
    // Log raw payload during development (remove in production)
    if (process.env.NODE_ENV !== 'production') {
      console.log('[Webhook] Raw payload:', JSON.stringify(req.body, null, 2).slice(0, 500));
    }

    const parsed = parseInbound(req.body);

    if (!parsed) {
      console.warn('[Webhook] Could not parse payload — skipping');
      return;
    }

    if (!parsed.phone) {
      console.warn('[Webhook] No phone in parsed payload — skipping');
      return;
    }

    await handleInbound(parsed);

  } catch (err) {
    // Never let an error propagate to MSG91 — we already sent 200
    console.error('[Webhook] Unhandled error:', err.message, err.stack);
  }
});

// ── Admin: Pause bot for a number (human takeover) ────────────
// POST /admin/pause  { "phone": "919XXXXXXXXX", "secret": "xxx" }
app.post('/admin/pause', async (req, res) => {
  try {
    const { phone, secret } = req.body;
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await pauseBot(phone);
    res.json({ success: true });
  } catch (err) {
    console.error('[Admin] /admin/pause error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Admin: Resume bot for a number (call after human is done) ─
// POST /admin/resume  { "phone": "919XXXXXXXXX", "secret": "xxx" }
app.post('/admin/resume', async (req, res) => {
  try {
    const { phone, secret } = req.body;
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await resumeBot(phone);
    res.json({ success: true });
  } catch (err) {
    console.error('[Admin] /admin/resume error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Admin: View all leads (quick check) ──────────────────────
// GET /admin/leads?secret=xxx
app.get('/admin/leads', async (req, res) => {
  if (req.query.secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const Lead = require('./models/Lead');
  const leads = await Lead.find().sort({ createdAt: -1 }).limit(50);
  res.json(leads);
});

// ── Dashboard REST API (customers, conversations, stats) ──────
// ── Portal: API first, then the built React app ──────────────
//
// Order matters. The API router is mounted first so /portal/api/*
// always resolves here; express.static then serves the Vite build's
// hashed assets; finally any other /portal path falls through to
// index.html so client-side navigation works on refresh.
app.use('/portal', portalRouter);

const portalDist = path.join(__dirname, '..', 'public', 'portal');
app.use('/portal', express.static(portalDist, {
  // Hashed filenames are safe to cache hard; index.html must not be,
  // or a deploy leaves people on the previous bundle.
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    else if (/\.[0-9a-f]{8,}\./.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  },
}));

app.get(/^\/portal(\/.*)?$/, (req, res) => {
  const index = path.join(portalDist, 'index.html');
  res.sendFile(index, (err) => {
    if (err) {
      res
        .status(503)
        .type('html')
        .send(
          '<h1>Portal not built</h1>' +
          '<p>Run <code>npm run build:portal</code> and redeploy. ' +
          'The compiled files belong in <code>public/portal/</code>.</p>'
        );
    }
  });
});
app.use('/admin', adminRouter);

// SECURITY: these three were previously unauthenticated — anyone with
// the URL could read the full customer list, names and phone numbers
// included. They now require the same ADMIN_SECRET as everything else.
app.use('/api/dashboard', requireSecret, dashboardRoutes);
app.use('/api/customers', requireSecret, customerRoutes);
app.use('/api/conversations', requireSecret, conversationRoutes);

// ── Connect to MongoDB then start server ──────────────────────
mongoose
  .connect(process.env.MONGO_URI, { minPoolSize: 5, maxPoolSize: 20, serverSelectionTimeoutMS: 5000, socketTimeoutMS: 45000, compressors: ['zlib'] })
  .then(() => {
    console.log('[MongoDB] Connected ✅');
    httpServer.listen(PORT, () => {
      console.log(`[Server] LauncherDesk bot running on port ${PORT} ✅`);
      console.log(`[Server] Webhook URL: POST /webhook/whatsapp`);
      console.log(`[Server] Socket.IO ready`);

      // Doc §10: 10-minute nudge + 24-hour abandoned-session archive
      reminders.start();
      sheetQueue.start();   // batched Sheets mirror, off the reply path

      // Report portal readiness at boot. Without this, a missing
      // PORTAL_EMAIL only surfaces as a 503 from the login form, which
      // sends people looking at the frontend for a backend config gap.
      try {
        const portalAuth = require('./services/auth');
        if (portalAuth.isConfigured()) {
          console.log(`[Portal] Sign-in ready for ${portalAuth.allowedEmail()} — /portal`);
        } else {
          console.log(
            `[Portal] NOT configured. Missing: ${portalAuth.configProblems().join(', ')}`
          );
          console.log('[Portal] Run "npm run admin" to set up the one allowed account.');
        }
      } catch (err) {
        console.error('[Portal] Could not read auth config:', err.message);
      }
    });
  })
  .catch((err) => {
    console.error('[MongoDB] Connection failed:', err.message);
    process.exit(1);
  });