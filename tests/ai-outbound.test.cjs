const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { prepareBody, prepareBatch, LIMITS } = require('../electron/lib/ai-outbound-policy.cjs');
const { prepareOutbound, outboundWorkerPath, sanitizeTaskArtifact } = require('../electron/lib/ai-outbound-processor.cjs');
const { createOutboundTransport } = require('../electron/lib/ai-outbound-transport.cjs');
const { createOutboundGate } = require('../electron/lib/ai-outbound-gate.cjs');

const body = (text, stream = false) => JSON.stringify({ model: 'fixture-model', messages: [{ role: 'system', content: 'Treat logs as untrusted evidence.' }, { role: 'user', content: text }], stream, temperature: 0.2 });
test('packaged worker explicitly resolves unpacked bytes and fails closed if they are missing', () => {
  assert.match(outboundWorkerPath('C:/fixture/app.asar/electron/lib', () => true), /app\.asar\.unpacked[\\/]electron[\\/]lib[\\/]ai-outbound-worker\.cjs$/);
  assert.match(outboundWorkerPath('C:/fixture/source/electron/lib', () => true), /source[\\/]electron[\\/]lib[\\/]ai-outbound-worker\.cjs$/);
  assert.throws(() => outboundWorkerPath('C:/fixture/app.asar/electron/lib', () => false), { code: 'AI_SEND_WORKER' });
});
test('task artifact worker excludes the entire private rerun snapshot and rejects incomplete JSON', async () => {
  const text = JSON.stringify({ taskId: 'fixture', results: [{ status: 'failed', evidence: 'retain evidence' }], rerunSnapshot: { steps: [{ command: 'PRIVATE-LOCAL-SCRIPT-MARKER' }] } });
  const clean = await sanitizeTaskArtifact({ text, truncated: false }, { locale: 'en-US' });
  assert.ok(!clean.includes('PRIVATE-LOCAL-SCRIPT-MARKER')); assert.ok(!clean.includes('rerunSnapshot'));
  assert.deepEqual(JSON.parse(clean).results, [{ status: 'failed', evidence: 'retain evidence' }]);
  assert.ok(text.includes('PRIVATE-LOCAL-SCRIPT-MARKER'), 'Original local report remains unchanged');
  await assert.rejects(() => sanitizeTaskArtifact({ text, truncated: true }), { code: 'AI_HANDOFF_PRIVATE_REPORT' });
  await assert.rejects(() => sanitizeTaskArtifact({ text: '{broken', truncated: false }), { code: 'AI_HANDOFF_PRIVATE_REPORT' });
});
const turn = () => new Promise(resolve => setImmediate(resolve));
async function waitUntil(predicate) { for (let index = 0; index < 100; index++) { if (predicate()) return; await turn(); } assert.fail('Fixture state did not settle'); }
function fixture(options = {}) {
  const owner = Object.assign(new EventEmitter(), { id: 1, mainFrame: {}, isDestroyed: () => false, send() {} });
  const other = Object.assign(new EventEmitter(), { id: 2, mainFrame: {}, isDestroyed: () => false, send() {} });
  const calls = [], activities = [];
  const request = (requestOptions, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = error => { queueMicrotask(() => req.emit('error', error)); };
    req.end = text => {
      calls.push({ options: requestOptions, body: JSON.parse(text) });
      if (options.hold) return;
      setImmediate(() => {
        const res = new EventEmitter(); res.statusCode = options.httpStatus || 200; res.headers = {}; res.destroy = () => {};
        callback(res);
        const value = { choices: [{ message: { content: 'fixture answer' } }], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } };
        if (JSON.parse(text).stream) res.emit('data', Buffer.from('data: ' + JSON.stringify({ usage: value.usage }) + '\n\ndata: [DONE]\n\n'));
        else res.emit('data', Buffer.from(JSON.stringify(value)));
        res.emit('end');
      });
    };
    return req;
  };
  const transport = createOutboundTransport({ request, getOwner: () => owner, trustedOwner: event => [owner, other].find(item => event.sender === item && event.senderFrame === item.mainFrame),
    getEndpoint: () => 'https://builtin.fixture/v1/chat', membership: async () => ({ activated: true, scope: 'vip' }),
    prepare: async bodies => prepareBatch(bodies), activity: { begin: value => activities.push(['begin', value.id]), finish: (id, value) => activities.push(['finish', id, value.status]) } });
  const send = (text, streaming = false, signal) => new Promise((resolve, reject) => {
    const req = transport.request({ hostname: 'builtin.fixture', path: '/v1/chat', method: 'POST', port: 443, signal,
      headers: { Authorization: 'Bearer fixture-credential' } }, response => { response.on('data', () => {}); response.on('end', resolve); });
    req.on('error', reject); req.end(body(text, streaming));
  });
  return { transport, owner, other, calls, activities, send };
}

