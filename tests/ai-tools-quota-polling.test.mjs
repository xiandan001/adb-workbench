import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuotaPoller, quotaMetricRatio } from '../src/components/ai-tools/aiQuotaPolling.js';
test('browser timer functions keep their native receiver when the default clock schedules and clears', t => {
  const timeout = globalThis.setTimeout; const clear = globalThis.clearTimeout;
  t.after(() => { globalThis.setTimeout = timeout; globalThis.clearTimeout = clear; });
  globalThis.setTimeout = function (callback, delay) { assert.ok(this === undefined || this === globalThis, 'Window timer called with a foreign receiver'); return timeout(callback, delay); };
  globalThis.clearTimeout = function (timer) { assert.ok(this === undefined || this === globalThis, 'Window timer cleared with a foreign receiver'); return clear(timer); };
  const poll = createQuotaPoller({ query: async () => ({ status: 'fresh' }) });
  assert.doesNotThrow(() => poll.update({ key: 'native', configured: true, canQuery: true, active: true, documentVisible: true, cardVisible: true, autoRefresh: true, busy: false }));
  assert.doesNotThrow(() => poll.dispose());
});
class FakeClock {
  time = 0; sequence = 0; timers = new Map();
  now = () => this.time;
  setTimeout = (callback, delay) => { const id = ++this.sequence; this.timers.set(id, { callback, at: this.time + delay }); return id; };
  clearTimeout = id => this.timers.delete(id);
  async advance(ms) {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.timers].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at; this.timers.delete(next[0]); next[1].callback();
      for (let i = 0; i < 6; i++) await Promise.resolve();
    }
    this.time = end; for (let i = 0; i < 6; i++) await Promise.resolve();
  }
}
const visible = { key: 'provider-one', configured: true, canQuery: true, active: true, documentVisible: true, cardVisible: true, autoRefresh: true, busy: false };

