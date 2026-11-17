const test = require('node:test');
const assert = require('node:assert/strict');
const { runLegacyRequestPlan } = require('../electron/lib/ai-legacy-request-plan.cjs');
const { buildMarkdownPlan, buildRequestPlan, requestRecord } = require('../electron/lib/ai-workspace-request-plan.cjs');
const model = require('../electron/lib/ai-model-request-limits.cjs');

test('legacy large input keeps every numbered atom and later batches wait independently', async () => {
  const lines = Array.from({ length: 120 }, (_, index) => `[L${index + 1}] ${'a '.repeat(75000)}`);
  const batches = [], sent = [];
  const output = await runLegacyRequestPlan({ lines, prompt: 'Inspect', reducePrompt: 'Combine', intro: 'All frozen records', maxLines: 2000,
    plan: async args => buildMarkdownPlan(args),
    withBatch: async (_title, action) => { const before = sent.length; const result = await action(); batches.push(sent.length - before); return result; },
    send: async request => { sent.push(request); return { ok: true, summary: 'Observed E references only' }; } });
  assert.ok(batches.length > 1);
  assert.ok(batches.every(count => count <= 16));
  for (const line of lines) assert.equal(sent.filter(request => request.userContent.includes(line)).length, 1);
  assert.match(output.userContent, /lineEnd.*120/);
  assert.equal(output.maxTokens, 3000);
});

test('cancelling a later legacy preview cannot start that batch or return a complete summary', async () => {
  let batches = 0, sent = 0;
  await assert.rejects(runLegacyRequestPlan({ lines: ['fixture'], prompt: 'Inspect', reducePrompt: 'Combine',
    plan: async () => ({ requests: Array.from({ length: 17 }, () => ({ systemPrompt: 'Inspect', userContent: 'raw', bytes: 100, mapping: [] })) }),
    withBatch: async (_title, action) => { if (++batches === 2) throw Object.assign(new Error('Explicit cancellation'), { code: 'AI_SEND_CANCELLED' }); return action(); },
    send: async () => { sent++; return { ok: true, summary: 'Partial only' }; } }), error => error.code === 'AI_SEND_CANCELLED');
  assert.equal(sent, 16);
  assert.equal(batches, 2);
});

test('model estimate includes output and message reserve, and complete plans never exceed sixty-four atoms', () => {
  assert.equal(model.inputBytesPerEstimatedToken, 1);
  assert.equal(requestRecord('Instructions', 'x'.repeat(model.contextTokens), 3000, []), null);
  const evidence = [{ id: 'E1', numbered: true, text: Array.from({ length: 65 }, (_, index) => `[L${index + 1}] ${'x'.repeat(300000)}`).join('\n') }];
  assert.throws(() => buildRequestPlan({ prompt: 'Instructions', payload: { evidence } }), error => error.code === 'AI_CONTEXT_PLAN_LIMIT');
});
