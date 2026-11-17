const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { parse } = require('@babel/parser');
const source = fs.readFileSync(require.resolve('../electron/lib/adb.cjs'), 'utf8');
const ast = parse(source, { sourceType: 'script' });
const functions = new Map(ast.program.body.filter(node => node.type === 'FunctionDeclaration').map(node => [node.id.name, source.slice(node.start, node.end)]));
const flush = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
function fixture() {
  const processes = [], timers = [], logs = [], observed = [], stopped = [], cache = new Map(); let clock = 0;
  const spawn = () => { const proc = new EventEmitter(); proc.pid = 100 + processes.length; proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.unref = () => { proc.unreferenced = true; }; for (const pipe of [proc.stdout, proc.stderr]) pipe.resume = pipe.unref = () => {}; processes.push(proc); return proc; };
  const scope = { Buffer, Promise, Date: { now: () => clock }, console: { log() {}, warn() {}, error() {} }, SCRCPY_READY_GRACE_MS: 800, SCRCPY_STARTUP_WATCH_MS: 10000, SCRCPY_AUDIO_PROBE_MS: 7000, scrcpyAudioModeCache: cache, scrcpyMirrorSequence: 0, spawn,
    createMirrorDiagnostics(options) { const monitor = require('../electron/lib/mirror-diagnostics.cjs').createMirrorDiagnostics({ ...options, record: row => logs.push(row), now: () => clock }); return { ...monitor, event: (name, data) => monitor.event(name, data && structuredClone(data)), finish: (name, data) => monitor.finish(name, data && structuredClone(data)) }; },
    applicationLog: { record: row => logs.push(row), observeToolProcess(proc, options) { observed.push({ proc, options }); return () => {}; } },
    buildScrcpySpawn: (_file, args) => ({ command: 'SYNTHETIC', args, options: {} }), stopScrcpyStartupProcess: async proc => { stopped.push(proc); proc.emit('close', 0, null); },
    tr: (message, args = {}) => message.replace(/\{(\d+)\}/g, (all, key) => args[key] ?? all),
    setTimeout(callback, ms) { const timer = { callback, ms, cleared: false }; timers.push(timer); return timer; }, clearTimeout(timer) { if (timer) timer.cleared = true; } };
  vm.createContext(scope); vm.runInContext(['isScrcpyAudioStartupError', 'isScrcpyVideoReady', 'probeScrcpyAudio', 'startScrcpyProcess'].filter(name => functions.has(name)).map(name => functions.get(name)).join('\n'), scope);
  return { processes, logs, observed, stopped, cache, start(options = { retryWithoutAudio: false }) { const promise = scope.startScrcpyProcess('PRIVATE-DEVICE', 'PRIVATE-PATH', [], options); const result = { state: 'pending' }; promise.then(value => Object.assign(result, { state: 'resolved', value }), error => Object.assign(result, { state: 'rejected', error })); return { promise, result }; },
    probe: () => scope.probeScrcpyAudio('PRIVATE-DEVICE', 'PRIVATE-PATH', [], { mirrorNumber: 9 }), fire(ms) { const timer = timers.find(item => item.ms === ms && !item.cleared); assert.ok(timer, 'Missing active timer ' + ms); timer.cleared = true; clock += ms; timer.callback(); }, timers };
}

