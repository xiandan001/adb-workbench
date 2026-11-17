import test from 'node:test';
import assert from 'node:assert/strict';
import { measureDraftBudget, createMaterialBudgetQueue, validateMaterialPlan } from '../src/shared/aiMaterialBudget.js';

const input = extra => ({ requestId: 1, caseId: 'case', revision: 2, text: '中文😀"\\', question: 'Question', unknownSources: 2, ...extra });
test('known material includes JSON source metadata and Unicode escaping, while uncollected sources stay unknown', () => {
  const value = input(), summary = measureDraftBudget(value);
  assert.equal(summary.minimumBytes, new TextEncoder().encode(JSON.stringify([{ kind: 'text', text: value.text }])).length);
  assert.equal(summary.complete, false); assert.equal(summary.unknownSources, 2); assert.equal(summary.status, 'ready');
  const text = 'x'.repeat(20 * 1024 * 1024), original = text;
  const large = measureDraftBudget(input({ text })); assert.equal(large.status, 'over-limit'); assert.ok(large.minimumBytes > text.length);
  assert.equal(text, original); assert.equal(measureDraftBudget(input({ text: '\0'.repeat(4000000) })).status, 'over-limit');
});

test('editing coalesces into one worker and a stale answer cannot replace a later case', () => {
  let timer, created = 0; const workers = [], seen = [];
  const queue = createMaterialBudgetQueue({ setTimer: callback => (timer = callback, 1), clearTimer() { timer = null; }, onSummary: value => seen.push(value),
    createWorker() { created++; const worker = { terminated: false, postMessage(value) { this.input = value; }, terminate() { this.terminated = true; } }; workers.push(worker); return worker; } });
  for (let revision = 0; revision < 100; revision++) queue.schedule(input({ revision }));
  assert.equal(created, 0); timer(); assert.equal(created, 1); const stale = workers[0].onmessage;
  queue.schedule(input({ caseId: 'next', revision: 100 })); assert.equal(workers[0].terminated, true); timer();
  stale({ data: measureDraftBudget(workers[0].input) }); assert.equal(seen.length, 0);
  workers[1].onmessage({ data: measureDraftBudget(workers[1].input) }); assert.equal(seen[0].caseId, 'next');
  queue.dispose(); assert.equal(workers[1].terminated, true); queue.schedule(input()); assert.equal(timer, null);
});

test('planner metadata is small, bounded and cannot be mistaken for provider cost or send consent', () => {
  const value = { caseId: 'case', previewId: 'preview', sourceBytes: 1000, requestCount: 33, initialBatchCount: 3, needsSummary: true, estimated: true };
  assert.deepEqual(validateMaterialPlan(value), value);
  for (const patch of [{ requestCount: 65 }, { initialBatchCount: 2 }, { estimated: false }, { body: 'secret' }]) assert.equal(validateMaterialPlan({ ...value, ...patch }), null);
});

test('slow metadata edits reuse the measured same-case text without reposting 20 MiB, while changes and failures invalidate it', t => {
  let timer; const workers = [], text = 'x'.repeat(20 * 1024 * 1024);
  const queue = createMaterialBudgetQueue({ setTimer: callback => (timer = callback, 1), clearTimer() { timer = null; }, onSummary() {},
    createWorker() { const worker = { postMessage(value) { this.input = value; }, terminate() {} }; workers.push(worker); return worker; } });
  t.after(() => queue.dispose());
  queue.schedule(input({ text })); timer(); const first = measureDraftBudget(workers[0].input); workers[0].onmessage({ data: first });
  queue.schedule(input({ text, revision: 3, question: 'Changed question' })); timer();
  assert.equal(Object.hasOwn(workers[1].input, 'text'), false); assert.equal(workers[1].input.knownTextBytes, first.textBytes);
  workers[1].onmessage({ data: measureDraftBudget(workers[1].input) });
  queue.schedule(input({ text, revision: 4, unknownSources: 5 })); timer(); assert.equal(Object.hasOwn(workers[2].input, 'text'), false);
  workers[2].onerror(); queue.schedule(input({ text, revision: 5 })); timer(); assert.equal(workers[3].input.text, text);
  workers[3].onmessage({ data: measureDraftBudget(workers[3].input) });
  queue.schedule(input({ text, caseId: 'other-case', revision: 6 })); timer(); assert.equal(workers[4].input.text, text);
  workers[4].onmessage({ data: measureDraftBudget(workers[4].input) });
  queue.schedule(input({ text: 'changed body', caseId: 'other-case', revision: 7 })); timer(); assert.equal(workers[5].input.text, 'changed body'); queue.dispose();
});