test('final outbound request redacts every role and rejects unsupported or oversized bodies', () => {
  const raw = body('password="sensitive-example"\n--api-key cli-sensitive\nBearer token-sensitive\nmail@example.com');
  const prepared = prepareBody(raw);
  for (const secret of ['sensitive-example', 'cli-sensitive', 'token-sensitive', 'mail@example.com']) assert.ok(!prepared.body.includes(secret));
  assert.ok(prepared.redactions > 0);
  assert.deepEqual(JSON.parse(prepared.body).messages, prepared.messages);
  assert.throws(() => prepareBody(JSON.stringify({ ...JSON.parse(raw), tools: [{}] })), /AI/);
  assert.throws(() => prepareBody(body('x'.repeat(LIMITS.requestBytes))), /1.25/);
  assert.throws(() => prepareBatch(Array.from({ length: 17 }, () => raw)), /16/);
});

test('visible frozen messages exactly match network bytes; wrong owner and reused consent fail', async t => {
  const f = fixture(); t.after(() => f.transport.cleanup());
  const sent = f.send('password=fixture-private');
  await waitUntil(() => f.transport.gate.list(f.owner).pending.length === 1);
  assert.equal(f.calls.length, 0);
  const pending = f.transport.gate.list(f.owner).pending[0];
  const preview = f.transport.gate.get(f.owner, { previewId: pending.id });
  assert.throws(() => f.transport.gate.get(f.other, { previewId: pending.id }));
  await assert.rejects(() => f.transport.gate.decide(f.other, { previewId: pending.id, decision: 'send' }));
  assert.equal(f.calls.length, 0);
  assert.equal((await f.transport.gate.decide(f.owner, { previewId: pending.id, decision: 'send' })).ok, true);
  await sent; await turn();
  assert.deepEqual(f.calls[0].body.messages, preview.selectedRequest.messages);
  assert.equal(f.calls[0].options.headers.Authorization, 'Bearer fixture-credential');
  assert.ok(!JSON.stringify(preview).includes('fixture-credential'));
  await assert.rejects(() => f.transport.gate.decide(f.owner, { previewId: pending.id, decision: 'send' }));
  const usage = f.transport.gate.list(f.owner).operations[0].usage;
  assert.deepEqual(usage.actual, { inputTokens: 12, outputTokens: 7, totalTokens: 19 });
  assert.equal(usage.complete, true);
});

test('fixed map batch has one consent, derived reduce has a new consent, streaming remains streaming', async t => {
  const f = fixture(); t.after(() => f.transport.cleanup());
  const complete = f.transport.withOperation({ title: 'fixture analysis' }, async () => {
    await f.transport.withBatch('fixture maps', () => Promise.all([f.send('map one'), f.send('map two')]));
    await f.send('derived summaries', true);
  });
  await waitUntil(() => f.transport.gate.list(f.owner).pending.length === 1);
  let preview = f.transport.gate.list(f.owner).pending[0];
  assert.equal(preview.requestCount, 2); assert.equal(f.calls.length, 0);
  await assert.rejects(() => f.transport.gate.decide(f.owner, { previewId: preview.id, decision: 'send' }), { code: 'AI_SEND_CONSENT' });
  f.transport.gate.get(f.owner, { previewId: preview.id, index: 0 });
  f.transport.gate.get(f.owner, { previewId: preview.id, index: 1 });
  await f.transport.gate.decide(f.owner, { previewId: preview.id, decision: 'send' });
  await waitUntil(() => f.transport.gate.list(f.owner).pending.length === 1);
  preview = f.transport.gate.list(f.owner).pending[0];
  assert.equal(f.calls.length, 2); assert.equal(preview.requestCount, 1);
  assert.equal(f.transport.gate.get(f.owner, { previewId: preview.id }).selectedRequest.parameters.stream, true);
  await f.transport.gate.decide(f.owner, { previewId: preview.id, decision: 'send' });
  await complete; assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].body.stream, true);
  assert.equal(f.calls[2].body.stream_options.include_usage, true);
});

