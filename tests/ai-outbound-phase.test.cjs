const test = require('node:test');
const assert = require('node:assert/strict');
const { createOutboundGate } = require('../electron/lib/ai-outbound-gate.cjs');
const { prepareBatch } = require('../electron/lib/ai-outbound-policy.cjs');
const { getLocale, setLocale, tr } = require('../electron/lib/localization.cjs');

const body = text => JSON.stringify({ model: 'fixture-model', messages: [{ role: 'user', content: text }], stream: false });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await turn(); } assert.fail('Real gate phase did not settle'); }
function setup(t, options = {}) {
  const owner = { isDestroyed: () => false }, other = { isDestroyed: () => false }, publications = [];
  const gate = createOutboundGate({ prepare: async bodies => prepareBatch(bodies), membership: async () => ({ activated: true, scope: 'vip' }),
    publish: target => publications.push(gate.list(target)), ...options });
  t.after(() => gate.cleanup());
  return { owner, other, gate, publications, current: () => gate.list(owner).operations[0] };
}
async function approve(f) {
  await until(() => f.gate.list(f.owner).pending.length === 1);
  const preview = f.gate.list(f.owner).pending[0]; f.gate.get(f.owner, { previewId: preview.id });
  const reply = await f.gate.decide(f.owner, { previewId: preview.id, decision: 'send' }); assert.equal(reply.ok, true); return preview;
}

