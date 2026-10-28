const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHandoffBroker, publishHandoff, LIMITS } = require('../electron/lib/ai-analysis-handoff.cjs');
const { runWorkspaceJob, cleanupWorkspaceProcessor } = require('../electron/lib/ai-workspace-processor.cjs');
const { sanitize } = require('../electron/lib/ai-outbound-policy.cjs');

function fixture({ freeze, readReference } = {}) {
  let time = 1000000;
  let owner = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const published = [], reads = [];
  const broker = createHandoffBroker({ getOwner: () => owner, now: () => time, publish: (owner, payload, options) => published.push({ owner, payload, foreground: options.foreground }),
    freeze: freeze || (async ({ sources }) => ({ entries: sources.map((source, index) => ({ id: `E${index + 1}`, label: sanitize(source.label), text: `[L1] ${sanitize(source.text)}`, lineCount: 1, provenance: source.provenance, targetKey: source.provenance.trust === 'renderer-view' ? null : 'fixture-target' })), bytes: 1024, truncated: false })),
    readReference: async reference => { reads.push(reference); if (readReference) return readReference(reference); return { origin: reference.kind, title: 'Owned source', question: 'Analyze', text: 'password=reference-private', deviceId: 'fixture-device' }; } });
  return { broker, published, reads, owner, advance: value => { time += value; }, replaceOwner: () => { owner = { isDestroyed: () => false }; } };
}
const view = { origin: 'log-filter', title: 'View password=title-private', question: '--password question-private', text: 'token=body-private', deviceId: 'user-selected-device' };

test('renderer view handoff is frozen, redacted and labelled without asserting device facts', async () => {
  const f = fixture();
  const { handoffId } = await f.broker.createFromRenderer({ view });
  assert.equal(f.published.length, 1);
  assert.deepEqual(f.published[0].payload, { handoffId });
  assert.equal(f.published[0].foreground, true);
  const metadata = f.broker.get(handoffId);
  assert.equal(metadata.entries, undefined); assert.equal(metadata.text, undefined);
  assert.equal(metadata.deviceId, 'user-selected-device');
  assert.equal(metadata.provenance.trust, 'renderer-view');
  const context = await f.broker.resolveForWorkspace(handoffId);
  assert.equal(context.entries[0].targetKey, null);
  for (const secret of ['title-private', 'question-private', 'body-private']) assert.ok(!JSON.stringify(context).includes(secret));
  context.entries[0].text = 'mutated copy';
  assert.notEqual((await f.broker.resolveForWorkspace(handoffId)).entries[0].text, 'mutated copy');
  assert.equal(f.reads.length, 0, 'View handoff must never read a device or filesystem');
});
test('only explicit contextual entry restores and focuses its intended main window', async () => {
  const calls = [], owner = { send: () => calls.push('available') };
  const window = { webContents: owner, isDestroyed: () => false, isMinimized: () => true,
    restore: () => calls.push('restore'), show: () => calls.push('show'), focus: () => calls.push('focus') };
  publishHandoff({ getMainWindow: () => window }, owner, { handoffId: 'fixture' }, { foreground: true });
  assert.deepEqual(calls, ['available', 'restore', 'show', 'focus']);
  calls.length = 0; publishHandoff({ getMainWindow: () => window }, owner, { handoffId: 'fixture' });
  assert.deepEqual(calls, ['available']);
  assert.throws(() => publishHandoff({ getMainWindow: () => window }, {}, {}, { foreground: true }));
  const f = fixture(); await f.broker.createInternal({ origin: 'task-run', title: 'Completed task', text: 'existing evidence' });
  assert.equal(f.published[0].foreground, false);
});

test('typed reference is resolved server-side and arbitrary renderer authority fields are rejected', async () => {
  const f = fixture();
  await assert.rejects(() => f.broker.createFromRenderer({ view: { ...view, provenance: 'server-snapshot' } }));
  await assert.rejects(() => f.broker.createFromRenderer({ reference: { kind: 'artifact', artifactId: 'known', name: 'report.md', path: 'C:/private' } }));
  await assert.rejects(() => f.broker.createFromRenderer({ reference: { kind: 'unknown', id: 'forged' } }));
  assert.equal(f.reads.length, 0);
  const { handoffId } = await f.broker.createFromRenderer({ reference: { kind: 'artifact', artifactId: 'known', name: 'report.md' } });
  assert.equal(f.reads.length, 1);
  assert.equal((await f.broker.resolveForWorkspace(handoffId)).provenance.trust, 'server-snapshot');
  const changed = fixture({ readReference: async () => { throw new Error('Session changed'); } });
  await assert.rejects(() => changed.broker.createFromRenderer({ reference: { kind: 'serial', workspace: 'terminal', sessionId: 'old' } }), /Session changed/);
});

