const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createAiWorkspaceService } = require('../electron/lib/ai-workspace-service.cjs');
const { registerHandlers, cleanup } = require('../electron/lib/ai-workspace.cjs');
const { withLocale, getLocale } = require('../electron/lib/localization.cjs');

const analysis = { summary: 'fixture', findings: [{ title: 'observed', detail: 'fixture detail', evidenceIds: ['E1'] }], hypotheses: [], nextSteps: [], limitations: ['clock unknown'] };
const task = { name: 'fixture task', description: 'review first', steps: [{ type: 'screenshot', label: 'capture' }] };
function harness(overrides = {}) {
  let now = 1000;
  const calls = [], saved = [];
  const deps = { client: async args => { calls.push(args); return { ok: true, text: JSON.stringify(analysis), usage: null }; },
    evidence: { list: () => [], collect: async () => ({ entries: [{ id: 'E1', text: 'fixture data' }], bytes: 50, truncated: false }) },
    membership: async () => ({ activated: true, scope: 'vip' }), saveTask: async draft => { saved.push(draft); return { ...draft, id: 'new-script' }; },
    confirmSave: async () => true, now: () => now, ...overrides };
  const service = createAiWorkspaceService(deps);
  return { service, calls, saved, deps, advance: ms => { now += ms; } };
}
const collect = (h, caseId) => h.service.call('collect', { caseId, mode: 'analysis', question: 'synthetic question', text: 'synthetic' });

test('collection never calls AI; consent sends the exact frozen redacted question and evidence', async () => {
  const h = harness(); const caseId = randomUUID();
  const p = await collect(h, caseId); assert.equal(p.ok, true); assert.equal(h.calls.length, 0);
  const invalid = await h.service.call('analyze', { caseId, previewId: p.preview.id }); assert.equal(invalid.ok, false);
  const answer = await h.service.call('analyze', { caseId, previewId: p.preview.id, consent: true });
  assert.equal(answer.ok, true); assert.equal(h.calls.length, 1);
  assert.deepEqual(JSON.parse(h.calls[0].userContent), { question: p.preview.question, evidence: p.preview.entries });
  assert.equal(answer.usage, null);
  assert.equal((await h.service.call('analyze', { caseId, previewId: p.preview.id, consent: true })).cached, true);
  assert.equal(h.calls.length, 1);
});

test('foreign, expired and replaced preview tokens cannot submit old content', async () => {
  const h = harness(); const a = randomUUID(), b = randomUUID();
  const p = await collect(h, a);
  assert.equal((await h.service.call('analyze', { caseId: b, previewId: p.preview.id, consent: true })).ok, false);
  await collect(h, a);
  assert.equal((await h.service.call('analyze', { caseId: a, previewId: p.preview.id, consent: true })).ok, false);
  const p2 = await collect(h, a); h.advance(16 * 60000);
  assert.equal((await h.service.call('analyze', { caseId: a, previewId: p2.preview.id, consent: true })).ok, false);
  assert.equal(h.calls.length, 0);
});

test('a new explicit analysis follows current locale without changing frozen evidence or reusing another language cache', async () => {
  const seen = [];
  const h = harness({ client: async args => { seen.push({ locale: getLocale(), content: args.userContent }); return { ok: true, text: JSON.stringify(analysis) }; } });
  const caseId = randomUUID(); const p = await withLocale('zh-CN', () => collect(h, caseId));
  const args = { caseId, previewId: p.preview.id, consent: true };
  assert.equal((await withLocale('zh-CN', () => h.service.call('analyze', args))).ok, true);
  assert.equal((await withLocale('ja-JP', () => h.service.call('analyze', args))).cached, false);
  assert.deepEqual(seen.map(item => item.locale), ['zh-CN', 'ja-JP']);
  assert.equal(seen[0].content, seen[1].content);
  assert.equal((await withLocale('ja-JP', () => h.service.call('analyze', args))).cached, true);
});

test('main-process membership check blocks model calls and task saving without changing saved settings', async () => {
  const h = harness({ membership: async () => ({ activated: false, scope: 'free' }) });
  const caseId = randomUUID();
  assert.equal((await h.service.call('plan', { caseId, question: 'fixture' })).code, 'AI_MEMBERSHIP');
  assert.equal((await h.service.call('generateTask', { caseId, goal: 'fixture' })).code, 'AI_MEMBERSHIP');
  assert.equal((await h.service.call('saveTask', { caseId, draftId: randomUUID() })).code, 'AI_MEMBERSHIP');
  assert.equal(h.calls.length, 0); assert.equal(h.saved.length, 0);
});

