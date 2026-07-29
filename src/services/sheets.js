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

// ─────────────────────────────────────────────────────────────
//  Private key normalisation
//
//  This is the fix for:
//    [Sheets] Failed to append: error:1E08010C:DECODER routines::unsupported
//
//  That error is OpenSSL refusing to parse the PEM. It happens because
//  the key arrives in a different shape depending on where it was set:
//
//    .env file        one line, literal backslash-n sequences
//    Railway UI       real newlines, sometimes wrapped in quotes
//    copy/paste       real newlines, sometimes with \r, sometimes
//                     with the header/footer on the same line as body
//
//  Handling only one of those (the old code handled only the first)
//  breaks the others silently. This normalises all of them.
// ─────────────────────────────────────────────────────────────
function normalisePrivateKey(raw) {
  if (!raw) return null;
  let key = String(raw).trim();

  // Strip surrounding quotes that shells and dashboards add
  if ((key.startsWith('"') && key.endsWith('"')) ||
      (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1);
  }

  // Literal \n → real newline, and normalise Windows line endings
  key = key.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Some pastes lose the newlines around the PEM markers, which makes
  // the body unparseable even though every character is present.
  key = key
    .replace(/-----BEGIN ([A-Z ]+)-----\s*/, '-----BEGIN $1-----\n')
    .replace(/\s*-----END ([A-Z ]+)-----/, '\n-----END $1-----');

  if (!key.endsWith('\n')) key += '\n';
  return key;
}

// Build auth client from service account env vars
function getAuth() {
  const key = normalisePrivateKey(process.env.GOOGLE_PRIVATE_KEY);
  if (!key) throw new Error('GOOGLE_PRIVATE_KEY is not set');
  if (!key.includes('BEGIN')) {
    throw new Error('GOOGLE_PRIVATE_KEY does not look like a PEM key (no BEGIN marker)');
  }
  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

// Append one lead row to the sheet
async function appendLead(lead) {
  try {
    const auth   = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    // The flow engine stores answers in snake_case (business_name,
    // work_email); older callers used camelCase. Accepting both keeps
    // this working either way instead of silently writing blank cells.
    const businessName = lead.businessName || lead.business_name || lead.product_name || '';
    const email        = lead.email || lead.work_email || '';
    const mobile       = lead.mobile || lead.phone || '';

    // Sub-service: the most specific thing the user picked. Without
    // this the sales team sees "Business Registration" with no clue
    // whether it's an LLP or a Trust.
    const subService =
      lead.entity_type || lead.license_type || lead.finance_service ||
      lead.it_need || lead.legal_service || lead.intl_need ||
      lead.office_need || lead.tool_category || lead.product_category || '';

    const row = [
      lead.name || 'Unknown',
      `'${lead.phone}`,           // prefix ' so Sheets treats as text, not number
      email,
      businessName,
      lead.city         || '',
      lead.categoryLabel,
      lead.source       || 'whatsapp_bot',
      'New',
      new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      // Appended columns — existing sheet columns keep their positions
      subService,
      `'${mobile}`,
      Array.isArray(lead.addons) ? lead.addons.join(', ') : '',
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


// ─────────────────────────────────────────────────────────────
//  Batched conversation append
//
//  One API call for many rows instead of one call per message.
//  Called only by services/sheetQueue.js, off the reply path.
// ─────────────────────────────────────────────────────────────
async function appendConversationBatch(rows) {
  if (!rows || rows.length === 0) return null;

  const auth   = getAuth();
  const api    = google.sheets({ version: 'v4', auth });
  const values = rows.map((d) => [
    new Date(d.at || Date.now()).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    `'${d.phone}`,                 // leading quote keeps Sheets from mangling the number
    d.direction || '',
    d.messageType || 'text',
    d.botState || '',
    d.message || '',
  ]);

  const res = await api.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: CONVERSATION_RANGE,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
  console.log(`[Sheets] Wrote ${rows.length} conversation row(s)`);
  return res.data;
}

module.exports = {
  appendConversationBatch,
  normalisePrivateKey,
  appendLead,
  appendConversation,
  updateLeadActivity,
};