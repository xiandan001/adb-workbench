const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createAiWorkspaceService } = require('../electron/lib/ai-workspace-service.cjs');
const { computeWorkspaceJob } = require('../electron/lib/ai-workspace-compute.cjs');
const { createTaskTargetRegistry, materializeAiSteps } = require('../electron/lib/task-ai-targets.cjs');
const analysis = { summary: 'synthetic summary', findings: [{ title: 'synthetic observation', detail: 'synthetic detail', evidenceIds: ['E1'] }], hypotheses: [], nextSteps: [], limitations: [] };

test('handoff collection resolves only frozen server data and never refreshes a device or calls AI automatically', async () => {
  const id = randomUUID(), calls = [];
  const frozen = await computeWorkspaceJob('freeze', { sources: [{ kind: 'text', label: 'selected fixture', target: 'claimed device', text: 'password=synthetic\nselected evidence', provenance: { trust: 'renderer-view', origin: 'log-view' } }], now: 1 });
  const handoff = { id, title: 'fixture', origin: 'log-view', deviceId: 'claimed device', provenance: { trust: 'renderer-view', origin: 'log-view' }, ...frozen };
  const service = createAiWorkspaceService({ resolveHandoff: async value => { assert.equal(value, id); return structuredClone(handoff); },
    membership: async () => ({ activated: true, scope: 'vip' }), evidence: { collect: () => assert.fail('must not refresh a live source') },
    client: async args => { calls.push(args); return { ok: true, text: JSON.stringify(analysis) }; } });
  const caseId = randomUUID(), collected = await service.call('collect', { caseId, mode: 'analysis', handoffId: id, question: 'review the selected fixture' });
  assert.equal(collected.ok, true); assert.equal(calls.length, 0); assert.notEqual(collected.preview.id, id);
  assert.equal(collected.preview.targetFingerprint, null); assert.equal(collected.preview.entries[0].targetKey, null);
  assert.ok(!collected.preview.entries[0].text.includes('password=synthetic'));
  assert.equal((await service.call('analyze', { caseId, previewId: collected.preview.id })).ok, false); assert.equal(calls.length, 0);
  assert.equal((await service.call('analyze', { caseId, previewId: collected.preview.id, consent: true })).ok, true);
  assert.deepEqual(JSON.parse(calls[0].userContent).evidence, collected.preview.entries);
  service.dispose();
});

test('AI target IDs are resolved from explicit owner-bound selections and materialized only when saving', async () => {
  const registry = createTaskTargetRegistry(), owner = { id: 50 };
  const snapshot = registry.remember({ nodes: [{ text: 'Settings', resourceId: 'com.example:id/settings', className: 'android.widget.TextView', label: 'Settings' }] }, 'fixture-device', owner);
  const selected = registry.select({ snapshotId: snapshot.snapshotId, nodeId: snapshot.nodes[0].targetNodeId }, owner);
  const calls = [], saved = [];
  let model = { name: 'fixture target task', description: 'review first', steps: [{ type: 'tap', label: 'tap selected Settings', targetId: 'T1' }] };
  const service = createAiWorkspaceService({ resolveTaskTargets: tokens => registry.resolve(tokens, owner), membership: async () => ({ activated: true, scope: 'vip' }),
    client: async args => { calls.push(args); return { ok: true, text: JSON.stringify(model) }; }, confirmSave: async () => true,
    saveTask: async (draft, metadata) => { saved.push({ draft, metadata }); return { id: randomUUID(), steps: materializeAiSteps(draft.steps, metadata.targets) }; } });
  const caseId = randomUUID();
  const generated = await service.call('generateTask', { caseId, goal: 'tap the explicitly selected control', targetSelection: { tokens: [selected.token] } });
  assert.equal(generated.ok, true); assert.equal(saved.length, 0); assert.equal(generated.draft.steps[0].targetId, 'T1');
  const sent = JSON.parse(calls[0].userContent); assert.deepEqual(Object.keys(sent.targets[0]).sort(), ['id', 'label']);
  const result = await service.call('saveTask', { caseId, draftId: generated.draft.id });
  assert.equal(result.ok, true); assert.equal(result.script.steps[0].requireUnique, true); assert.equal(result.script.steps[0].resourceId, 'com.example:id/settings');
  assert.equal(Object.hasOwn(result.script.steps[0], 'x'), false);
  model = { ...model, steps: [{ type: 'tap', label: 'invented target', targetId: 'T999' }] };
  assert.equal((await service.call('generateTask', { caseId, goal: 'fixture', targetSelection: { tokens: [selected.token] } })).ok, false);
  const before = calls.length;
  assert.equal((await service.call('generateTask', { caseId, goal: 'fixture', targetSelection: { tokens: [randomUUID()] } })).ok, false);
  assert.equal(calls.length, before); service.dispose();
});

test('casebook context retains visible human review but never restores old consent or changes verification automatically', async () => {
  const id = randomUUID(), frozen = await computeWorkspaceJob('freeze', { sources: [{ kind: 'text', label: 'fixture', text: 'case evidence' }], now: 1 });
  const report = { id, name: 'synthetic case', preview: { id: randomUUID(), question: 'prior question', ...frozen }, result: analysis,
    review: { status: 'rejected', rootCause: 'actual cause', solution: 'actual fix', verification: 'human verification', packageName: 'com.example', version: '1', tags: [] } };
  const calls = [], service = createAiWorkspaceService({ casebook: { load: async caseId => { assert.equal(caseId, id); return structuredClone(report); } },
    membership: async () => ({ activated: true, scope: 'vip' }), client: async args => { calls.push(args); return { ok: true, text: JSON.stringify(analysis) }; } });
  const loaded = await service.call('casebookLoad', { id }); assert.equal(loaded.report.review.status, 'rejected'); assert.equal(calls.length, 0);
  const caseId = randomUUID(), next = await service.call('collect', { caseId, mode: 'analysis', question: 'new question', contextRef: { casebookId: id } });
  assert.equal(next.ok, true); assert.notEqual(next.preview.id, report.preview.id); assert.equal(next.preview.context.caseReview.status, 'rejected'); assert.equal(calls.length, 0);
  await service.call('analyze', { caseId, previewId: next.preview.id, consent: true });
  assert.deepEqual(JSON.parse(calls[0].userContent).context, next.preview.context); assert.equal(report.review.status, 'rejected'); service.dispose();
});
