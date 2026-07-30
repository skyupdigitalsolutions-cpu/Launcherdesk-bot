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

// Ceiling on how long one message may hold a phone's queue. Must stay
// comfortably above the slowest legitimate handler (a few Mongo ops
// plus one MSG91 send, ~1s) but low enough that a stuck task doesn't
// strand the next message. MSG91 itself is capped at 8s per call.
const TASK_TIMEOUT = 12000;

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
  const settled = next.catch(() => {});
  chains.set(phone, settled);

  // Release the Map entry once this phone's queue is drained, or it
  // grows by one per unique number and never shrinks.
  //
  // The identity check matters: if another message queued behind us
  // while we ran, chains.get(phone) now holds THAT task's promise, and
  // deleting it would drop the queue and lose serialization. The
  // previous version compared chains.get(phone) against itself, which
  // is always true, so it deleted unconditionally — meaning two rapid
  // messages could still run in parallel. Capturing `settled` first is
  // what makes the comparison meaningful.
  settled.then(() => {
    if (chains.get(phone) === settled) chains.delete(phone);
  });

  return next;
}

function pendingCount() {
  return chains.size;
}

module.exports = { runExclusive, pendingCount };