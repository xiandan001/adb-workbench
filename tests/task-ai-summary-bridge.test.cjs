const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskAiBridge } = require('../electron/lib/task-ai-summary-bridge.cjs');
const { createOutboundGate } = require('../electron/lib/ai-outbound-gate.cjs');
const { prepareBatch } = require('../electron/lib/ai-outbound-policy.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, totalMs) {
  const owner = { isDestroyed: () => false }, active = new Set(['task-A', 'task-B']); let sent = 0;
  const optionsSeen = [];
  const gate = createOutboundGate({ prepare: async bodies => prepareBatch(bodies), membership: async () => ({ activated: true, scope: 'vip' }) });
  const bridge = createTaskAiBridge({ totalMs, isActive: id => active.has(id), generate: async options => {
    optionsSeen.push(options); const operation = gate.begin(owner, { kind: 'summary', title: 'fixture' });
    const abort = () => gate.cancel(operation); options.signal.addEventListener('abort', abort, { once: true });
    try {
      return await gate.submit(operation, null, JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: 'synthetic task results only' }], stream: false }), async () => { sent++; return { ok: true, summary: 'fixture summary' }; });
    } catch (error) { return { ok: false, code: error.code, cancelled: error.code === 'AI_SEND_CANCELLED' }; }
    finally { options.signal.removeEventListener('abort', abort); gate.finishProducer(operation); }
  } });
  t.after(() => { bridge.cleanup(); gate.cleanup(); });
  return { owner, active, gate, bridge, optionsSeen, sent: () => sent };
}

test('cancelling the real main AI bridge removes its actual consent gate preview, so late approval cannot send', async t => {
  const h = fixture(t); const pending = h.bridge.run('request-A', 'task-A'); await flush();
  const preview = h.gate.list(h.owner).pending[0]; assert.ok(preview); h.gate.get(h.owner, { previewId: preview.id });
  h.bridge.cancelTask('task-A'); const result = await pending;
  assert.equal(result.skipped, true); assert.equal(result.cancelled, true); assert.equal(h.sent(), 0);
  await assert.rejects(h.gate.decide(h.owner, { previewId: preview.id, decision: 'send' }), { code: 'AI_SEND_EXPIRED' });
  assert.equal(h.sent(), 0); assert.equal(h.gate.list(h.owner).pending.length, 0);
});

test('review can outlive the old 70-second bridge timer without starting network, whose own timeout stays 60 seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = fixture(t); const pending = h.bridge.run('request-A', 'task-A', { timeoutMs: 60000 }); await flush();
  t.mock.timers.tick(70001); await flush(); assert.equal(h.sent(), 0); assert.equal(h.gate.list(h.owner).pending.length, 1);
  const preview = h.gate.list(h.owner).pending[0]; h.gate.get(h.owner, { previewId: preview.id });
  assert.equal((await h.gate.decide(h.owner, { previewId: preview.id, decision: 'send' })).ok, true);
  assert.equal((await pending).ok, true); assert.equal(h.sent(), 1); assert.equal(h.optionsSeen[0].timeoutMs, 60000);
});

test('worker watchdog cancellation is request-and-task scoped, and cleanup removes all unapproved requests', async t => {
  const h = fixture(t); const a = h.bridge.run('request-A', 'task-A'), b = h.bridge.run('request-B', 'task-B'); await flush();
  h.bridge.cancelRequest('request-A', 'task-B'); assert.equal(h.gate.list(h.owner).pending.length, 2);
  h.bridge.cancelRequest('request-A', 'task-A'); assert.equal((await a).skipped, true); assert.equal(h.gate.list(h.owner).pending.length, 1);
  h.bridge.cleanup(); assert.equal((await b).skipped, true); assert.equal(h.gate.list(h.owner).pending.length, 0); assert.equal(h.sent(), 0);
});

test('the total review limit aborts pending approval rather than leaving an approvable request behind', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const h = fixture(t, 1000);
  const pending = h.bridge.run('request-A', 'task-A'); await flush(); const preview = h.gate.list(h.owner).pending[0];
  t.mock.timers.tick(1000); const result = await pending;
  assert.equal(result.code, 'AI_REVIEW_TIMEOUT'); assert.equal(result.skipped, true);
  await assert.rejects(h.gate.decide(h.owner, { previewId: preview.id, decision: 'send' }), { code: 'AI_SEND_EXPIRED' }); assert.equal(h.sent(), 0);
});
