const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { runWorkspaceJob, cleanupWorkspaceProcessor } = require('../electron/lib/ai-workspace-processor.cjs');

test('real worker plans a near-20MiB frozen carrier while the main heartbeat runs, and cancellation permits a later small job', async t => {
  t.after(cleanupWorkspaceProcessor);
  const text = Array.from({ length: 1000 }, (_, index) => `[L${index + 1}] ${'x'.repeat(19500)}`).join('\n');
  const args = { prompt: 'Inspect all mapped observations', payload: { question: 'No silent omissions', evidence: [{ id: 'E1', text, numbered: true }] } };
  let beats = 0, previous = performance.now(), maxGap = 0;
  const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - previous); previous = now; beats++; }, 5);
  const start = performance.now();
  try {
    const plan = await runWorkspaceJob('request-plan', args);
    assert.ok(plan.requests.length > 16 && plan.requests.length <= 64);
    assert.equal(plan.requests.flatMap(request => JSON.parse(request.userContent).evidence.flatMap(entry => entry.text.split('\n'))).length, 1000);
    assert.ok(beats > 3);
    t.diagnostic(JSON.stringify({ sourceBytes: plan.sourceBytes, requests: plan.requests.length, durationMs: performance.now() - start, heartbeatCount: beats, maxHeartbeatGapMs: maxGap }));
    const controller = new AbortController(), pending = runWorkspaceJob('request-plan', args, { signal: controller.signal });
    setTimeout(() => controller.abort(), 15);
    await assert.rejects(pending, error => error.code === 'CANCELLED');
    const small = await runWorkspaceJob('request-plan', { prompt: 'Inspect', payload: { question: 'small', evidence: [{ id: 'E1', text: '[L1] exact' }] } });
    assert.equal(small.kind, 'single');
  } finally { clearInterval(timer); }
});
