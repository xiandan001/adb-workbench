const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { createAiWorkspaceService } = require('../electron/lib/ai-workspace-service.cjs');
const { createEvidenceAdapter } = require('../electron/lib/ai-workspace-evidence.cjs');
const { createReportHistory } = require('../electron/lib/ai-workspace-history.cjs');
const analysis = { summary: 'fixture summary', findings: [{ title: 'fixture fact', detail: 'fixture details', evidenceIds: ['E1'], citations: [{ evidenceId: 'E1', startLine: 1, endLine: 1 }] }], hypotheses: [], nextSteps: [], limitations: [] };
function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ai-flows-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('awb-ai-flows-')); fs.rmSync(directory, { recursive: true, force: true }); });
  let now = 1000; const calls = [], saved = [], devices = [];
  const deps = { evidence: createEvidenceAdapter({ runAdb: async args => { devices.push(args); return { ok: true, stdout: args.includes('get-state') ? 'device' : 'fixture one\nfixture two' }; } }),
    client: async args => { calls.push(args); return { ok: true, text: JSON.stringify(analysis), usage: null }; },
    membership: async () => ({ activated: true, scope: 'vip' }), history: createReportHistory({ directory }),
    confirmSave: async () => true, saveTask: async draft => { saved.push(draft); return { id: randomUUID(), ...draft }; },
    now: () => now, ...overrides };
  const service = createAiWorkspaceService(deps), caseId = randomUUID();
  const collect = (extra = {}) => service.call('collect', { caseId, mode: 'analysis', question: 'fixture question', text: 'fixture log', ...extra });
  const analyze = preview => service.call('analyze', { caseId, previewId: preview.id, consent: true });
  return { directory, service, deps, caseId, collect, analyze, calls, saved, devices, advance: ms => { now += ms; } };
}

test('follow-up resolves prior context only server-side and requires a new frozen preview and fresh consent', async t => {
  const h = fixture(t), first = await h.collect(), answer = await h.analyze(first.preview);
  const ref = { caseId: h.caseId, turnId: answer.turn.id };
  answer.turn.result.summary = 'renderer forgery'; first.preview.entries[0].text = 'renderer evidence forgery';
  const next = await h.collect({ contextRef: ref, text: '', question: 'follow-up question' });
  assert.equal(next.ok, true); assert.notEqual(next.preview.id, first.preview.id); assert.equal(h.calls.length, 1);
  assert.equal(next.preview.context.summary, 'fixture summary'); assert.equal(next.preview.entries[0].text, '[L1] fixture log');
  assert.equal((await h.analyze(first.preview)).code, 'AI_PREVIEW_EXPIRED');
  assert.equal((await h.service.call('analyze', { caseId: h.caseId, previewId: next.preview.id })).ok, false);
  const followup = await h.analyze(next.preview); assert.equal(followup.turn.kind, 'followup');
  assert.deepEqual(JSON.parse(h.calls[1].userContent), { question: next.preview.question, evidence: next.preview.entries, context: next.preview.context });
  const merged = await h.collect({ contextRef: ref, text: 'explicit additional evidence' });
  assert.deepEqual(merged.preview.entries.map(entry => entry.id), ['E1', 'E2']);
  const forged = await h.collect({ contextRef: { ...ref, result: { summary: 'forged' } } }); assert.equal(forged.code, 'AI_REPORT');
});

test('follow-up rejects changed targets and explicitly selected offline targets without silently switching', async t => {
  const h = fixture(t);
  const first = await h.collect({ deviceId: 'device-A', checks: ['device_info'], text: '' }), answer = await h.analyze(first.preview);
  const contextRef = { caseId: h.caseId, turnId: answer.turn.id };
  assert.equal((await h.collect({ contextRef, deviceId: 'device-B', text: '' })).code, 'AI_SOURCE_CHANGED');
  h.deps.evidence.verifyTarget = async () => { throw Object.assign(new Error('offline fixture'), { code: 'AI_DEVICE_OFFLINE' }); };
  assert.equal((await h.collect({ contextRef, deviceId: 'device-A', text: '' })).code, 'AI_DEVICE_OFFLINE');
  assert.ok(h.devices.every(args => args[1] === 'device-A'));
});

