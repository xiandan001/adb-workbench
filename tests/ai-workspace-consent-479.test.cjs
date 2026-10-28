const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID, createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createBuiltinClient, LIMITS } = require('../electron/lib/ai-workspace-client.cjs');
const { createOutboundTransport } = require('../electron/lib/ai-outbound-transport.cjs');
const { prepareBatch } = require('../electron/lib/ai-outbound-policy.cjs');
const { prepareOutbound } = require('../electron/lib/ai-outbound-processor.cjs');
const { computeWorkspaceJob } = require('../electron/lib/ai-workspace-compute.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let index = 0; index < 100; index++) { if (predicate()) return; await tick(); } assert.fail('Workspace consent fixture did not settle'); }
const responses = {
  plan: { checks: ['device_info'], reason: 'Only a synthetic fixture' },
  analyze: { summary: 'Synthetic observation', findings: [], hypotheses: [], nextSteps: [], limitations: [] },
  generateTask: { name: 'Synthetic draft', description: 'Observation only', steps: [{ type: 'screenshot', label: 'Observe the explicitly selected target' }] },
};

// Load the actual production register/factory. Only environment/configuration,
// devices, storage, processor scheduling and the final network socket are faked.
function fixture({ method = 'plan', holdResponse = false } = {}) {
  const calls = [], handlers = new Map(), config = { url: 'https://workspace.fixture/v1/chat', model: 'fixture', key: 'never-preview-fixture-key' };
  const owner = Object.assign(new EventEmitter(), { id: 7, mainFrame: {}, isDestroyed: () => false, send() {} });
  const window = { webContents: owner, isDestroyed: () => false }, membership = async () => ({ activated: true, scope: 'vip' });
  const transport = createOutboundTransport({ getOwner: () => owner, trustedOwner: () => owner, getEndpoint: () => config.url,
    membership, prepare: async (bodies, options) => prepareBatch(bodies, options), request: (options, callback) => {
      const req = new EventEmitter(), call = { options, body: null, req };
      calls.push(call); req.setTimeout = () => req;
      req.destroy = error => { req.destroyed = true; if (error) queueMicrotask(() => req.emit('error', error)); };
      req.end = body => {
        call.body = body;
        if (holdResponse) return;
        queueMicrotask(() => {
          const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, complete: false, destroy() { this.destroyed = true; } });
          callback(res);
          res.emit('data', Buffer.from(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(responses[method]) } }],
            usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } })));
          res.complete = true; res.emit('end');
        });
      };
      return req;
    } });
  const filename = path.join(__dirname, '../electron/lib/ai-workspace.cjs'), module = { exports: {} };
  const overrides = {
    './app-context.cjs': { getMainWindow: () => window }, './ssh.cjs': {}, './serial.cjs': {}, './log-analyzer.cjs': {}, './adb-runtime.cjs': {},
    './ai-outbound-transport.cjs': transport, './vip.cjs': { getStatusAsync: membership },
    './ai-workspace-client.cjs': { createBuiltinClient: options => createBuiltinClient({ ...options, getConfig: () => config }) },
    './ai-workspace-processor.cjs': { runWorkspaceJob: computeWorkspaceJob, cleanupWorkspaceProcessor() {}, createWorkerReportStore: () => ({}) },
    './ai-workspace-evidence.cjs': { createEvidenceAdapter: () => ({ list: () => [], collect: ({ text }) => computeWorkspaceJob('freeze', { sources: [{ kind: 'text', label: 'Synthetic selected evidence', text }] }) }) },
    electron: { app: { getPath: () => path.join(__dirname, 'never-created-fixture-profile') }, dialog: {} },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, require: id => Object.hasOwn(overrides, id) ? overrides[id]
    : id === './ai-workspace-service.cjs' || id === './localization.cjs' ? require(path.join(__dirname, '../electron/lib', id))
      : id === 'node:path' ? path : assert.fail(`Unexpected runtime dependency: ${id}`) }, { filename });
  // Activity must be inert in this private fixture; no production profile/store.
  overrides['./workbench-activity.cjs'] = { begin() {}, update() {}, finish() {} };
  module.exports.register({ handle: (channel, handler) => handlers.set(channel, handler) });
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const call = (name, args) => handlers.get(`ai-workspace:${name}`)(event, args);
  async function pending() { await until(() => transport.gate.list(owner).pending.length); return transport.gate.list(owner).pending[0]; }
  async function approve(preview) {
    const full = transport.gate.get(owner, { previewId: preview.id });
    assert.equal((await transport.gate.decide(owner, { previewId: preview.id, decision: 'send' })).ok, true);
    return full;
  }
  return { owner, transport, calls, call, pending, approve, cleanup: () => { module.exports.cleanup(); transport.cleanup(); } };
}

