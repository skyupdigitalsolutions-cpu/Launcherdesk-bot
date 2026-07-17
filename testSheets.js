require('dotenv').config();

const { appendLead, appendConversation } = require('./src/services/sheets');

const dummyLead = {
  name: 'Test Lead',
  phone: '9999999999',
  email: 'test@example.com',
  businessName: 'Test Business',
  city: 'Test City',
  categoryLabel: 'Test Service',
  source: 'test_script',
};

const dummyConversation = {
  phone: '9999999999',
  direction: 'inbound',
  message: 'This is a test message',
  messageType: 'text',
  botState: 'test_state',
};

async function main() {
  try {
    const leadResult = await appendLead(dummyLead);
    if (!leadResult) {
      throw new Error('appendLead() did not return an updated range — check the [Sheets] error log above for details.');
    }

    const conversationResult = await appendConversation(dummyConversation);
    if (!conversationResult) {
      throw new Error('appendConversation() did not return an updated range — check the [Sheets] error log above for details.');
    }

    console.log('Google Sheets Test Successful');
  } catch (err) {
    console.error('Google Sheets Test Failed. Full error:');
    console.error(err);
    process.exitCode = 1;
  }
}

main();