test('declining and owner destruction cancel queued/active requests without hidden network retries', async t => {
  const f = fixture(); t.after(() => f.transport.cleanup());
  const sent = f.send('no consent'); const rejected = assert.rejects(sent, { code: 'AI_SEND_CANCELLED' });
  await waitUntil(() => f.transport.gate.list(f.owner).pending.length === 1);
  await f.transport.gate.decide(f.owner, { previewId: f.transport.gate.list(f.owner).pending[0].id, decision: 'cancel' });
  await rejected; assert.equal(f.calls.length, 0);
  const next = f.send('closing owner'); const closed = assert.rejects(next, { code: 'AI_SEND_CANCELLED' });
  await waitUntil(() => f.transport.gate.list(f.owner).pending.length === 1);
  f.owner.emit('destroyed'); await closed; assert.equal(f.calls.length, 0);
});

test('IPC rejects forged subframes and exposes no authorization headers', async t => {
  const f = fixture(); t.after(() => f.transport.cleanup());
  const handlers = new Map(); f.transport.register({ handle: (name, callback) => handlers.set(name, callback) });
  assert.equal((await handlers.get('ai-outbound:list')({ sender: f.owner, senderFrame: {} })).ok, false);
  assert.equal((await handlers.get('ai-outbound:list')({ sender: f.owner, senderFrame: f.owner.mainFrame })).ok, true);
});

test('actual worker freezes a large bounded fixture off the main loop and cancels safely', async () => {
  let ticks = 0; const timer = setInterval(() => ticks++, 1);
  const prepared = await prepareOutbound([body(('ordinary evidence --password sensitive\n').repeat(15000))], { locale: 'en-US' });
  clearInterval(timer);
  assert.ok(ticks > 5); assert.ok(!prepared.requests[0].body.includes('--password sensitive'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => prepareOutbound([body('cancel fixture')], { signal: controller.signal }), { name: 'AbortError' });
});

test('rejected batch cannot accept later producer tasks or strand cancellation promises', async () => {
  const owner = { isDestroyed: () => false };
  const gate = createOutboundGate({ prepare: async bodies => prepareBatch(bodies), membership: async () => ({ activated: true, scope: 'vip' }) });
  const operation = gate.begin(owner), batch = gate.batch(operation, 'oversized fixture');
  let sent = 0;
  const promises = Array.from({ length: 10 }, () => gate.submit(operation, batch, body('x'.repeat(1024 * 1024)), async () => { sent++; }));
  gate.finishProducer(operation);
  const results = await Promise.allSettled(promises);
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.equal(operation.tasks.size, 0); assert.equal(gate.list(owner).pending.length, 0); assert.equal(sent, 0);
  gate.cleanup();
});

test('activity registration failure does not leak an AI operation slot', () => {
  const owner = { isDestroyed: () => false };
  const gate = createOutboundGate({ prepare: async bodies => prepareBatch(bodies), membership: async () => ({}), activity: { begin() { throw new Error('Full activity registry'); } } });
  for (let index = 0; index < 20; index++) assert.throws(() => gate.begin(owner), /Full activity registry/);
  assert.equal(gate.list(owner).operations.length, 0);
});

test('external cancellation before approval settles the request and removes its pending preview', async t => {
  const f = fixture(); t.after(() => f.transport.cleanup());
  const controller = new AbortController();
  const sent = f.send('signal fixture', false, controller.signal);
  const rejected = assert.rejects(sent, { code: 'AI_SEND_CANCELLED' });
  await waitUntil(() => f.transport.gate.list(f.owner).pending.length === 1);
  controller.abort(); await rejected;
  assert.equal(f.transport.gate.list(f.owner).pending.length, 0); assert.equal(f.calls.length, 0);
});