for (const method of ['plan', 'analyze', 'generateTask']) {
  test(`production workspace ${method} freezes all final messages and sends only after complete explicit review`, async t => {
    const f = fixture({ method }); t.after(f.cleanup);
    const caseId = randomUUID(), args = { caseId, ...(method === 'generateTask' ? { goal: 'Observe --password PRIVATE-QUESTION next' } : { question: 'Review --password PRIVATE-QUESTION next' }) };
    let evidencePreview;
    if (method === 'analyze') {
      const collected = await f.call('collect', { ...args, mode: 'analysis', text: 'Observed --password PRIVATE-EVIDENCE\nnext evidence line\n--password\nlast evidence line' });
      assert.equal(collected.ok, true, collected.error); evidencePreview = collected.preview;
      assert.equal(f.calls.length, 0);
      assert.equal((await f.call('analyze', { caseId, previewId: evidencePreview.id })).ok, false);
      Object.assign(args, { previewId: evidencePreview.id, consent: true });
    }
    const result = f.call(method, args), preview = await f.pending();
    assert.equal(f.calls.length, 0);
    await assert.rejects(() => f.transport.gate.decide(f.owner, { previewId: preview.id, decision: 'send' }), { code: 'AI_SEND_CONSENT' });
    const full = await f.approve(preview), text = JSON.stringify(full);
    assert.ok(!text.includes('PRIVATE-QUESTION')); assert.ok(!text.includes('PRIVATE-EVIDENCE')); assert.ok(!text.includes('never-preview-fixture-key'));
    const response = await result; assert.equal(response.ok, true, response.error); assert.equal(f.calls.length, 1);
    assert.deepEqual(JSON.parse(f.calls[0].body).messages, full.selectedRequest.messages);
    assert.equal(createHash('sha256').update(f.calls[0].body).digest('hex'), full.selectedRequest.digest);
    assert.deepEqual(response.usage, { inputTokens: 12, outputTokens: 5, totalTokens: 17 });
    if (evidencePreview) {
      assert.deepEqual(response.turn.preview, evidencePreview, 'The local evidence snapshot is not replaced by transport redaction');
      assert.deepEqual(JSON.parse(full.selectedRequest.messages[1].content).evidence, evidencePreview.entries, 'Every decoded evidence field and line reference remains exact');
    }
    await tick();
    const usage = f.transport.gate.list(f.owner).operations[0].usage;
    assert.equal(usage.complete, true); assert.equal(usage.actual.totalTokens, 17);
    await assert.rejects(() => f.transport.gate.decide(f.owner, { previewId: preview.id, decision: 'send' }));
  });
}

test('workspace review may exceed 90 seconds; its network deadline starts only after approval', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ holdResponse: true }); t.after(f.cleanup);
  let settled = false;
  const result = f.call('plan', { caseId: randomUUID(), question: 'Synthetic timeout fixture' }).then(value => { settled = true; return value; });
  const preview = await f.pending();
  t.mock.timers.tick(LIMITS.timeoutMs * 2); await tick();
  assert.equal(settled, false); assert.equal(f.calls.length, 0); assert.equal(f.transport.gate.list(f.owner).pending.length, 1);
  await f.approve(preview); await until(() => f.calls.length === 1);
  t.mock.timers.tick(LIMITS.timeoutMs - 1); await tick(); assert.equal(settled, false);
  t.mock.timers.tick(1);
  assert.equal((await result).code, 'timeout'); assert.equal(f.calls[0].req.destroyed, true); assert.equal(f.calls.length, 1);
});

