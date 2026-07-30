// Verifies the portal: only one email can sign in, every data route is
// protected, and the CSV is safe to open in Excel.
//
// Paths are relative so this runs on any machine.
process.env.PORTAL_EMAIL   = 'owner@launcherdesk.com';
process.env.ADMIN_PASSWORD = 'correct-horse-battery-staple';
process.env.SESSION_SECRET = 'test-signing-key-not-a-real-one';

const express = require('express');
const auth = require('../src/services/auth');
const { toCsv, csvCell } = require('../src/routes/portal');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  \u2717 ' + m); } };

(async () => {
  // ── Password hashing ────────────────────────────────────────
  console.log('\n\u2500\u2500 Password hashing \u2500\u2500');
  const hash = auth.hashPassword('hunter2hunter2');
  ok(hash.startsWith('scrypt$'), 'hash should be scrypt-tagged');
  ok(!hash.includes('hunter2'), 'plaintext must not appear in the hash');
  ok(auth.verifyPassword('hunter2hunter2', hash), 'correct password should verify');
  ok(!auth.verifyPassword('hunter2hunter3', hash), 'wrong password must not verify');
  ok(!auth.verifyPassword('', hash), 'empty password must not verify');
  ok(!auth.verifyPassword('hunter2hunter2', 'garbage'), 'malformed hash must not verify');
  ok(auth.hashPassword('same') !== auth.hashPassword('same'), 'salts must differ per hash');
  console.log('   \u2713 scrypt hashing, unique salts, no plaintext leak');

  // ── Only ONE email may sign in ───────────────────────────────
  console.log('\u2500\u2500 Single-account rule \u2500\u2500');
  ok(auth.checkCredentials('owner@launcherdesk.com', 'correct-horse-battery-staple').ok,
    'the configured email with the right password should be allowed');
  ok(auth.checkCredentials('OWNER@LAUNCHERDESK.COM', 'correct-horse-battery-staple').ok,
    'email match should be case-insensitive');
  ok(auth.checkCredentials('  owner@launcherdesk.com  ', 'correct-horse-battery-staple').ok,
    'surrounding whitespace should be tolerated');

  const rejects = [
    ['someone@else.com',            'correct-horse-battery-staple', 'a different email, right password'],
    ['owner@launcherdesk.com',      'wrong-password',               'right email, wrong password'],
    ['owner@launcherdesk.co',       'correct-horse-battery-staple', 'nearly-right email'],
    ['owner@launcherdesk.com.evil', 'correct-horse-battery-staple', 'suffixed email'],
    ['',                            'correct-horse-battery-staple', 'blank email'],
    ['owner@launcherdesk.com',      '',                             'blank password'],
    [null,                          null,                           'nulls'],
  ];
  for (const [e, p, why] of rejects) {
    ok(!auth.checkCredentials(e, p).ok, `must reject: ${why}`);
  }
  console.log(`   \u2713 1 email accepted, ${rejects.length} rejection cases hold`);

  // ── Session tokens ──────────────────────────────────────────
  console.log('\u2500\u2500 Session tokens \u2500\u2500');
  const token = auth.createToken('owner@launcherdesk.com');
  ok(auth.verifyToken(token)?.email === 'owner@launcherdesk.com', 'valid token should verify');
  ok(!auth.verifyToken(token + 'x'), 'tampered signature must be rejected');
  ok(!auth.verifyToken('nonsense'), 'junk must be rejected');
  ok(!auth.verifyToken(''), 'empty must be rejected');
  ok(!auth.verifyToken(null), 'null must be rejected');

  // Forged payload with a valid-looking shape but no real signature
  const forged = Buffer.from(JSON.stringify({
    e: 'attacker@evil.com', exp: Date.now() + 9e6,
  })).toString('base64url') + '.deadbeef';
  ok(!auth.verifyToken(forged), 'forged token must be rejected');

  // Expired
  const realNow = Date.now;
  Date.now = () => realNow() - (13 * 60 * 60 * 1000);
  const old = auth.createToken('owner@launcherdesk.com');
  Date.now = realNow;
  ok(!auth.verifyToken(old), 'a 13-hour-old token must be expired (TTL is 12h)');

  // Rotating the allowed email must revoke existing tokens, otherwise
  // changing PORTAL_EMAIL wouldn't lock the old owner out.
  process.env.PORTAL_EMAIL = 'newowner@launcherdesk.com';
  ok(!auth.verifyToken(token), 'changing PORTAL_EMAIL must invalidate old tokens');
  process.env.PORTAL_EMAIL = 'owner@launcherdesk.com';
  console.log('   \u2713 signing, tampering, expiry, and email rotation all handled');

  // ── Cookie parsing ──────────────────────────────────────────
  console.log('\u2500\u2500 Cookie parsing \u2500\u2500');
  const req = (cookie) => ({ headers: { cookie } });
  ok(auth.readCookie(req('ld_session=abc')) === 'abc', 'simple cookie');
  ok(auth.readCookie(req('other=1; ld_session=abc; more=2')) === 'abc', 'cookie among others');
  ok(auth.readCookie(req('ld_session=a%20b')) === 'a b', 'url-decoded');
  ok(auth.readCookie(req('')) === null, 'no cookie header');
  ok(auth.readCookie(req('nothinguseful=1')) === null, 'missing cookie');
  // A cookie whose name merely ends with ours must not match
  ok(auth.readCookie(req('xld_session=nope')) === null, 'prefixed name must not match');
  console.log('   \u2713 parsed without a cookie-parser dependency');

  // ── CSV safety ──────────────────────────────────────────────
  console.log('\u2500\u2500 CSV escaping \u2500\u2500');
  ok(csvCell('plain') === 'plain', 'plain text unchanged');
  ok(csvCell('a,b') === '"a,b"', 'commas quoted');
  ok(csvCell('say "hi"') === '"say ""hi"""', 'inner quotes doubled');
  ok(csvCell('line1\nline2') === '"line1\nline2"', 'newlines quoted');
  // Joined with '; ' — and then quoted, because Excel treats ';' as the
  // field delimiter in several European locales.
  ok(csvCell(['a', 'b']) === '"a; b"', 'arrays joined and quoted');
  ok(csvCell(null) === '', 'null becomes blank');
  ok(csvCell(undefined) === '', 'undefined becomes blank');

  // Formula injection: a cell starting with = + - or @ is executed by
  // Excel. Phone numbers beginning with + are the everyday case here.
  ok(csvCell('=SUM(A1:A9)').startsWith("'"), 'formula must be neutralised');
  ok(csvCell('+919876543210').startsWith("'"), 'leading + must be neutralised');
  ok(csvCell('-1').startsWith("'"), 'leading - must be neutralised');
  ok(csvCell('@x').startsWith("'"), 'leading @ must be neutralised');

  const csv = toCsv(['A', 'B'], [['1', 'x,y'], ['2', '\u20b95,000']]);
  ok(csv.charCodeAt(0) === 0xFEFF, 'must start with a UTF-8 BOM so Excel renders \u20b9 correctly');
  ok(csv.includes('\r\n'), 'CRLF line endings for Excel');
  ok(csv.includes('"x,y"'), 'row values escaped');
  ok(csv.includes('\u20b95,000'), 'rupee symbol preserved');
  console.log('   \u2713 quoting, BOM, CRLF, and formula-injection guard');

  // ── Every data route must require a session ─────────────────
  console.log('\u2500\u2500 Route protection \u2500\u2500');
  const { router } = require('../src/routes/portal');
  const app = express();
  app.use('/portal', router);
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = 'http://127.0.0.1:' + srv.address().port;

  const guarded = [
    '/portal/api/data/overview',
    '/portal/api/data/segment/said_hi',
    '/portal/api/data/segment/halfway',
    '/portal/api/data/segment/submitted',
    '/portal/api/data/thread/919876543210',
    '/portal/api/data/export/submitted.csv',
    '/portal/api/data/export/halfway.csv',
    '/portal/api/data/export/said_hi.csv',
  ];
  for (const url of guarded) {
    const r = await fetch(base + url);
    ok(r.status === 401, `${url} should be 401 without a session, got ${r.status}`);
  }

  // A forged cookie must not open any of them
  const r2 = await fetch(base + '/portal/api/data/overview', { headers: { cookie: 'ld_session=' + forged } });
  ok(r2.status === 401, `forged cookie should be 401, got ${r2.status}`);

  // Login rejects a wrong email over HTTP too
  const bad = await fetch(base + '/portal/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'hacker@evil.com', password: 'correct-horse-battery-staple' }),
  });
  ok(bad.status === 401, `wrong email should be 401, got ${bad.status}`);

  // ...and accepts the configured one, setting an httpOnly cookie
  const good = await fetch(base + '/portal/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@launcherdesk.com', password: 'correct-horse-battery-staple' }),
  });
  ok(good.status === 200, `correct credentials should be 200, got ${good.status}`);
  const setCookie = good.headers.get('set-cookie') || '';
  ok(setCookie.includes('ld_session='), 'a session cookie should be set');
  ok(/HttpOnly/i.test(setCookie), 'cookie must be HttpOnly so scripts cannot read it');
  ok(/SameSite=Lax/i.test(setCookie), 'cookie must set SameSite');
  ok(!setCookie.includes('correct-horse'), 'the password must never appear in the cookie');

  console.log(`   \u2713 ${guarded.length} data routes gated, cookie is HttpOnly + SameSite`);
  srv.close();

  console.log(fail === 0
    ? `\n\u2705 all ${pass} portal assertions passed`
    : `\n\u274c ${fail} failed / ${pass} passed`);
  process.exitCode = fail === 0 ? 0 : 1;
})();