test('clearing the parent error before a retry does not let an unchanged fresh cache reset repeated-failure backoff', async () => {
  const clock = new FakeClock(); const cached = { status: 'fresh', observedAt: 0 }; let poller; let calls = 0;
  poller = createQuotaPoller({ clock, query: async () => {
    calls++; poller.update({ result: cached, busy: true });
    const result = { status: 'error', reason: 'network failed' }; poller.update({ result, busy: false }); return result;
  } });
  poller.update({ ...visible, result: cached });
  await clock.advance(60000); assert.equal(calls, 1); assert.equal(poller.snapshot().nextAt - clock.now(), 60000);
  await clock.advance(60000); assert.equal(calls, 2); assert.equal(poller.snapshot().nextAt - clock.now(), 120000);
  await clock.advance(120000); assert.equal(calls, 3); assert.equal(poller.snapshot().nextAt - clock.now(), 240000);
  poller.dispose();
});
test('quota queries first visible use and every 60 seconds, but never without an adapter or credential', async () => {
  const clock = new FakeClock(); let count = 0;
  const poller = createQuotaPoller({ clock, query: async () => { count++; return { status: 'fresh', observedAt: clock.now() }; } });
  poller.update({ ...visible, configured: false }); await clock.advance(180000); assert.equal(count, 0);
  poller.update({ configured: true }); await clock.advance(0); assert.equal(count, 1);
  await clock.advance(59999); assert.equal(count, 1); await clock.advance(1); assert.equal(count, 2);
  poller.dispose(); assert.equal(clock.timers.size, 0); await clock.advance(180000); assert.equal(count, 2);
});
test('fresh cached quota uses the remaining 60-second TTL instead of requesting again on mount', async () => {
  const clock = new FakeClock(); clock.time = 10000; let count = 0;
  const poller = createQuotaPoller({ clock, query: async () => { count++; return { status: 'fresh', observedAt: clock.now() }; } });
  poller.update({ ...visible, result: { status: 'fresh', observedAt: 0 } });
  await clock.advance(49999); assert.equal(count, 0); await clock.advance(1); assert.equal(count, 1); poller.dispose();
});
test('page, document and card visibility each pause all scheduled queries and resume when due', async () => {
  for (const flag of ['active', 'documentVisible', 'cardVisible']) {
    const clock = new FakeClock(); let count = 0;
    const poller = createQuotaPoller({ clock, query: async () => { count++; return { status: 'fresh', observedAt: clock.now() }; } });
    poller.update({ ...visible, [flag]: false }); await clock.advance(60000); assert.equal(count, 0, flag);
    poller.update({ [flag]: true }); await clock.advance(0); assert.equal(count, 1, flag);
    poller.update({ [flag]: false }); await clock.advance(180000); assert.equal(count, 1, flag);
    poller.update({ [flag]: true }); await clock.advance(0); assert.equal(count, 2, flag); poller.dispose();
  }
});
test('a pending request never overlaps, and a replaced provider ignores the old retry deadline', async () => {
  const clock = new FakeClock(); let resolve; let count = 0;
  const poller = createQuotaPoller({ clock, query: () => { count++; return count === 1 ? new Promise(done => { resolve = done; }) : Promise.resolve({ status: 'fresh', observedAt: clock.now() }); } });
  poller.update(visible); await clock.advance(0); await clock.advance(300000); assert.equal(count, 1);
  poller.update({ key: 'provider-two', result: null }); await clock.advance(0); assert.equal(count, 1);
  resolve({ status: 'stale', retryAt: 900000 }); await clock.advance(0); await clock.advance(0); assert.equal(count, 2); assert.equal(poller.snapshot().retryAt, 0); poller.dispose();
});
test('Retry-After blocks automatic and manual refresh, then resumes without force or overlapping calls', async () => {
  const clock = new FakeClock(); let count = 0; const args = [];
  const poller = createQuotaPoller({ clock, query: async (...input) => { args.push(input); count++; return count === 1 ? { status: 'stale', retryAt: 180000 } : { status: 'fresh', observedAt: clock.now() }; } });
  poller.update(visible); await clock.advance(0); await poller.refresh(); assert.equal(count, 1);
  await clock.advance(179999); assert.equal(count, 1); await clock.advance(1); assert.equal(count, 2);
  assert.deepEqual(args, [[], []]); poller.dispose();
});
test('failures back off exponentially and a skipped shared request retries slowly rather than busy-looping', async () => {
  const clock = new FakeClock(); let count = 0;
  const poller = createQuotaPoller({ clock, query: async () => { count++; if (count === 1) return { skipped: true }; throw new Error('fixture unavailable'); } });
  poller.update(visible); await clock.advance(0); assert.equal(count, 1);
  await clock.advance(999); assert.equal(count, 1); await clock.advance(1); assert.equal(count, 2);
  await clock.advance(60000); assert.equal(count, 3); await clock.advance(119999); assert.equal(count, 3); await clock.advance(1); assert.equal(count, 4); poller.dispose();
});
test('turning automatic refresh off preserves manual refresh and does not replay after an in-flight result', async () => {
  const clock = new FakeClock(); let count = 0; let resolve;
  const poller = createQuotaPoller({ clock, query: () => { count++; return new Promise(done => { resolve = done; }); } });
  poller.update({ ...visible, autoRefresh: false }); await clock.advance(120000); assert.equal(count, 0);
  const request = poller.refresh(); assert.equal(count, 1); resolve({ status: 'fresh', observedAt: clock.now() }); await request;
  await clock.advance(120000); assert.equal(count, 1); assert.equal(clock.timers.size, 0); poller.dispose();
});
test('visibility changes do not reuse an older cached fresh result to bypass a new failure backoff', async () => {
  const clock = new FakeClock(); let count = 0;
  const poller = createQuotaPoller({ clock, query: async () => { count++; throw new Error('temporary failure'); } });
  poller.update({ ...visible, result: { status: 'fresh', observedAt: 0 } }); await clock.advance(60000); assert.equal(count, 1);
  await clock.advance(1000); poller.update({ cardVisible: false }); poller.update({ cardVisible: true }); await clock.advance(0); assert.equal(count, 1);
  await clock.advance(59000); assert.equal(count, 2); poller.dispose();
});
test('external quota work pauses requests until idle without spinning or hiding an unrelated probe', async () => {
  const clock = new FakeClock(); let count = 0;
  const poller = createQuotaPoller({ clock, query: async () => { count++; return { status: 'fresh', observedAt: clock.now() }; } });
  poller.update({ ...visible, busy: true }); await clock.advance(60000); assert.equal(count, 0); assert.equal(clock.timers.size, 1);
  poller.update({ busy: false }); await clock.advance(0); assert.equal(count, 1);
  poller.update({ busy: true }); await clock.advance(120000); assert.equal(count, 1);
  poller.update({ busy: false }); await clock.advance(0); assert.equal(count, 2); poller.dispose();
});
test('disposal while querying ignores late data and does not recreate timers or state notifications', async () => {
  const clock = new FakeClock(); let resolve; let notifications = 0;
  const poller = createQuotaPoller({ clock, query: () => new Promise(done => { resolve = done; }), onState: () => { notifications++; } });
  poller.update(visible); await clock.advance(0); poller.dispose(); const before = notifications;
  resolve({ status: 'fresh', observedAt: clock.now() }); await clock.advance(120000);
  assert.equal(notifications, before); assert.equal(clock.timers.size, 0);
});
test('automatic refresh off still wakes the manual cooldown at Retry-After without querying', async () => {
  const clock = new FakeClock(); let count = 0;
  const poller = createQuotaPoller({ clock, query: async () => { count++; return { status: 'fresh', observedAt: clock.now() }; } });
  poller.update({ ...visible, autoRefresh: false, result: { status: 'error', retryAt: 120000 } });
  await poller.refresh(); assert.equal(count, 0); await clock.advance(120000); assert.equal(count, 0);
  assert.equal(poller.snapshot().now, 120000); assert.equal(clock.timers.size, 0);
  await poller.refresh(); assert.equal(count, 1); poller.dispose();
});
test('quota progress exists only for valid measured totals; unknown, zero totals and impossible values are not invented percentages', () => {
  assert.deepEqual(quotaMetricRatio({ remaining: 0, total: 100 }), { value: 0, kind: 'remaining' });
  assert.deepEqual(quotaMetricRatio({ used: 25, total: 100 }), { value: 25, kind: 'used' });
  for (const metric of [{}, { remaining: 2 }, { remaining: 0, total: 0 }, { remaining: 101, total: 100 }, { used: -1, total: 100 }, { remaining: null, total: 100 }]) assert.equal(quotaMetricRatio(metric), null);
});