test('history is manual, survives a new service, and loading never restores an analysis authorization', async t => {
  const h = fixture(t); const p = await h.collect(), a = await h.analyze(p.preview);
  assert.deepEqual((await h.service.call('historyList')).items, []);
  const stored = await h.service.call('historySave', { caseId: h.caseId, turnId: a.turn.id, name: 'saved fixture' }); assert.equal(stored.ok, true);
  const restarted = createAiWorkspaceService({ ...h.deps, history: createReportHistory({ directory: h.directory }) });
  const loaded = await restarted.call('historyLoad', { id: stored.item.id }); assert.equal(loaded.report.name, 'saved fixture');
  assert.equal((await restarted.call('analyze', { caseId: h.caseId, previewId: loaded.report.preview.id, consent: true })).code, 'AI_PREVIEW_EXPIRED');
  assert.equal((await restarted.call('collect', { caseId: randomUUID(), mode: 'analysis', question: 'historical follow-up', contextRef: { historyId: stored.item.id } })).ok, true);
  assert.equal(h.calls.length, 1); assert.match((await restarted.call('reportText', { reportRef: { historyId: stored.item.id } })).text, /fixture summary/);
});

test('delete cancellation and owner disposal during confirmation never remove a saved report', async t => {
  let finish;
  const h = fixture(t, { confirmDelete: () => new Promise(resolve => { finish = resolve; }) });
  const p = await h.collect(), a = await h.analyze(p.preview), stored = await h.service.call('historySave', { caseId: h.caseId, turnId: a.turn.id, name: 'keep' });
  const cancelled = h.service.call('historyDelete', { id: stored.item.id }); await new Promise(resolve => setImmediate(resolve)); finish(false); assert.equal((await cancelled).cancelled, true);
  const pending = h.service.call('historyDelete', { id: stored.item.id }); await new Promise(resolve => setImmediate(resolve)); h.service.dispose(); finish(true);
  assert.equal((await pending).cancelled, true); assert.equal(h.deps.history.load(stored.item.id).name, 'keep');
});

test('paired comparison gets separate IDs and consent, supports real matched evidence, and forces unknown/mixed targets inconclusive', async t => {
  let output = analysis;
  const h = fixture(t, { client: async () => ({ ok: true, text: JSON.stringify(output) }) });
  const first = await h.collect({ deviceId: 'device-A', checks: ['device_info'], text: '' }), baseline = await h.analyze(first.preview);
  const after = await h.collect({ deviceId: 'device-A', checks: ['device_info'], text: '' });
  const paired = await h.service.call('comparisonPreview', { caseId: h.caseId, beforeRef: { caseId: h.caseId, turnId: baseline.turn.id }, afterRef: { caseId: h.caseId, previewId: after.preview.id } });
  assert.equal(paired.ok, true); assert.equal(paired.preview.comparison.comparable, true); assert.deepEqual(paired.preview.comparison.beforeIds, ['E1']); assert.deepEqual(paired.preview.comparison.afterIds, ['E2']);
  output = { ...analysis, verdict: 'improved', findings: [{ ...analysis.findings[0], evidenceIds: ['E1', 'E2'] }] };
  const compared = await h.analyze(paired.preview); assert.equal(compared.result.verdict, 'improved'); assert.equal(compared.turn.kind, 'comparison');
  const unknown = await h.collect({ text: 'unknown target' });
  const unsafe = await h.service.call('comparisonPreview', { caseId: h.caseId, beforeRef: { caseId: h.caseId, turnId: baseline.turn.id }, afterRef: { caseId: h.caseId, previewId: unknown.preview.id } });
  assert.equal(unsafe.preview.comparison.comparable, false); assert.ok(unsafe.preview.comparison.warnings.length);
  assert.equal((await h.analyze(unsafe.preview)).result.verdict, 'inconclusive');
});

test('task context and requirements are visible metadata, missing information and expiry are bounded, save never runs a task', async t => {
  let output = analysis;
  const h = fixture(t, { client: async args => { h.calls.push(args); return { ok: true, text: JSON.stringify(output) }; } });
  const p = await h.collect(), a = await h.analyze(p.preview);
  output = { name: 'regression draft', description: 'review only', steps: [{ type: 'screenshot', label: 'capture' }], missingInformation: ['fixture missing coordinates'] };
  const generated = await h.service.call('generateTask', { caseId: h.caseId, goal: 'test the selected finding', contextRef: { caseId: h.caseId, turnId: a.turn.id }, findingIndex: 0,
    requirements: { application: 'fixture app', preconditions: 'opened', target: 'fixture target', expectedResult: 'no fixture error' } });
  assert.equal(generated.ok, true); assert.equal(generated.draft.context.finding.title, 'fixture fact'); assert.equal(generated.draft.observationOnly, true);
  assert.ok(generated.draft.missingInformation.length >= 2); assert.ok(Date.parse(generated.draft.expiresAt) > 1000); assert.equal(h.saved.length, 0);
  assert.equal((await h.service.call('saveTask', { caseId: h.caseId, draftId: generated.draft.id })).ok, true); assert.equal(h.saved.length, 1);
  assert.match(h.saved[0].description, /no fixture error/); assert.deepEqual(Object.keys(h.saved[0]).sort(), ['description', 'name', 'steps']);
  output = { name: 'invented tap', description: '', steps: [{ type: 'tap', label: 'invented', x: 123, y: 456 }] };
  assert.equal((await h.service.call('generateTask', { caseId: h.caseId, goal: 'no interaction coordinates supplied' })).code, 'AI_TASK_INPUT');
});

