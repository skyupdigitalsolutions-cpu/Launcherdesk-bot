const sheets = require('./sheets');

// ─────────────────────────────────────────────────────────────
//  Sheets Write Queue
//
//  WHY THIS EXISTS
//  Every inbound message used to make FOUR blocking Google Sheets
//  calls — appendConversation and updateLeadActivity, once for the
//  incoming message and once for the outgoing reply. Each round trip
//  to the Sheets API costs roughly a second, so the user waited
//  8-9 seconds for a reply that the bot had already computed in
//  milliseconds. Worse, those calls were failing (a malformed
//  private key), so the bot was paying full latency for writes that
//  never landed.
//
//  Rows are now buffered in memory and flushed in ONE batched append
//  on a timer. The reply goes out immediately; the spreadsheet
//  catches up a few seconds later, which is the right trade for a
//  log nobody reads in real time.
//
//  DURABILITY: MongoDB remains the source of truth and is written
//  synchronously. This queue is a mirror for the client's
//  spreadsheet. If the process restarts with rows still buffered,
//  those rows are lost from Sheets but never from MongoDB — and the
//  admin console reads MongoDB, so nothing is actually missing.
// ─────────────────────────────────────────────────────────────

const FLUSH_INTERVAL = 8000;   // ms between batched appends
const MAX_BUFFER     = 200;    // flush early if the buffer gets big
const MAX_RETRIES    = 2;

let buffer = [];
let timer = null;
let flushing = false;
let stats = { queued: 0, written: 0, failed: 0, lastError: null, lastFlushAt: null };

function enqueue(row) {
  // No Sheets configured? Drop silently rather than buffering forever.
  if (!process.env.GOOGLE_SHEET_ID || !process.env.GOOGLE_PRIVATE_KEY) return;

  buffer.push(row);
  stats.queued++;

  if (buffer.length >= MAX_BUFFER) {
    flush().catch(() => {});
  }
}

async function flush() {
  if (flushing || buffer.length === 0) return;
  flushing = true;

  // Take the whole buffer so new messages during the flush queue up
  // behind it instead of being written twice.
  const batch = buffer;
  buffer = [];

  let attempt = 0;
  while (attempt <= MAX_RETRIES) {
    try {
      await sheets.appendConversationBatch(batch);
      stats.written += batch.length;
      stats.lastFlushAt = new Date();
      stats.lastError = null;
      flushing = false;
      return;
    } catch (err) {
      attempt++;
      stats.lastError = err.message;
      if (attempt > MAX_RETRIES) {
        stats.failed += batch.length;
        // Deliberately NOT re-queued. A permanently broken credential
        // would otherwise grow the buffer without bound and retry
        // forever. MongoDB already has these rows.
        console.error(
          `[SheetQueue] Dropped ${batch.length} row(s) after ${MAX_RETRIES + 1} attempts: ${err.message}`
        );
        flushing = false;
        return;
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => flush().catch(() => {}), FLUSH_INTERVAL);
  if (timer.unref) timer.unref();   // don't hold the process open in tests
  console.log(`[SheetQueue] Batching Sheets writes every ${FLUSH_INTERVAL / 1000}s`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function getStats() {
  return { ...stats, buffered: buffer.length };
}

module.exports = { enqueue, flush, start, stop, getStats };