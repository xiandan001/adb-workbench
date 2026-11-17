const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRequestPlan, buildMarkdownPlan, validatePlannedCitations } = require('../electron/lib/ai-workspace-request-plan.cjs');
const { LIMITS } = require('../electron/lib/ai-outbound-policy.cjs');
const { analysisMessages } = require('../electron/lib/analysis-language.cjs');

test('small workspace input is one unchanged complete JSON request', () => {
  const payload = { question: 'Inspect', evidence: [{ id: 'E1', text: '[L1] safe', numbered: true }] };
  const plan = buildRequestPlan({ prompt: 'Instructions', payload });
  assert.equal(plan.kind, 'single');
  assert.equal(plan.requests[0].userContent, JSON.stringify(payload));
});

test('large Unicode and JSON-escaped evidence is fully mapped into bounded requests without losing lines', () => {
  const rows = Array.from({ length: 48 }, (_, index) => `[L${index + 1}] ${'中\\\"'.repeat(10000)} ${index}`);
  const plan = buildRequestPlan({ prompt: 'Inspect', payload: { question: 'All rows', evidence: [{ id: 'E1', text: rows.join('\n'), numbered: true, lineCount: rows.length }] } });
  assert.equal(plan.kind, 'map');
  const actual = [];
  for (const request of plan.requests) {
    const body = JSON.stringify({ model: 'm'.repeat(128), messages: analysisMessages(request.systemPrompt, [], request.userContent), stream: false, temperature: 0.2, max_tokens: request.maxTokens });
    assert.ok(Buffer.byteLength(body) <= LIMITS.requestBytes);
    actual.push(...JSON.parse(request.userContent).evidence.flatMap(entry => entry.text.split('\n')));
    assert.equal(request.mapping[0].evidenceId, 'E1');
  }
  assert.deepEqual(actual, rows);
  assert.equal(plan.requests[0].mapping[0].lineStart, 1);
  assert.equal(plan.requests.at(-1).mapping.at(-1).lineEnd, 48);
  const later = JSON.parse(plan.requests[1].userContent).evidence[0];
  assert.equal(later.lineCount, 48);
  assert.ok(later.chunkRange.startLine > 1);
});

test('map citations must belong to the exact frozen request window, not merely another valid line of the same source', () => {
  const result = { findings: [{ evidenceIds: ['E1'], citations: [{ evidenceId: 'E1', startLine: 200, endLine: 220 }] }] };
  validatePlannedCitations(result, [{ evidenceId: 'E1', lineStart: 200, lineEnd: 210 }, { evidenceId: 'E1', lineStart: 211, lineEnd: 220 }]);
  assert.throws(() => validatePlannedCitations(result, [{ evidenceId: 'E1', lineStart: 1, lineEnd: 30 }]), error => error.code === 'AI_CONTEXT_REFERENCE');
  assert.throws(() => validatePlannedCitations(result, [{ evidenceId: 'E2', lineStart: 200, lineEnd: 220 }]), error => error.code === 'AI_CONTEXT_REFERENCE');
});

test('an indivisible oversized binary frame or Markdown atom is rejected, never silently clipped', () => {
  const text = '[L1] HEX: ' + 'FE '.repeat(600000);
  assert.throws(() => buildRequestPlan({ prompt: 'Inspect', payload: { evidence: [{ id: 'E1', text }] } }), error => error.code === 'AI_CONTEXT_ATOM_LIMIT');
  assert.throws(() => buildMarkdownPlan({ prompt: 'Inspect', lines: [text] }), error => error.code === 'AI_CONTEXT_ATOM_LIMIT');
});

test('reduction groups complete mapped results and retains original references', () => {
  const partialResults = Array.from({ length: 24 }, (_, index) => ({ mapping: [{ evidenceId: 'E1', lineStart: index + 1, lineEnd: index + 1 }], result: { summary: 'x'.repeat(60000) } }));
  const plan = buildRequestPlan({ prompt: 'Reduce', phase: 'reduce', payload: { question: 'Merge', partialResults } });
  assert.ok(plan.requests.length > 1);
  assert.deepEqual(plan.requests.flatMap(request => JSON.parse(request.userContent).partialResults), partialResults);
});