test('unrelated Android version and duration numbers never authorize coordinates or key codes', async t => {
  let step = { type: 'tap', label: 'tap', x: 14, y: 30 };
  const h = fixture(t, { client: async () => ({ ok: true, text: JSON.stringify({ name: 'fixture', description: '', steps: [step] }) }) });
  const generate = goal => h.service.call('generateTask', { caseId: h.caseId, goal });
  assert.equal((await generate('Validate Android 14 for 30 seconds')).code, 'AI_TASK_INPUT');
  assert.equal((await generate('Tap (14, 30) on the screen')).ok, true);
  assert.equal((await generate('Tap x=14, y=30 on the screen')).ok, true);
  step = { type: 'keyevent', label: 'key', keyCode: 'HOME' };
  assert.equal((await generate('Repeat 3 times')).code, 'AI_TASK_INPUT');
  assert.equal((await generate('Press HOME')).ok, true);
});

test('different diagnostic check kinds do not become comparable merely because both use ADB', async t => {
  const h = fixture(t); const first = await h.collect({ deviceId: 'device-A', checks: ['device_info'], text: '' });
  const baseline = await h.analyze(first.preview);
  const after = await h.collect({ deviceId: 'device-A', checks: ['performance_snapshot'], text: '' });
  const compared = await h.service.call('comparisonPreview', { caseId: h.caseId, beforeRef: { caseId: h.caseId, turnId: baseline.turn.id }, afterRef: { caseId: h.caseId, previewId: after.preview.id } });
  assert.equal(compared.ok, true); assert.equal(compared.preview.comparison.comparable, false); assert.deepEqual(compared.preview.comparison.pairs, []);
});

test('a corrupt saved report can still be removed with explicit metadata confirmation', async t => {
  const confirmations = [];
  const h = fixture(t, { confirmDelete: async item => { confirmations.push(item); return true; } });
  const p = await h.collect(), a = await h.analyze(p.preview), saved = await h.service.call('historySave', { caseId: h.caseId, turnId: a.turn.id, name: 'corrupt fixture' });
  fs.writeFileSync(path.join(h.directory, `${saved.item.id}.json`), '{broken');
  assert.equal((await h.service.call('historyLoad', { id: saved.item.id })).code, 'AI_REPORT');
  assert.equal((await h.service.call('historyDelete', { id: saved.item.id })).ok, true);
  assert.equal(confirmations[0].name, 'corrupt fixture'); assert.equal(confirmations[0].result, undefined);
  assert.deepEqual((await h.service.call('historyList')).items, []);
});

test('long preconditions cannot hide acceptance criteria in the saved 500-character task description', async t => {
  const h = fixture(t, { client: async () => ({ ok: true, text: JSON.stringify({ name: 'fixture', description: 'x'.repeat(500), steps: [{ type: 'screenshot', label: 'capture' }] }) }) });
  const generated = await h.service.call('generateTask', { caseId: h.caseId, goal: 'capture evidence', requirements: { application: 'fixture app', preconditions: 'p'.repeat(1000), target: 'fixture target', expectedResult: 'EXPLICIT ACCEPTANCE' } });
  assert.equal(generated.ok, true); assert.ok(generated.draft.description.length <= 500); assert.match(generated.draft.description, /EXPLICIT ACCEPTANCE/);
  assert.equal(generated.draft.requirements.preconditions.length, 1000);
});

test('six completed turns remain bounded, expired draft cannot save, and context lifetime never restores an old preview', async t => {
  const h = fixture(t); const turns = [];
  for (let i = 0; i < 7; i++) { const p = await h.collect({ question: `fixture ${i}` }); turns.push((await h.analyze(p.preview)).turn); }
  assert.equal((await h.service.call('reportText', { reportRef: { caseId: h.caseId, turnId: turns[0].id } })).code, 'AI_REPORT');
  assert.equal((await h.service.call('reportText', { reportRef: { caseId: h.caseId, turnId: turns[1].id } })).ok, true);
  h.advance(16 * 60000);
  assert.equal((await h.service.call('reportText', { reportRef: { caseId: h.caseId, turnId: turns[6].id } })).code, 'AI_REPORT');
});