test('TTL, owner changes, navigation and queue bounds fail closed', async () => {
  const f = fixture();
  const first = await f.broker.createFromRenderer({ view });
  f.advance(LIMITS.ttl + 1); assert.throws(() => f.broker.get(first.handoffId));
  const second = await f.broker.createFromRenderer({ view });
  f.owner.emit('did-start-navigation', {}, 'app', false, true);
  assert.throws(() => f.broker.get(second.handoffId));
  for (let index = 0; index < 8; index++) await f.broker.createFromRenderer({ view });
  await assert.rejects(() => f.broker.createFromRenderer({ view }));
  f.replaceOwner(); assert.throws(() => f.broker.get(second.handoffId));
  assert.ok((await f.broker.createFromRenderer({ view })).handoffId, 'Replacing the owner releases old owner slots');
  const oversized = fixture();
  await assert.rejects(() => oversized.broker.createFromRenderer({ view: { ...view, text: '中'.repeat(200000) } }));
});

test('concurrent freeze and window disposal cannot exceed aggregate budget or resurrect tokens', async () => {
  let resume;
  const f = fixture({ freeze: async () => { await new Promise(resolve => { resume = resolve; }); return { entries: [{ label: 'fixture', text: '[L1] fixture', lineCount: 1 }], bytes: 1024 }; } });
  const pending = f.broker.createFromRenderer({ view });
  f.broker.cleanup(); resume(); await assert.rejects(() => pending);
  assert.equal(f.published.length, 0);
  const large = fixture({ freeze: async ({ sources }) => ({ entries: [{ label: sources[0].label, text: '[L1] fixture', lineCount: 1 }], bytes: 500000 }) });
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => large.broker.createFromRenderer({ view })));
  assert.ok(attempts.filter(result => result.status === 'fulfilled').length <= 4);
});

test('actual worker maintains renderer provenance and masks credentials in typed handoff content', async t => {
  t.after(cleanupWorkspaceProcessor);
  const f = fixture({ freeze: (args, options) => runWorkspaceJob('freeze', args, options) });
  const { handoffId } = await f.broker.createFromRenderer({ view });
  const context = await f.broker.resolveForWorkspace(handoffId);
  assert.equal(context.entries[0].targetKey, null);
  assert.equal(context.entries[0].provenance.trust, 'renderer-view');
  assert.ok(!JSON.stringify(context).includes('body-private'));
});

test('actual artifact handoff strips private task scripts before the final outbound preview', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/lib/artifact-center.cjs'), 'utf8');
  const start = source.indexOf('async function readAnalysisArtifact('), end = source.indexOf('\nmodule.exports', start);
  const original = JSON.stringify({ taskId: 'owned', result: 'failed check', rerunSnapshot: { command: 'NEVER-SEND-PRIVATE-RERUN-MARKER' } });
  let truncated = false;
  const read = vm.runInNewContext(`(${source.slice(start, end)})`, { tr: text => text,
    listArtifacts: async () => [{ id: 'known-artifact', title: 'Owned run', deviceId: 'fixture-device' }],
    previewArtifact: async () => ({ kind: 'text', content: original, truncated }),
    require: name => { assert.equal(name, './ai-outbound-processor.cjs'); return require('../electron/lib/ai-outbound-processor.cjs'); } });
  const input = await read('known-artifact', 'run-result.json');
  const f = fixture(); const { handoffId } = await f.broker.createInternal(input);
  const context = await f.broker.resolveForWorkspace(handoffId);
  const outbound = require('../electron/lib/ai-outbound-policy.cjs').prepareBody(JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: context.entries[0].text }], stream: false }));
  assert.ok(!outbound.body.includes('NEVER-SEND-PRIVATE-RERUN-MARKER'));
  assert.ok(!outbound.body.includes('rerunSnapshot')); assert.ok(outbound.body.includes('failed check'));
  assert.ok(original.includes('NEVER-SEND-PRIVATE-RERUN-MARKER'));
  truncated = true; await assert.rejects(() => read('known-artifact', 'run-result.json'), { code: 'AI_HANDOFF_PRIVATE_REPORT' });
  await assert.rejects(() => read('forged-path', 'run-result.json'));
});
