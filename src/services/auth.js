const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────
//  Portal authentication — one account, no dependencies
//
//  Requirement: exactly one email address may sign in. Everyone else
//  is refused, regardless of password.
//
//  WHY NO jsonwebtoken / bcrypt
//  This project's npm ci has broken twice already on lockfile drift,
//  and both libraries are replaceable with ~40 lines of node:crypto:
//    - scrypt for password hashing (memory-hard, stronger than bcrypt
//      at equivalent settings and built in since Node 10)
//    - HMAC-SHA256 for signing the session token
//  Fewer moving parts in the deploy is worth more here than the
//  convenience of a library.
//
//  WHY A COOKIE, NOT A URL SECRET
//  The previous /admin console put its secret in the query string, so
//  it leaked into browser history, screenshots and referrer headers —
//  it was in fact exposed in a screenshot during development. The
//  token here lives in an httpOnly cookie the page's JavaScript cannot
//  read, and never appears in a URL.
// ─────────────────────────────────────────────────────────────

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;   // 12 hours
const COOKIE_NAME  = 'ld_session';

// ── Password hashing ─────────────────────────────────────────

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = stored.split('$');
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

// ── Configuration ────────────────────────────────────────────
//
// Accepts either ADMIN_PASSWORD_HASH (preferred — the plaintext never
// sits in Railway's dashboard) or ADMIN_PASSWORD, which is hashed once
// at boot. Generate a hash with:  npm run admin
//
let cachedHash = null;

function configuredHash() {
  if (cachedHash) return cachedHash;
  if (process.env.ADMIN_PASSWORD_HASH) {
    cachedHash = process.env.ADMIN_PASSWORD_HASH;
  } else if (process.env.ADMIN_PASSWORD) {
    cachedHash = hashPassword(process.env.ADMIN_PASSWORD);
  }
  return cachedHash;
}

function allowedEmail() {
  return (process.env.PORTAL_EMAIL || '').trim().toLowerCase();
}

function signingKey() {
  // Falls back to ADMIN_SECRET so an existing deployment keeps working
  // without adding another variable.
  return process.env.SESSION_SECRET || process.env.ADMIN_SECRET || '';
}

function isConfigured() {
  return Boolean(allowedEmail() && configuredHash() && signingKey());
}

function configProblems() {
  const missing = [];
  if (!allowedEmail()) missing.push('PORTAL_EMAIL');
  if (!configuredHash()) missing.push('ADMIN_PASSWORD_HASH (or ADMIN_PASSWORD)');
  if (!signingKey()) missing.push('SESSION_SECRET (or ADMIN_SECRET)');
  return missing;
}

// ── Credential check ─────────────────────────────────────────

function checkCredentials(email, password) {
  if (!isConfigured()) {
    return { ok: false, reason: 'not_configured', missing: configProblems() };
  }

  const supplied = String(email || '').trim().toLowerCase();
  const expected = allowedEmail();

  // Compare the email in constant time too. It leaks less about which
  // half of the pair was wrong, and the response is identical either
  // way so the endpoint can't be used to discover the address.
  const a = Buffer.from(supplied.padEnd(128).slice(0, 128));
  const b = Buffer.from(expected.padEnd(128).slice(0, 128));
  const emailOk = crypto.timingSafeEqual(a, b);

  // Always run the password check even when the email is wrong, so the
  // two failure paths take the same time.
  const passwordOk = verifyPassword(String(password || ''), configuredHash());

  if (!emailOk || !passwordOk) return { ok: false, reason: 'invalid' };
  return { ok: true, email: expected };
}

// ── Session tokens ───────────────────────────────────────────

function createToken(email) {
  const payload = JSON.stringify({ e: email, exp: Date.now() + TOKEN_TTL_MS });
  const body = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', signingKey()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;

  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = crypto.createHmac('sha256', signingKey()).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload.exp || payload.exp < Date.now()) return null;

  // A token signed for a different address than the one now configured
  // must not work — otherwise rotating PORTAL_EMAIL wouldn't revoke it.
  if (String(payload.e || '').toLowerCase() !== allowedEmail()) return null;

  return { email: payload.e, exp: payload.exp };
}

// ── Cookies (parsed by hand to avoid a cookie-parser dep) ────

function readCookie(req, name = COOKIE_NAME) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

// Origins allowed to call the API from a browser. Set this ONLY if the
// frontend is deployed somewhere other than this server.
//   PORTAL_ORIGINS=https://leads.launcherdesk.com,http://localhost:5173
function allowedOrigins() {
  return (process.env.PORTAL_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function isCrossOriginMode() {
  return allowedOrigins().length > 0;
}

function setSessionCookie(res, token, req) {
  // Secure only over HTTPS so local http://localhost development still
  // works. Railway terminates TLS and forwards x-forwarded-proto.
  const isHttps = req?.secure || req?.headers['x-forwarded-proto'] === 'https';

  // SameSite depends on where the frontend lives.
  //
  //   Same-origin (frontend built into this server) → Lax.
  //     Strongest option: the browser simply won't send the cookie on
  //     cross-site requests, so CSRF is off the table.
  //
  //   Separate deployment → None, which REQUIRES Secure.
  //     A cross-site cookie is weaker by nature, so the API also
  //     validates the Origin header on every state-changing request
  //     (see requireTrustedOrigin in routes/portal.js). Without that
  //     check, SameSite=None would leave login and logout open to CSRF.
  const cross = isCrossOriginMode();
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${Math.floor(TOKEN_TTL_MS / 1000)}`,
  ];

  if (cross) {
    // Browsers reject SameSite=None without Secure, so a cross-origin
    // setup over plain HTTP cannot work — fail loudly rather than
    // silently issuing a cookie the browser will discard.
    if (!isHttps) {
      console.warn(
        '[Auth] PORTAL_ORIGINS is set but this request is not HTTPS. ' +
        'Browsers discard SameSite=None cookies without Secure, so sign-in will not persist.'
      );
    }
    attrs.push('SameSite=None', 'Secure');
  } else {
    attrs.push('SameSite=Lax');
    if (isHttps) attrs.push('Secure');
  }

  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
  // Attributes must match the cookie that was set, or the browser keeps
  // the original and sign-out appears to do nothing.
  const cross = isCrossOriginMode();
  const tail = cross ? 'SameSite=None; Secure' : 'SameSite=Lax';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; ${tail}; Max-Age=0`);
}

// ── Express middleware ───────────────────────────────────────

function requireLogin(req, res, next) {
  const session = verifyToken(readCookie(req));
  if (!session) {
    return res.status(401).json({ error: 'Not signed in' });
  }
  req.user = session;
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  checkCredentials,
  createToken,
  verifyToken,
  readCookie,
  setSessionCookie,
  clearSessionCookie,
  requireLogin,
  isConfigured,
  configProblems,
  allowedEmail,
  allowedOrigins,
  isCrossOriginMode,
  COOKIE_NAME,
  TOKEN_TTL_MS,
};