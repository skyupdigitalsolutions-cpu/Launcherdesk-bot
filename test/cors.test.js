// Verifies the two deployment modes:
//   no PORTAL_ORIGINS  → same-origin, cookie SameSite=Lax, no CORS headers
//   PORTAL_ORIGINS set → CORS for listed origins only, cookie SameSite=None,
//                        and an Origin check on state-changing requests
process.env.PORTAL_EMAIL   = 'owner@launcherdesk.com';
process.env.ADMIN_PASSWORD = 'a-long-test-password';
process.env.SESSION_SECRET = 'test-key';

const express = require('express');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  \u2717 ' + m); } };

function freshApp() {
  // Re-require so the module re-reads PORTAL_ORIGINS
  for (const k of Object.keys(require.cache)) {
    if (k.includes('routes/portal') || k.includes('services/auth')) delete require.cache[k];
  }
  const { router } = require('../src/routes/portal');
  const app = express();
  app.use('/portal', router);
  return app;
}

async function listen(app) {
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  return { srv, base: 'http://127.0.0.1:' + srv.address().port };
}

const login = (base, headers = {}) => fetch(base + '/portal/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ email: 'owner@launcherdesk.com', password: 'a-long-test-password' }),
});

(async () => {
  // ── Same-origin mode ────────────────────────────────────────
  console.log('\n\u2500\u2500 Same-origin mode (PORTAL_ORIGINS unset) \u2500\u2500');
  delete process.env.PORTAL_ORIGINS;
  let { srv, base } = await listen(freshApp());

  let r = await login(base);
  ok(r.status === 200, 'sign in works');
  let cookie = r.headers.get('set-cookie') || '';
  ok(/SameSite=Lax/i.test(cookie), 'cookie should be SameSite=Lax when same-origin');
  ok(!/SameSite=None/i.test(cookie), 'must NOT be SameSite=None when same-origin');
  ok(!r.headers.get('access-control-allow-origin'), 'no CORS header should be emitted');

  // A POST from a foreign site must be refused even though the cookie
  // would be attached by an older browser.
  r = await login(base, { Origin: 'https://evil.example.com' });
  ok(r.status === 403, `foreign Origin on a POST should be 403, got ${r.status}`);

  // No Origin header (curl, server-side) is allowed — no ambient cookie.
  r = await fetch(base + '/portal/api/data/overview');
  ok(r.status === 401, 'GET without a session is still 401');
  srv.close();
  console.log('   \u2713 Lax cookie, no CORS, foreign POST blocked');

  // ── Cross-origin mode ───────────────────────────────────────
  console.log('\u2500\u2500 Cross-origin mode (PORTAL_ORIGINS set) \u2500\u2500');
  process.env.PORTAL_ORIGINS = 'https://leads.launcherdesk.com,http://localhost:5173';
  ({ srv, base } = await listen(freshApp()));

  const GOOD = 'http://localhost:5173';
  const BAD  = 'https://evil.example.com';

  // Preflight from an allowed origin
  r = await fetch(base + '/portal/api/auth/login', {
    method: 'OPTIONS',
    headers: { Origin: GOOD, 'Access-Control-Request-Method': 'POST' },
  });
  ok(r.status === 204, `preflight should be 204, got ${r.status}`);
  ok(r.headers.get('access-control-allow-origin') === GOOD, 'preflight echoes the exact origin');
  ok(r.headers.get('access-control-allow-credentials') === 'true', 'credentials allowed');
  ok(r.headers.get('access-control-allow-origin') !== '*',
    'must never use a wildcard origin — incompatible with credentials and this API returns customer data');
  ok((r.headers.get('vary') || '').includes('Origin'), 'Vary: Origin set so caches do not mix responses');

  // Preflight from a disallowed origin gets no CORS grant
  r = await fetch(base + '/portal/api/auth/login', {
    method: 'OPTIONS',
    headers: { Origin: BAD, 'Access-Control-Request-Method': 'POST' },
  });
  ok(!r.headers.get('access-control-allow-origin'), 'disallowed origin gets no allow header');

  // Login from the allowed origin
  r = await login(base, { Origin: GOOD });
  ok(r.status === 200, 'sign in from an allowed origin works');
  cookie = r.headers.get('set-cookie') || '';
  ok(/SameSite=None/i.test(cookie), 'cookie should be SameSite=None in cross-origin mode');
  ok(/Secure/i.test(cookie), 'SameSite=None requires Secure or browsers discard it');
  ok(/HttpOnly/i.test(cookie), 'cookie stays HttpOnly');

  // Login from a foreign origin is refused by the CSRF guard — this is
  // the check that makes SameSite=None safe to use at all.
  r = await login(base, { Origin: BAD });
  ok(r.status === 403, `login from a foreign origin should be 403, got ${r.status}`);

  // Logout is also state-changing and must be guarded
  r = await fetch(base + '/portal/api/auth/logout', { method: 'POST', headers: { Origin: BAD } });
  ok(r.status === 403, `logout from a foreign origin should be 403, got ${r.status}`);

  // Data still requires a session regardless of a valid origin
  r = await fetch(base + '/portal/api/data/overview', { headers: { Origin: GOOD } });
  ok(r.status === 401, 'allowed origin without a session is still 401');

  srv.close();
  delete process.env.PORTAL_ORIGINS;
  console.log('   \u2713 CORS scoped to listed origins, SameSite=None+Secure, CSRF guard holds');

  console.log(fail === 0
    ? `\n\u2705 all ${pass} deployment-mode assertions passed`
    : `\n\u274c ${fail} failed / ${pass} passed`);
  process.exitCode = fail === 0 ? 0 : 1;
})();