test('real gate exposes preparing, awaiting-confirmation and sending only at their existing milestones', async t => {
  const prepared = deferred(), runner = deferred(), f = setup(t, { prepare: () => prepared.promise });
  const operation = f.gate.begin(f.owner); let calls = 0;
  assert.equal(f.current().phase, 'preparing'); assert.equal(f.current().stage, tr('准备发送预览'));
  const pending = f.gate.submit(operation, null, body('immutable local evidence'), async () => { calls++; return runner.promise; });
  f.gate.finishProducer(operation); await turn(); assert.equal(f.current().phase, 'preparing'); assert.equal(calls, 0);
  prepared.resolve(prepareBatch([body('immutable local evidence')])); await until(() => f.gate.list(f.owner).pending.length === 1);
  assert.equal(f.current().phase, 'awaiting-confirmation'); assert.equal(f.current().stage, tr('等待确认 AI 发送预览')); assert.equal(calls, 0);
  await approve(f); await until(() => calls === 1);
  assert.equal(f.current().phase, 'sending'); assert.equal(f.current().stage, tr('正在发送已确认的 AI 请求')); assert.equal(f.current().status, 'running');
  runner.resolve({ usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } }); await pending; await turn();
  assert.equal(f.current().status, 'completed'); assert.equal(f.current().phase, 'sending');
  assert.deepEqual(f.current().usage.actual, { inputTokens: 2, outputTokens: 3, totalTokens: 5 });
  assert.equal(f.current().usage.sentRequests, 1); assert.equal(f.current().usage.observedRequests, 1);
  assert.ok(f.publications.some(value => value.operations.some(item => item.phase === 'awaiting-confirmation')));
});
test('preview cancellation preserves the last milestone but terminal status and zero sent requests remain authoritative', async t => {
  const f = setup(t), operation = f.gate.begin(f.owner); let calls = 0;
  const outcome = f.gate.submit(operation, null, body('not sent'), async () => { calls++; }).catch(error => error);
  f.gate.finishProducer(operation); await until(() => f.gate.list(f.owner).pending.length === 1);
  assert.equal(f.current().phase, 'awaiting-confirmation');
  await f.gate.decide(f.owner, { previewId: f.gate.list(f.owner).pending[0].id, decision: 'cancel' });
  assert.equal((await outcome).code, 'AI_SEND_CANCELLED'); assert.equal(f.current().status, 'cancelled'); assert.equal(f.current().phase, 'awaiting-confirmation');
  assert.equal(calls, 0); assert.equal(f.current().usage.sentRequests, 0); assert.equal(f.current().usage.observedRequests, 0); assert.equal(f.current().usage.actual.totalTokens, 0);
});
test('stopping after explicit approval but before response bytes does not pretend a completed answer or reported usage', async t => {
  const f = setup(t), operation = f.gate.begin(f.owner); let calls = 0;
  const outcome = f.gate.submit(operation, null, body('approved but no reply'), (_text, signal) => new Promise((_resolve, reject) => {
    calls++; signal.addEventListener('abort', () => reject(Object.assign(new Error('cancel fixture'), { name: 'AbortError' })), { once: true });
  })).catch(error => error);
  f.gate.finishProducer(operation); await approve(f); await until(() => calls === 1); assert.equal(f.current().phase, 'sending');
  f.gate.cancel(operation); await outcome; await turn();
  assert.equal(f.current().status, 'cancelled'); assert.equal(f.current().phase, 'sending'); assert.equal(f.current().usage.complete, false);
  assert.equal(f.current().usage.observedRequests, 0); assert.equal(f.current().usage.actual.totalTokens, 0); assert.equal(calls, 1);
});
test('phase remains fixed ASCII while localized stage text varies and failed preparation stays terminal without sending', async t => {
  const previous = getLocale(); t.after(() => setLocale(previous));
  for (const locale of ['en-US', 'ja-JP']) {
    setLocale(locale); const f = setup(t), operation = f.gate.begin(f.owner);
    assert.equal(f.current().phase, 'preparing'); assert.equal(f.current().stage, tr('准备发送预览'));
    const outcome = f.gate.submit(operation, null, body('local evidence'), async () => {}).catch(error => error);
    f.gate.finishProducer(operation); await until(() => f.gate.list(f.owner).pending.length === 1);
    assert.equal(f.current().phase, 'awaiting-confirmation'); assert.equal(f.current().stage, tr('等待确认 AI 发送预览'));
    f.gate.cancel(operation); await outcome;
  }
  const f = setup(t, { prepare: async () => { throw new Error('PRIVATE preparation payload'); } }), operation = f.gate.begin(f.owner); let calls = 0;
  const outcome = f.gate.submit(operation, null, body('private request'), async () => { calls++; }).catch(error => error); f.gate.finishProducer(operation);
  await outcome; assert.equal(f.current().status, 'failed'); assert.equal(f.current().phase, 'preparing'); assert.equal(calls, 0);
  assert.doesNotMatch(JSON.stringify(f.current()), /PRIVATE preparation payload|private request/);
});
test('new metadata never bypasses preview visits or owner consent and does not expose request body, owner or authorization', async t => {
  const f = setup(t), operation = f.gate.begin(f.owner); let calls = 0;
  const outcome = f.gate.submit(operation, null, body('PRIVATE raw evidence'), async () => { calls++; }).catch(error => error); f.gate.finishProducer(operation);
  await until(() => f.gate.list(f.owner).pending.length === 1); const preview = f.gate.list(f.owner).pending[0];
  await assert.rejects(f.gate.decide(f.other, { previewId: preview.id, decision: 'send' }), { code: 'AI_SEND_EXPIRED' });
  await assert.rejects(f.gate.decide(f.owner, { previewId: preview.id, decision: 'send' }), { code: 'AI_SEND_CONSENT' });
  assert.equal(f.current().phase, 'awaiting-confirmation'); assert.equal(calls, 0); assert.equal(f.gate.list(f.other).operations.length, 0);
  assert.deepEqual(Object.keys(f.current()).sort(), ['endedAt', 'id', 'kind', 'phase', 'stage', 'startedAt', 'status', 'title', 'usage'].sort());
  assert.doesNotMatch(JSON.stringify(f.current()), /PRIVATE raw evidence|Authorization|Bearer/);
  f.gate.cancel(operation); await outcome;
});
