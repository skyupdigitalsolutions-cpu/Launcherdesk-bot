const { google } = require('googleapis');

// ─────────────────────────────────────────────────────────────
//  Google Sheets Service
//  Appends a lead row to the configured spreadsheet.
//
//  Sheet setup:
//  Row 1 headers (create these manually once):
//  Name | Phone | Email | Business | City | Service | Source | Status | Date |
//  Last Message | Last Activity | Conversation Count
// ─────────────────────────────────────────────────────────────

const SHEET_ID    = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB   = 'Leads';   // Tab name inside the spreadsheet
const SHEET_RANGE = `${SHEET_TAB}!A:I`;
const PHONE_COLUMN_RANGE = `${SHEET_TAB}!B:B`;

const CONVERSATION_TAB   = 'Conversations';   // Tab name inside the spreadsheet
const CONVERSATION_RANGE = `${CONVERSATION_TAB}!A:F`;

// Build auth client from service account env vars
function getAuth() {
  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key:   process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

// Append one lead row to the sheet
async function appendLead(lead) {
  try {
    const auth   = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    const row = [
      lead.name,
      `'${lead.phone}`,           // prefix ' so Sheets treats as text, not number
      lead.email        || '',
      lead.businessName || '',
      lead.city         || '',
      lead.categoryLabel,
      lead.source       || 'whatsapp_bot',
      'New',
      new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    ];

    const result = await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range:         SHEET_RANGE,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });

    const updatedRange = result.data.updates?.updatedRange || '';
    console.log(`[Sheets] Lead appended — range: ${updatedRange}`);
    return updatedRange;
  } catch (err) {
    // Non-fatal — lead is already in MongoDB; log and continue
    console.error('[Sheets] Failed to append lead:', err.message);
    return null;
  }
}

// Append one WhatsApp conversation row to the sheet
async function appendConversation(data) {
  try {
    const auth   = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    const row = [
      new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      `'${data.phone}`,           // prefix ' so Sheets treats as text, not number
      data.direction,
      data.message,
      data.messageType,
      data.botState,
    ];

    const result = await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range:         CONVERSATION_RANGE,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });

    const updatedRange = result.data.updates?.updatedRange || '';
    console.log(`[Sheets] Conversation appended — range: ${updatedRange}`);
    return updatedRange;
  } catch (err) {
    // Non-fatal — conversation logging should never block the bot flow
    console.error('[Sheets] Failed to append conversation:', err.message);
    return null;
  }
}

// Update an existing lead's activity columns (Last Message, Last Activity,
// Conversation Count, Status) instead of appending a duplicate row.
// Returns false without writing anything if the phone number isn't found.
async function updateLeadActivity(phone, updates = {}) {
  try {
    const auth   = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    const phoneColumn = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range:         PHONE_COLUMN_RANGE,
    });

    const phoneValues = phoneColumn.data.values || [];
    const rowIndex = phoneValues.findIndex((row) => row[0] === phone);

    if (rowIndex === -1) {
      console.log(`[Sheets] updateLeadActivity — phone not found: ${phone}`);
      return false;
    }

    const rowNumber = rowIndex + 1;   // 1-indexed row in the sheet

    const currentCountCell = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range:         `${SHEET_TAB}!L${rowNumber}`,
    });
    const currentCount = parseInt(currentCountCell.data.values?.[0]?.[0], 10) || 0;

    const data = [
      { range: `${SHEET_TAB}!J${rowNumber}`, values: [[updates.lastMessage || '']] },
      { range: `${SHEET_TAB}!K${rowNumber}`, values: [[new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })]] },
      { range: `${SHEET_TAB}!L${rowNumber}`, values: [[currentCount + 1]] },
    ];

    if (updates.status) {
      data.push({ range: `${SHEET_TAB}!H${rowNumber}`, values: [[updates.status]] });
    }

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data },
    });

    console.log(`[Sheets] Lead activity updated — row: ${rowNumber}`);
    return true;
  } catch (err) {
    console.error('[Sheets] Failed to update lead activity:', err.message);
    return false;
  }
}

module.exports = {
  appendLead,
  appendConversation,
  updateLeadActivity,
};
