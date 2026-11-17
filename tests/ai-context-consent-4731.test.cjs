const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createBuiltinBatchClient } = require('../electron/lib/ai-workspace-client.cjs');
const { createOutboundTransport } = require('../electron/lib/ai-outbound-transport.cjs');
const { prepareBatch } = require('../electron/lib/ai-outbound-policy.cjs');
const { runWorkspaceJob, cleanupWorkspaceProcessor } = require('../electron/lib/ai-workspace-processor.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

for (const decision of ['cancel', 'send']) test(`asynchronously prepared complete batch needs explicit ${decision} decision before any provider call`, async () => {
  const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false, send() {} });
  let calls = 0, active = 0, maximumActive = 0;
  const transport = createOutboundTransport({ getOwner: () => owner, trustedOwner: () => owner,
    getEndpoint: () => 'https://fixture.invalid/chat', membership: async () => ({ activated: true, scope: 'vip' }), prepare: prepareBatch,
    request(_options, callback) {
      calls++; maximumActive = Math.max(maximumActive, ++active);
      const req = Object.assign(new EventEmitter(), { destroy() {} });
      req.end = () => queueMicrotask(() => {
        const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, complete: false, destroy() {} });
        callback(response);
        response.emit('data', Buffer.from(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'safe' } }] })));
        response.complete = true; response.emit('end'); active--;
      });
      return req;
    },
  });
  const batch = createBuiltinBatchClient({ request: transport.request,
    getConfig: () => ({ url: 'https://fixture.invalid/chat', model: 'fixture', key: 'memory-only' }), deferTimeoutUntilAuthorized: true,
    serializeBody: async payload => { await tick(); return JSON.stringify(payload); } });
  const requests = Array.from({ length: 3 }, (_, index) => ({ systemPrompt: 'Inspect', userContent: JSON.stringify({ index }), maxTokens: 3000 }));
  const pending = transport.withOperation({ title: 'fixture', kind: 'summary', contentFormat: 'workspace-json' },
    () => batch(requests, { run: action => transport.withBatch('frozen three', action, 1) }), owner);
  try {
    for (let turn = 0; turn < 100 && !transport.gate.list(owner).pending.length; turn++) await tick();
    const preview = transport.gate.list(owner).pending[0];
    assert.equal(preview.requestCount, 3);
    assert.equal(calls, 0);
    for (let index = 0; index < 3; index++) transport.gate.get(owner, { previewId: preview.id, index });
    assert.equal((await transport.gate.decide(owner, { previewId: preview.id, decision })).ok, true);
    const results = await pending;
    assert.equal(calls, decision === 'cancel' ? 0 : 3);
    assert.equal(results.every(item => item.ok), decision === 'send');
    assert.ok(maximumActive <= 1);
  } finally { transport.cleanup(); }
});

test('a full sixteen-request batch serializes through the real bounded worker before presenting one complete consent', async t => {
  t.after(cleanupWorkspaceProcessor);
  const owner = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send() {} });
  let calls = 0;
  const transport = createOutboundTransport({ getOwner: () => owner, trustedOwner: () => owner, getEndpoint: () => 'https://fixture.invalid/chat',
    membership: async () => ({ activated: true, scope: 'vip' }), prepare: prepareBatch, request: () => { calls++; assert.fail('No approval'); } });
  t.after(() => transport.cleanup());
  const client = createBuiltinBatchClient({ request: transport.request, deferTimeoutUntilAuthorized: true,
    getConfig: () => ({ url: 'https://fixture.invalid/chat', model: 'fixture', key: 'memory-only' }),
    serializeBody: (payload, options) => runWorkspaceJob('transportBody', { payload }, options) });
  const pending = transport.withOperation({ title: 'sixteen', contentFormat: 'workspace-json' }, () => client(
    Array.from({ length: 16 }, (_, index) => ({ systemPrompt: 'Inspect', userContent: JSON.stringify({ index }), maxTokens: 3000 })),
    { run: action => transport.withBatch('sixteen', action, 1) }), owner);
  for (let turn = 0; turn < 200 && !transport.gate.list(owner).pending.length; turn++) await new Promise(resolve => setTimeout(resolve, 5));
  const preview = transport.gate.list(owner).pending[0];
  assert.equal(preview?.requestCount, 16);
  assert.equal(calls, 0);
  await transport.gate.decide(owner, { previewId: preview.id, decision: 'cancel' });
  assert.ok((await pending).every(result => result.code === 'cancelled'));
});
