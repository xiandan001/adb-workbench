const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createByteBudget } = require('../electron/lib/ai-context-budget.cjs');
const { createHandoffBroker } = require('../electron/lib/ai-analysis-handoff.cjs');
const { cleanupWorkspaceProcessor } = require('../electron/lib/ai-workspace-processor.cjs');

test('byte reservations reject excess without evicting active carriers and release only once', () => {
  const budget = createByteBudget(128), release = budget.reserve(100);
  assert.throws(() => budget.reserve(29), error => error.code === 'AI_CONTEXT_MEMORY');
  release(); release();
  const complete = budget.reserve(128);
  assert.throws(() => budget.reserve(1)); complete();
  assert.throws(() => budget.reserve(-1));
});

test('reference reading freezes the original owner generation and propagates navigation cancellation before any freeze', async () => {
  const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  let resume, signal, freezes = 0;
  const broker = createHandoffBroker({ getOwner: () => owner, publish() {}, freeze: async () => { freezes++; },
    readReference: (_reference, options) => { signal = options.signal; return new Promise(resolve => { resume = resolve; }); } });
  const pending = broker.createFromRenderer({ reference: { kind: 'serial', workspace: 'rs232', sessionId: 'fixture' } });
  await assert.rejects(broker.createFromRenderer({ reference: { kind: 'artifact', artifactId: 'known', name: 'safe.log' } }));
  owner.emit('did-start-navigation', {}, 'unused', false, true);
  assert.equal(signal.aborted, true);
  resume({ origin: 'serial', title: 'Owned', text: 'Complete HEX: 00 08' });
  await assert.rejects(pending);
  assert.equal(freezes, 0); broker.cleanup();
});

test('concurrent preparation bytes are reserved before work and released after cancellation or completion', async t => {
  t.after(cleanupWorkspaceProcessor);
  const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  let resume, freezes = 0;
  const wait = new Promise(resolve => { resume = resolve; });
  const broker = createHandoffBroker({ getOwner: () => owner, publish() {}, freeze: async () => {
    freezes++; await wait; return { entries: [{ label: 'Bounded', text: 'frozen', lineCount: 1 }], bytes: 100, truncated: false };
  } });
  const view = { origin: 'log-filter', title: 'Bounded', text: 'x'.repeat(11 * 1024 * 1024) };
  const pending = Array.from({ length: 5 }, () => broker.createFromRenderer({ view }));
  await assert.rejects(broker.createFromRenderer({ view }), error => error.code === 'AI_CONTEXT_MEMORY');
  assert.equal(freezes, 5);
  resume(); await Promise.all(pending);
  assert.ok((await broker.createFromRenderer({ view: { ...view, text: 'new complete material' } })).handoffId);
  broker.cleanup();
});
