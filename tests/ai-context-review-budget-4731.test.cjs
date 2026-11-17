const test = require('node:test');
const assert = require('node:assert/strict');
const { createOutboundGate } = require('../electron/lib/ai-outbound-gate.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('pending complete previews have an aggregate byte budget released by cancellation', async () => {
  const owner = { isDestroyed: () => false }, pending = [], body = 'x'.repeat(1200000);
  const gate = createOutboundGate({ membership: async () => ({ activated: true, scope: 'vip' }), prepare: async bodies => ({
    requests: bodies.map(body => ({ body, bytes: Buffer.byteLength(body), messages: [], parameters: {} })),
    bytes: bodies.reduce((sum, body) => sum + Buffer.byteLength(body), 0), estimatedInputTokens: 0, redactions: 0,
  }) });
  function add() {
    const operation = gate.begin(owner), batch = gate.batch(operation);
    for (let index = 0; index < 16; index++) pending.push(gate.submit(operation, batch, body, () => assert.fail('No explicit consent')).catch(error => error));
    return operation;
  }
  try {
    const first = add(); add(); add(); await tick();
    assert.equal(gate.list(owner).pending.length, 3, 'Three complete 19.2MB previews fit the 64MiB aggregate');
    add(); await tick();
    assert.equal(gate.list(owner).pending.length, 3, 'Fourth preview is rejected without evicting existing ones');
    gate.cancel(first); add(); await tick();
    assert.equal(gate.list(owner).pending.length, 3, 'Cancellation releases exactly the cancelled byte reservation');
  } finally { gate.cleanup(); await Promise.all(pending); }
});
