// Verify EVERY outbound message is interactive and within WhatsApp caps
const Module = require('module');
const orig = Module.prototype.require;
const calls = [];
Module.prototype.require = function(p){
  if (p.includes('services/msg91')) return {
    sendText: async (to,b) => { calls.push({type:'TEXT', body:b}); },
    sendButtonMessage: async (to,b,btns,h,f) => { calls.push({type:'interactive', body:b, btns:(btns||[]).map(x=>x.title)}); },
    sendListMessage: async (to,b,c,secs) => { calls.push({type:'interactive', body:b, rows:secs.flatMap(s=>s.rows.length)}); },
  };
  if (p.includes('services/logger')) return { logIncoming:async()=>{}, logOutgoing:async()=>{} };
  return orig.apply(this, arguments);
};
const m = require('/home/claude/build/src/handlers/messages.js');

(async () => {
  const cases = [
    ['sendWelcomeMenu',        () => m.sendWelcomeMenu('9', 'MENU')],
    ['sendValidationError',    () => m.sendValidationError('9', 'Bad number', 'FLOW')],
    ['sendStuckOffer',         () => m.sendStuckOffer('9', 'FLOW')],
    ['sendAskTypedMobile',     () => m.sendAskTypedMobile('9', 'FLOW')],
    ['sendSummary',            () => m.sendSummary('9', 'Service: X', 'SUMMARY')],
    ['sendEditIntro',          () => m.sendEditIntro('9', 'FLOW')],
    ['sendLeadSuccess',        () => m.sendLeadSuccess('9', 'Business Registration', 'DONE')],
    ['sendBuyerConfirmation',  () => m.sendBuyerConfirmation('9', 'DONE')],
    ['sendListingSuccess',     () => m.sendListingSuccess('9', 'DONE')],
    ['sendListingDuplicate',   () => m.sendListingDuplicate('9', 'AcmeCRM', 'DONE')],
    ['sendInactivityReminder', () => m.sendInactivityReminder('9', 'FLOW')],
    ['sendExpertHandoff',      () => m.sendExpertHandoff('9', 'HUMAN')],
    ['sendWebsite',            () => m.sendWebsite('9', 'https://www.launcherdesk.com/', 'DONE')],
    ['sendOptOutConfirm',      () => m.sendOptOutConfirm('9', 'MENU')],
    ['sendOptInConfirm',       () => m.sendOptInConfirm('9', 'MENU')],
    ['sendFallback',           () => m.sendFallback('9', 'MENU')],
    ['sendResumeOrRestart',    () => m.sendResumeOrRestart('9', "What's your name?", 'FLOW')],
    ['sendStaleTapWarning',    () => m.sendStaleTapWarning('9', 'Done', 'FLOW')],
    ['sendFlowIntro',          () => m.sendFlowIntro('9', 'I need 6 details', 'FLOW')],
  ];

  let bad = 0;
  for (const [name, fn] of cases) {
    calls.length = 0;
    await fn();
    const c = calls[0];
    if (!c) { console.log(`  ✗ ${name}: sent nothing`); bad++; continue; }
    if (c.type === 'TEXT') { console.log(`  ✗ ${name}: PLAIN TEXT — will not be delivered`); bad++; continue; }
    if (c.body.length > 1024) { console.log(`  ✗ ${name}: body ${c.body.length} chars (max 1024)`); bad++; continue; }
    if (c.btns) {
      if (c.btns.length > 3) { console.log(`  ✗ ${name}: ${c.btns.length} buttons (max 3)`); bad++; continue; }
      const longBtn = c.btns.find(b => b.length > 20);
      if (longBtn) { console.log(`  ✗ ${name}: button "${longBtn}" ${longBtn.length} chars (max 20)`); bad++; continue; }
    }
    console.log(`  ✓ ${name}${c.btns ? '  [' + c.btns.join('] [') + ']' : ''}`);
  }
  console.log(bad === 0 ? `\n✅ all ${cases.length} outbound messages are interactive and within limits`
                        : `\n❌ ${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
})();