test('actual scrcpy startup rejects every early exit including zero and signal-only, without waiting for its watch timer', async () => {
  for (const [code, signal] of [[0, null], [1, null], [null, 'SIGTERM']]) { const h = fixture(), start = h.start(); h.processes[0].emit('close', code, signal); await flush(); assert.equal(start.result.state, 'rejected'); assert.ok(h.timers.filter(item => item.ms === 10000).every(item => item.cleared)); }
});
test('actual successful readiness retains full lifetime observers and observes the later exit exactly once', async () => {
  const h = fixture(), start = h.start(), proc = h.processes[0]; proc.stdout.emit('data', Buffer.from('scrcpy 5.0.1 <https://private>\nINFO: Texture: 640x360\n')); h.fire(800); await flush(); assert.equal(start.result.state, 'resolved'); assert.equal(start.result.value.ready, true);
  assert.equal(proc.listenerCount('close'), 1); assert.ok(proc.listenerCount('error') >= 1); assert.ok(proc.stderr.listenerCount('data') >= 1); proc.emit('close', 1, null); proc.emit('close', 1, null);
  assert.equal(h.logs.filter(row => row.event === 'exit').length, 1); assert.equal(h.logs.find(row => row.event === 'exit').exitCode, 1); assert.equal(proc.listenerCount('close'), 0); assert.equal(h.observed.length, 1); assert.equal(h.observed[0].options.stdout, 'text'); assert.equal(h.observed[0].options.stderr, 'text'); assert.equal(h.stopped.length, 0);
});
test('close during readiness grace is failure and live timeout is explicitly unconfirmed, never a fabricated frame', async () => {
  const early = fixture(), stopped = early.start(); early.processes[0].stdout.emit('data', Buffer.from('INFO: Texture: 640x360\n')); early.processes[0].emit('close', 0, null); await flush(); assert.equal(stopped.result.state, 'rejected'); assert.ok(early.timers.every(item => item.cleared));
  const h = fixture(), start = h.start(); h.fire(10000); await flush(); assert.equal(start.result.state, 'resolved'); assert.equal(start.result.value.ready, false); assert.match(start.result.value.message, /尚未确认画面/); assert.equal(h.logs.some(row => row.event === 'ready'), false); assert.ok(h.logs.some(row => row.event === 'startup-unconfirmed')); assert.equal(h.stopped.length, 0);
});
test('late process errors are consumed and classified without altering an already resolved result', async () => {
  const h = fixture(), start = h.start(); h.processes[0].stdout.emit('data', Buffer.from('INFO: Texture: 640x360\n')); h.fire(800); await flush();
  assert.doesNotThrow(() => h.processes[0].emit('error', Object.assign(Error('SECRET C:/private'), { code: 'EIO' }))); await flush(); assert.equal(start.result.state, 'resolved'); assert.equal(h.logs.filter(row => row.event === 'failure').length, 1); assert.doesNotMatch(JSON.stringify(h.logs), /SECRET|private|PRIVATE/); h.processes[0].emit('close', 1, null);
});
test('the existing audio retry stays single-flight and the old owned process cannot settle or log readiness for the new one', async () => {
  const h = fixture(), start = h.start({ retryWithoutAudio: true, mirrorNumber: 4 }), first = h.processes[0]; first.stderr.emit('data', Buffer.from('Cannot create AudioRecord\n')); await flush(); assert.equal(h.stopped.length, 1); assert.equal(h.processes.length, 2); assert.equal(h.cache.get('PRIVATE-DEVICE'), 'no-audio');
  first.stdout.emit('data', Buffer.from('INFO: Texture: 999x999\n')); const next = h.processes[1]; next.stdout.emit('data', Buffer.from('INFO: Texture: 640x360\n')); h.fire(800); await flush(); assert.equal(start.result.state, 'resolved'); assert.equal(start.result.value.ready, true); assert.equal(h.stopped.length, 1); assert.equal(h.observed.length, 2); next.emit('close', 0, null);
});

test('audio probes remain explicitly textual, close once and never try to stop an already closed process', async () => {
  const h = fixture(), result = h.probe(), proc = h.processes[0]; proc.emit('spawn'); proc.emit('close', 1, null); assert.equal(await result, true); assert.equal(h.stopped.length, 0); assert.equal(h.observed[0].options.operation, 'audio-probe'); assert.equal(h.observed[0].options.stdout, 'text'); assert.equal(h.logs.filter(row => row.event === 'exit').length, 1);
  const timed = fixture(), pending = timed.probe(); timed.fire(7000); assert.equal(await pending, true); assert.equal(timed.stopped.length, 1); assert.equal(timed.logs.filter(row => row.event === 'exit').length, 1); assert.equal(timed.processes[0].listenerCount('error'), 0);
});

test('the actual owned startup-stop helper never terminates a process that already has an exit result', async () => {
  const calls = [], scope = { Promise, process: { platform: 'win32' }, console: { error() {} }, execFile: (...args) => { calls.push(args); args.at(-1)(); } };
  vm.createContext(scope); vm.runInContext(functions.get('stopScrcpyStartupProcess'), scope);
  await scope.stopScrcpyStartupProcess({ pid: 23, exitCode: 0 }); await scope.stopScrcpyStartupProcess({ pid: 23, signalCode: 'SIGTERM' }); assert.equal(calls.length, 0);
  await scope.stopScrcpyStartupProcess({ pid: 24, killed: false, exitCode: null, signalCode: null }); assert.equal(calls.length, 1); assert.equal(calls[0][0], 'taskkill'); assert.deepEqual(Array.from(calls[0][1]), ['/PID', '24', '/T', '/F']);
});
