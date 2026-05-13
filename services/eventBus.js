/**
 * In-process pub/sub keyed by topic. Used to fan out live progress
 * events (research stages, chat tool-calls) from background work to
 * SSE-subscribed frontend clients.
 *
 * Single-instance Render web service: in-memory is fine. If we ever
 * scale to >1 instance, swap to Postgres LISTEN/NOTIFY without
 * touching emit/subscribe callers.
 *
 * Topic conventions:
 *   research:<jobId>            // research pipeline events
 *   chat:<caseId>:<turnId>      // streaming text-agent response
 */

const { EventEmitter } = require('events');

const bus = new EventEmitter();
// Generous: dozens of frontend tabs can subscribe to the same topic
bus.setMaxListeners(200);

// Per-topic replay buffer. SSE subscribers that arrive AFTER the
// first event still get the full backlog so the timeline isn't lossy.
// Keyed by topic, bounded so a runaway producer can't OOM us.
const REPLAY_MAX = 500;
const replay = new Map();   // topic -> [{ event, data, ts }]

function emit(topic, event, data) {
  const entry = { event, data, ts: Date.now() };
  if (!replay.has(topic)) replay.set(topic, []);
  const buf = replay.get(topic);
  buf.push(entry);
  if (buf.length > REPLAY_MAX) buf.shift();
  bus.emit(topic, entry);
}

function subscribe(topic, cb) {
  // Flush replay first, then live.
  const buf = replay.get(topic) || [];
  for (const e of buf) cb(e);
  bus.on(topic, cb);
  return () => bus.off(topic, cb);
}

function getBacklog(topic) {
  return (replay.get(topic) || []).slice();
}

function isTerminal(topic) {
  const buf = replay.get(topic) || [];
  return buf.some(e => e.event === 'done' || e.event === 'failed');
}

// Drop the replay buffer for a topic once nothing will ever subscribe
// again. Caller's responsibility — typically after status=done has been
// persisted AND a grace period for late subscribers has passed.
function forget(topic) {
  replay.delete(topic);
}

module.exports = { emit, subscribe, getBacklog, isTerminal, forget };
