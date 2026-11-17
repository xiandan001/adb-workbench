const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createAiWorkspaceService } = require('../electron/lib/ai-workspace-service.cjs');
const { computeWorkspaceJob } = require('../electron/lib/ai-workspace-compute.cjs');
const { buildRequestPlan } = require('../electron/lib/ai-workspace-request-plan.cjs');
const result = { summary: 'All requested observations reviewed', findings: [], hypotheses: [], nextSteps: [], limitations: [] };

function fixture({ cancelBatch, mappedCitation = false, sixtyFourAtoms = false } = {}) {
  const batches = [], singles = [];
  let service;
  const processor = async (command, args) => {
    if (command === 'bundle') return { entries: args.entries, bytes: Buffer.byteLength(JSON.stringify(args.entries)), truncated: false };
    if (command === 'freeze-preview') return { preview: structuredClone(args.value), bytes: Buffer.byteLength(JSON.stringify(args.value)) };
    if (command === 'fingerprints') return args.entries.map(entry => entry.id);
    if (command === 'request-plan') return buildRequestPlan(args);
    return computeWorkspaceJob(command, args);
  };
  service = createAiWorkspaceService({ processor,
    client: async args => { singles.push(args); return { ok: true, text: JSON.stringify(result), usage: null }; },
    batchClient: async (requests, { signal }) => {
      batches.push(requests);
      if (cancelBatch === batches.length) return requests.map(() => ({ ok: false, code: 'cancelled', error: 'Cancelled explicitly' }));
      assert.equal(signal.aborted, false);
      return requests.map(request => {
        const invalid = mappedCitation && request.mapping[0]?.lineStart === 200;
        if (invalid) {
          assert.equal(request.mapping[0].lineEnd, 225);
          const sent = JSON.parse(request.userContent).evidence[0].text;
          assert.match(sent, /^\[L200\]/); assert.ok(!sent.includes('[L1]'));
        }
        return { ok: true, text: JSON.stringify(invalid ? { ...result, findings: [{ title: 'Unseen', detail: 'Must fail', evidenceIds: ['E1'], citations: [{ evidenceId: 'E1', startLine: 1, endLine: 1 }] }] } : result),
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      });
    }, membership: async () => ({ activated: true, scope: 'vip' }),
    evidence: { list: () => [], collect: async () => ({ entries: [{ id: 'E1', text: Array.from({ length: sixtyFourAtoms ? 64 : 1000 }, (_, index) => sixtyFourAtoms
      ? `[L${index + 1}] ${'x'.repeat(300000)}` : mappedCitation ? `[L${index + 1}] ${'x'.repeat(index < 199 ? 2500 : 19700)}` : `[L${index + 1}] ${'x'.repeat(15000)}${'\\'.repeat(2000)}`).join('\n'), numbered: true, lineCount: sixtyFourAtoms ? 64 : 1000 }] }) },
  });
  return { service, batches, singles };
}

test('large workspace input uses later batches and a distinct reduce request before committing a complete result', async () => {
  const f = fixture();
  try {
    const caseId = randomUUID(), prepared = await f.service.call('collect', { caseId, mode: 'analysis', question: 'Inspect all records', text: 'source' });
    assert.equal(prepared.ok, true);
    assert.equal(f.batches.length, 0);
    const answer = await f.service.call('analyze', { caseId, previewId: prepared.preview.id, consent: true });
    assert.equal(answer.ok, true, answer.error);
    assert.equal(f.singles.length, 0);
    assert.ok(f.batches.length >= 3, 'Map batch one, later map batch and separate reduce batch');
    assert.ok(f.batches.every(batch => batch.length <= 16));
    const maps = f.batches.flat().filter(request => JSON.parse(request.userContent).evidence);
    assert.equal(maps.flatMap(request => JSON.parse(request.userContent).evidence.flatMap(entry => entry.text.split('\n'))).length, 1000);
    assert.ok(JSON.parse(f.batches.at(-1)[0].userContent).partialResults.length > 1);
  } finally { f.service.dispose(); }
});

test('cancelled first batch cannot start a later batch or return a partial map output as a completed turn', async () => {
  const f = fixture({ cancelBatch: 1 });
  try {
    const caseId = randomUUID(), prepared = await f.service.call('collect', { caseId, mode: 'analysis', question: 'Inspect all records', text: 'source' });
    const answer = await f.service.call('analyze', { caseId, previewId: prepared.preview.id, consent: true });
    assert.equal(answer.ok, false);
    assert.equal(answer.cancelled, true);
    assert.equal(f.batches.length, 1);
    assert.equal(answer.turn, undefined);
  } finally { f.service.dispose(); }
});

test('actual service rejects a map citing full-preview L1 when its exact sent frozen window was E1 L200 through L225', async () => {
  const f = fixture({ mappedCitation: true });
  try {
    const caseId = randomUUID(), prepared = await f.service.call('collect', { caseId, mode: 'analysis', question: 'Inspect all records', text: 'source' });
    assert.equal(prepared.ok, true, prepared.error);
    const answer = await f.service.call('analyze', { caseId, previewId: prepared.preview.id, consent: true });
    assert.equal(answer.ok, false);
    assert.equal(answer.code, 'AI_CONTEXT_REFERENCE');
    assert.equal(answer.turn, undefined);
    assert.equal(f.batches.length, 1, 'No later batch or reduce can follow invalid mapped evidence');
    assert.ok(f.batches[0].some(request => request.mapping[0]?.lineStart === 200 && request.mapping[0]?.lineEnd === 225));
  } finally { f.service.dispose(); }
});

test('sixty-four complete map atoms reserve the required final-summary slot before any provider batch', async () => {
  const f = fixture({ sixtyFourAtoms: true });
  try {
    const caseId = randomUUID(), prepared = await f.service.call('collect', { caseId, mode: 'analysis', question: 'Inspect all atoms', text: 'source' });
    assert.equal(prepared.ok, true, prepared.error);
    const answer = await f.service.call('analyze', { caseId, previewId: prepared.preview.id, consent: true });
    assert.equal(answer.ok, false);
    assert.equal(answer.code, 'AI_CONTEXT_PLAN_LIMIT');
    assert.equal(f.batches.length, 0, 'A known impossible complete plan must fail before paid requests');
    assert.equal(answer.turn, undefined);
  } finally { f.service.dispose(); }
});
