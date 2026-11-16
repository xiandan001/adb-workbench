const test = require('node:test'), assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { EventEmitter } = require('node:events');
const { createDiagnosticMatcher } = require('../electron/lib/log-diagnostic-matcher.cjs');
const rule = (id, pattern) => ({ id, type: id, label: id, severity: 'error', pattern, flags: '', keywords: [], enabled: true });

test('real catastrophic regex is terminated without blocking main heartbeat or retrying that rule automatically', async t => {
  const notices = [], matcher = createDiagnosticMatcher({ deadlineMs: 100, onIncomplete: value => notices.push(value) });
  matcher.configure([rule('bad', '^(a+)+$'), rule('good', 'ok')]);
  let beats = 0; const timer = setInterval(() => beats++, 5), before = performance.now();
  try {
    await assert.rejects(matcher.match(['a'.repeat(10000) + '!'], { source: 'realtime' }), error => error.code === 'DIAGNOSTIC_TIMEOUT');
    assert.ok(beats >= 3); assert.ok(performance.now() - before < 5000); assert.equal(notices[0].ruleId, 'bad');
    const again = await matcher.match(['ok'], { source: 'realtime' });
    assert.equal(again.incomplete, true); assert.equal(again.matches[0].ruleId, 'good');
    assert.equal(notices.filter(value => value.reason === 'timeout').length, 1);
    matcher.configure([rule('bad', '^safe$'), rule('good', 'ok')]);
    assert.equal((await matcher.match(['safe'])).incomplete, false);
    t.diagnostic(JSON.stringify({ elapsedMs: performance.now() - before, heartbeatCount: beats, timedOutRule: notices[0].ruleId }));
  } finally { clearInterval(timer); matcher.dispose(); }
});
test('diagnostic queue and byte limits reject explicitly and cancellation fences every old reply', async () => {
  const matcher = createDiagnosticMatcher({ maxJobs: 2, maxPendingBytes: 32, deadlineMs: 500 });
  matcher.configure([rule('good', '^ok$')]);
  const pending = matcher.match(['a'.repeat(20)]), queued = matcher.match(['small']);
  await assert.rejects(matcher.match(['overflow']), error => error.code === 'DIAGNOSTIC_QUEUE_LIMIT');
  matcher.cancel();
  await assert.rejects(pending, error => error.code === 'DIAGNOSTIC_CANCELLED');
  await assert.rejects(queued, error => error.code === 'DIAGNOSTIC_CANCELLED');
  assert.equal((await matcher.match(['ok'])).matches[0].ruleId, 'good'); matcher.dispose();
});
test('worker preserves rule ordering, independent g regex state, and original row indices', async () => {
  const matcher = createDiagnosticMatcher(); matcher.configure([rule('first', 'same'), { ...rule('second', 'same|other'), flags: 'g' }]);
  try {
    const result = await matcher.match(['same', 'other', 'other']);
    assert.deepEqual(result.matches.map(item => [item.index, item.ruleId]), [[0, 'first'], [1, 'second'], [2, 'second']]);
    assert.equal(result.incomplete, false);
  } finally { matcher.dispose(); }
});
test('late replies from a cancelled worker cannot resolve a new source generation', async () => {
  const workers = [];
  class FakeWorker extends EventEmitter {
    constructor() { super(); this.messages = []; workers.push(this); }
    postMessage(value) { this.messages.push(value); }
    terminate() { return Promise.resolve(); }
  }
  const matcher = createDiagnosticMatcher({ WorkerClass: FakeWorker }); matcher.configure([rule('one', 'ok')]);
  const old = matcher.match(['old']); workers[0].emit('message', { type: 'ready' }); const oldId = workers[0].messages[0].jobId;
  matcher.cancel(); await assert.rejects(old, error => error.code === 'DIAGNOSTIC_CANCELLED');
  let resolved = false; const current = matcher.match(['new']).then(value => { resolved = true; return value; });
  workers[1].emit('message', { type: 'ready' }); const newId = workers[1].messages[0].jobId;
  workers[0].emit('message', { type: 'result', jobId: oldId, matches: [{ ruleId: 'old', index: 0 }] }); await Promise.resolve(); assert.equal(resolved, false);
  workers[1].emit('message', { type: 'result', jobId: newId, matches: [{ ruleId: 'new', index: 0 }] }); assert.equal((await current).matches[0].ruleId, 'new'); matcher.dispose();
});
