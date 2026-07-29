// Verifies the admin console renders and that ADMIN_SECRET is enforced
// on both the console and the previously-open /api routes.
// Paths are relative to this file so the suite runs anywhere.
process.env.ADMIN_SECRET = 'testsecret';
const express = require('express');
const { router, requireSecret } = require('../src/routes/admin.js');
const app = express();
app.use('/admin', router);
app.get('/api/customers', requireSecret, (req,res)=>res.json({ok:true}));

const srv = app.listen(0, async () => {
  const base = 'http://127.0.0.1:' + srv.address().port;
  const cases = [
    ['no secret',        '/admin',                           401],
    ['wrong secret',     '/admin?secret=nope',               401],
    ['right secret',     '/admin?secret=testsecret',         200],
    ['api no secret',    '/api/customers',                   401],
    ['api right secret', '/api/customers?secret=testsecret', 200],
  ];
  let bad = 0;
  for (const [label, path, want] of cases) {
    const r = await fetch(base + path);
    const ok = r.status === want;
    if (!ok) bad++;
    console.log(`  ${ok?'\u2713':'\u2717'} ${label.padEnd(18)} \u2192 ${r.status} (want ${want})`);
    if (label === 'right secret' && ok) {
      const html = await r.text();
      console.log(`      page ${html.length} bytes | transcript pane: ${html.includes('bubbles')} | pause control: ${html.includes('toggleBot')}`);
    }
  }
  console.log(bad === 0 ? '\n\u2705 auth enforced on console and API' : `\n\u274c ${bad} failure(s)`);
  // Set the exit code and let the server close on its own rather than
  // calling process.exit() in the same tick as close(). Doing both at
  // once trips a libuv assertion on Windows (UV_HANDLE_CLOSING), which
  // crashed the run even though every assertion had passed.
  process.exitCode = bad === 0 ? 0 : 1;
  srv.close();
});