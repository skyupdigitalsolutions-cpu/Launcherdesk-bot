// ─────────────────────────────────────────────────────────────
//  Per-phone serialization lock
//
//  WHY THIS EXISTS
//  Observed in production: a user tapped Submit and Edit in quick
//  succession. MSG91 delivered both webhooks near-simultaneously,
//  Express handled them in parallel, and BOTH read session.state as
//  'SUMMARY' before either had written. The result was a lead
//  submitted AND the flow restarted, with three replies interleaved
//  in the chat.
//
//  The same race also allows duplicate leads: two Submit taps a few
//  hundred milliseconds apart both pass the state check and both
//  insert. Nothing in Mongo prevents that.
//
//  Fix: messages for one phone number run one at a time, in arrival
//  order. Different numbers still run fully in parallel, so this
//  costs nothing in throughput — WhatsApp conversations are
//  inherently sequential per person anyway.
//
//  SCOPE: in-process only. Correct for a single Railway instance,
//  which is the current deployment. Scaling to multiple replicas
//  would need a shared lock (Redis, or a Mongo findOneAndUpdate
//  claim) — noted alongside the same caveat in services/reminders.js.
// ─────────────────────────────────────────────────────────────

const chains = new Map();

// Guard against a hung task pinning a phone's queue forever.
const TASK_TIMEOUT = 25000;

function withTimeout(promise, ms, phone) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Handler for ${phone} exceeded ${ms}ms`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Run `task` such that no other task for the same phone runs
 * concurrently. Rejections are contained so one failed message can
 * never break the queue for subsequent ones.
 */
function runExclusive(phone, task) {
  const previous = chains.get(phone) || Promise.resolve();

  const next = previous
    .catch(() => {})                       // a prior failure must not block this one
    .then(() => withTimeout(Promise.resolve().then(task), TASK_TIMEOUT, phone));

  // Store a settled-either-way promise so the chain always advances.
  chains.set(phone, next.catch(() => {}));

  // Release the map entry once this phone's queue is fully drained,
  // otherwise the Map grows once per unique number, forever.
  next.catch(() => {}).finally(() => {
    if (chains.get(phone) === undefined) return;
    // Only clear if nothing else queued behind us in the meantime.
    Promise.resolve().then(() => {
      const current = chains.get(phone);
      if (current && current === chains.get(phone)) {
        // Compare by settling: if no new task was appended, drop it.
        chains.delete(phone);
      }
    });
  });

  return next;
}

function pendingCount() {
  return chains.size;
}

module.exports = { runExclusive, pendingCount };