test('case concurrency is bounded and cancelling one case never cancels another', async () => {
  const pending = [];
  const h = harness({ client: args => new Promise(resolve => {
    pending.push({ args, resolve }); args.signal.addEventListener('abort', () => resolve({ ok: false, code: 'cancelled', error: 'cancelled' }));
  }) });
  const a = randomUUID(), b = randomUUID(), c = randomUUID();
  const first = h.service.call('plan', { caseId: a, question: 'one' });
  const second = h.service.call('plan', { caseId: b, question: 'two' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.service.call('plan', { caseId: a, question: 'duplicate' })).code, 'AI_BUSY');
  assert.equal((await h.service.call('plan', { caseId: c, question: 'third' })).code, 'AI_CONCURRENCY');
  await h.service.call('cancel', { caseId: a }); assert.equal((await first).cancelled, true);
  assert.equal(pending[1].args.signal.aborted, false);
  pending[1].resolve({ ok: true, text: JSON.stringify({ checks: ['device_info'], reason: 'fixture' }) });
  assert.equal((await second).ok, true);
});

test('generated task is strictly validated, confirmed and saved once without any execution API', async () => {
  const h = harness({ client: async () => ({ ok: true, text: JSON.stringify(task), usage: null }) });
  const caseId = randomUUID(); const generated = await h.service.call('generateTask', { caseId, goal: 'synthetic goal' });
  assert.equal(generated.ok, true); assert.equal(h.saved.length, 0);
  const saved = await h.service.call('saveTask', { caseId, draftId: generated.draft.id });
  assert.equal(saved.ok, true); assert.equal(h.saved.length, 1); assert.deepEqual(h.saved[0], task);
  assert.equal((await h.service.call('saveTask', { caseId, draftId: generated.draft.id })).ok, false);
});

test('closing a case while save confirmation is open prevents a late write', async () => {
  let confirm;
  const h = harness({ client: async () => ({ ok: true, text: JSON.stringify(task) }), confirmSave: () => new Promise(resolve => { confirm = resolve; }) });
  const caseId = randomUUID(); const generated = await h.service.call('generateTask', { caseId, goal: 'fixture' });
  const pending = h.service.call('saveTask', { caseId, draftId: generated.draft.id });
  await new Promise(resolve => setImmediate(resolve));
  await h.service.call('close', { caseId }); confirm(true);
  assert.equal((await pending).cancelled, true); assert.equal(h.saved.length, 0);
});

test('unsafe model output and invented references are rejected without auto retry', async () => {
  let calls = 0;
  const h = harness({ client: async () => { calls++; return { ok: true, text: JSON.stringify({ ...analysis, findings: [{ ...analysis.findings[0], evidenceIds: ['E99'] }] }) }; } });
  const caseId = randomUUID(); const p = await collect(h, caseId);
  assert.equal((await h.service.call('analyze', { caseId, previewId: p.preview.id, consent: true })).code, 'invalid_evidence');
  assert.equal(calls, 1);
});

test('only the current main frame can access typed operations; navigation disposes in-flight cases', async () => {
  const handlers = new Map(); const sender = new EventEmitter(); sender.mainFrame = {};
  let disposed = 0, invoked = 0;
  registerHandlers({ handle: (name, fn) => handlers.set(name, fn) }, {
    getOwner: () => ({ isDestroyed: () => false, webContents: sender }),
    factory: () => ({ call: async () => { invoked++; return { ok: true }; }, dispose: () => { disposed++; } }),
  });
  const call = handlers.get('ai-workspace:sources');
  assert.equal((await call({ sender, senderFrame: {} })).code, 'AI_OWNER');
  assert.equal(invoked, 0);
  assert.equal((await call({ sender, senderFrame: sender.mainFrame })).ok, true);
  sender.emit('did-start-navigation', {}, 'fixture', false, true);
  assert.equal(disposed, 1);
  for (let i = 0; i < 15; i++) {
    await call({ sender, senderFrame: sender.mainFrame });
    sender.emit('did-start-navigation', {}, 'fixture', false, true);
  }
  assert.equal(sender.listenerCount('did-start-navigation'), 1);
  assert.equal(sender.listenerCount('destroyed'), 1);
  cleanup();
});