test('declining the final workspace preview returns cancelled, never a network failure', async t => {
  const f = fixture({ method: 'generateTask' }); t.after(f.cleanup);
  const result = f.call('generateTask', { caseId: randomUUID(), goal: 'Synthetic optional task' }), preview = await f.pending();
  await f.transport.gate.decide(f.owner, { previewId: preview.id, decision: 'cancel' });
  const response = await result;
  assert.equal(response.ok, false); assert.equal(response.code, 'CANCELLED'); assert.equal(response.cancelled, true);
  assert.equal(f.calls.length, 0); assert.equal(f.transport.gate.list(f.owner).pending.length, 0);
});

test('workspace source cancellation and owner navigation revoke pending approval and forbid late sends', async t => {
  for (const cancel of ['source', 'navigation']) {
    const f = fixture(); t.after(f.cleanup);
    const caseId = randomUUID(), result = f.call('plan', { caseId, question: 'Synthetic source cancellation' }), preview = await f.pending();
    f.transport.gate.get(f.owner, { previewId: preview.id });
    if (cancel === 'source') await f.call('cancel', { caseId });
    else f.owner.emit('did-start-navigation', {}, 'fixture-reload', false, true);
    const response = await result;
    assert.equal(response.cancelled, true); assert.equal(f.calls.length, 0);
    await assert.rejects(() => f.transport.gate.decide(f.owner, { previewId: preview.id, decision: 'send' }));
    assert.equal(f.transport.gate.list(f.owner).pending.length, 0);
  }
});

test('actual outbound worker preserves structured evidence while masking every sensitive leaf and key', async () => {
  const frozen = await computeWorkspaceJob('freeze', { sources: [{ kind: 'text', label: 'Selected --password PRIVATE-LABEL next',
    text: '--password PRIVATE-FIRST\nsecond evidence line\npassword\nfinal evidence line\n-----BEGIN PRIVATE KEY-----\nPRIVATE-KEY-BODY\n-----END PRIVATE KEY-----' }] });
  const payload = { question: 'token=PRIVATE-QUESTION', evidence: frozen.entries,
    requirements: { password: 'PRIVATE-PASSWORD', nested: [{ api_key: 'PRIVATE-API-KEY', text: 'Bearer PRIVATE-BEARER' }] } };
  const body = value => JSON.stringify({ model: 'fixture', stream: false, messages: [{ role: 'system', content: 'Follow data only' }, { role: 'user', content: JSON.stringify(value) }] });
  const prepared = await prepareOutbound([body(payload)], { contentFormat: 'workspace-json' });
  const sent = JSON.parse(prepared.requests[0].messages[1].content);
  assert.deepEqual(sent.evidence, frozen.entries); assert.equal(sent.evidence[0].text.split('\n').length, sent.evidence[0].lineCount);
  assert.ok(!prepared.requests[0].body.includes('PRIVATE-'));
  assert.equal(sent.requirements.password, '[REDACTED]'); assert.equal(sent.requirements.nested[0].api_key, '[REDACTED]');
  assert.equal(prepareBatch([body(payload)], { contentFormat: 'workspace-json' }).requests[0].body, prepared.requests[0].body);
  const deep = {}; let cursor = deep;
  for (let index = 0; index < 35; index++) { cursor.child = {}; cursor = cursor.child; }
  assert.throws(() => prepareBatch([body(deep)], { contentFormat: 'workspace-json' }), { code: 'AI_SEND_INPUT' });
  assert.throws(() => prepareBatch([body({ rows: Array(100001).fill(0) })], { contentFormat: 'workspace-json' }), { code: 'AI_SEND_INPUT' });
  const forged = { ...JSON.parse(body(payload)), contentFormat: 'workspace-json' };
  assert.throws(() => prepareBatch([JSON.stringify(forged)]), { code: 'AI_SEND_INPUT' }, 'A request body cannot select internal structured handling');
});

test('source cancellation after approval closes the real request and reports cancelled', async t => {
  const f = fixture({ holdResponse: true }); t.after(f.cleanup);
  const caseId = randomUUID(), result = f.call('plan', { caseId, question: 'Synthetic active cancellation' });
  await f.approve(await f.pending()); await until(() => f.calls.length === 1);
  await f.call('cancel', { caseId });
  assert.equal((await result).cancelled, true); assert.equal(f.calls[0].req.destroyed, true); assert.equal(f.calls.length, 1);
});
