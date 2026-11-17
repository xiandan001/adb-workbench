const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { createAiWorkspaceService } = require('../electron/lib/ai-workspace-service.cjs');
const { computeWorkspaceJob } = require('../electron/lib/ai-workspace-compute.cjs');
const answer = { summary: 'Observed only', findings: [{ title: 'Fact', detail: 'Sample', evidenceIds: ['E1'], citations: [{ evidenceId: 'E1', startLine: 1, endLine: 1 }] }], hypotheses: [], nextSteps: [], limitations: [] };
const fixture = extra => createAiWorkspaceService({ evidence: { collect: async () => ({ entries: [{ id: 'E1', source: 'text', label: 'Fixture', text: '[L1] sample', lineCount: 1, numbered: true, targetKey: null }], bytes: 100, truncated: false }) },
  membership: async () => ({ activated: true, scope: 'vip' }), client: async () => ({ ok: true, text: JSON.stringify(answer) }), ...extra });
test('collect reports full frozen bytes outside preview and existing analyze planner publishes a small summary before the original provider path', async t => {
  const events = []; let calls = 0, plans = 0;
  const service = fixture({ onMaterialBudget: event => events.push(event), processor: async (...args) => { if (args[0] === 'request-plan') plans++; return computeWorkspaceJob(...args); },
    client: async () => { calls++; assert.equal(events.length, 1); return { ok: true, text: JSON.stringify(answer) }; } });
  t.after(() => service.dispose()); const caseId = randomUUID();
  const collected = await service.call('collect', { caseId, mode: 'analysis', question: 'Check', text: 'sample' });
  assert.equal(collected.materialBudget.localBytes, Buffer.byteLength(JSON.stringify(collected.preview)));
  assert.equal(collected.materialBudget.limitBytes, 20971520); assert.equal(collected.materialBudget.complete, true); assert.equal(collected.preview.materialBudget, undefined);
  assert.equal(calls, 0); assert.equal(events.length, 0); assert.equal(plans, 0, 'Budget collection does not duplicate the model request planner');
  assert.equal((await service.call('analyze', { caseId, previewId: collected.preview.id, consent: true })).ok, true);
  assert.equal(calls, 1); assert.equal(plans, 1); assert.deepEqual(Object.keys(events[0]).sort(), ['caseId', 'previewId', 'sourceBytes', 'requestCount', 'initialBatchCount', 'needsSummary', 'estimated'].sort());
  assert.equal(events[0].caseId, caseId); assert.equal(events[0].previewId, collected.preview.id); assert.equal(events[0].requestCount, 1); assert.equal(events[0].initialBatchCount, 1); assert.equal(events[0].estimated, true);
});
test('a cancellation while the existing plan is pending cannot publish stale budget or send a model request', async t => {
  let release, entered; const waiting = new Promise(resolve => { entered = resolve; }), events = []; let calls = 0;
  const service = fixture({ onMaterialBudget: value => events.push(value), client: async () => { calls++; return { ok: false }; },
    processor: async (command, args, options) => { if (command === 'request-plan') { entered(); await new Promise(resolve => { release = resolve; }); } return computeWorkspaceJob(command, args, options); } });
  t.after(() => service.dispose()); const caseId = randomUUID(), collected = await service.call('collect', { caseId, mode: 'analysis', question: 'Check', text: 'sample' });
  const pending = service.call('analyze', { caseId, previewId: collected.preview.id, consent: true }); await waiting;
  await service.call('cancel', { caseId }); release(); assert.equal((await pending).cancelled, true); assert.equal(calls, 0); assert.deepEqual(events, []);
});
