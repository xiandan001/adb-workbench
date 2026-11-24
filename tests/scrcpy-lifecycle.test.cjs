const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { parse } = require('@babel/parser');
const source = fs.readFileSync(require.resolve('../electron/lib/adb.cjs'), 'utf8');
const ast = parse(source, { sourceType: 'script' });
const functions = new Map(ast.program.body.filter(node => node.type === 'FunctionDeclaration').map(node => [node.id.name, source.slice(node.start, node.end)]));
const register = ast.program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'register');
const startHandler = register.body.body.find(node => node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression' && node.expression.arguments[0]?.value === 'scrcpy:start').expression.arguments[1];
const flush = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
function fixture({ deferStop = false } = {}) {
  const processes = [], timers = [], logs = [], observed = [], stopped = [], stopWaiters = [], cache = new Map(); let clock = 0;
  const spawn = () => { const proc = new EventEmitter(); proc.pid = 100 + processes.length; proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.unref = () => { proc.unreferenced = true; }; for (const pipe of [proc.stdout, proc.stderr]) pipe.resume = pipe.unref = () => {}; processes.push(proc); return proc; };
  const scope = { Buffer, Promise, Date: { now: () => clock }, console: { log() {}, warn() {}, error() {} }, SCRCPY_READY_GRACE_MS: 800, SCRCPY_STARTUP_WATCH_MS: 10000, SCRCPY_AUDIO_PROBE_MS: 7000, scrcpyAudioModeCache: cache, scrcpyMirrorSequence: 0, spawn,
    assertDeviceDiscoveryConfirmed: require('../electron/lib/device-registry.cjs').assertDeviceDiscoveryConfirmed,
    createMirrorDiagnostics(options) { const monitor = require('../electron/lib/mirror-diagnostics.cjs').createMirrorDiagnostics({ ...options, now: () => clock }); return { ...monitor, event: (name, data) => monitor.event(name, data && structuredClone(data)), finish: (name, data) => monitor.finish(name, data && structuredClone(data)) }; },
    applicationLog: { record: row => logs.push(row), observeToolProcess(proc, options) { observed.push({ proc, options }); return () => {}; } },
    buildScrcpySpawn: (_file, args) => ({ command: 'SYNTHETIC', args, options: {} }), stopScrcpyStartupProcess: async proc => { stopped.push(proc); proc.emit('close', 0, null); if (deferStop) await new Promise(resolve => stopWaiters.push(resolve)); },
    tr: (message, args = {}) => message.replace(/\{(\d+)\}/g, (all, key) => args[key] ?? all),
    setTimeout(callback, ms) { const timer = { callback, ms, cleared: false }; timers.push(timer); return timer; }, clearTimeout(timer) { if (timer) timer.cleared = true; } };
  vm.createContext(scope); vm.runInContext(['isScrcpyAudioStartupError', 'isScrcpyVideoReady', 'probeScrcpyAudio', 'startScrcpyProcess'].filter(name => functions.has(name)).map(name => functions.get(name)).join('\n'), scope);
  const track = promise => { const result = { state: 'pending' }; promise.then(value => Object.assign(result, { state: 'resolved', value }), error => Object.assign(result, { state: 'rejected', error })); return { promise, result }; };
  return { processes, logs, observed, stopped, cache, start(options = { retryWithoutAudio: false }) { return track(scope.startScrcpyProcess('PRIVATE-DEVICE', 'PRIVATE-PATH', [], options)); },
    ipcStart(workflow, event) { Object.assign(scope, { mirrorWorkflow: workflow, isHarmonyDevice: () => false, findScrcpyPath: async () => 'SYNTHETIC', buildScrcpyArgs: () => [] }); cache.set('PRIVATE-DEVICE', 'normal'); return track(vm.runInContext('(' + source.slice(startHandler.start, startHandler.end) + ')', scope)(event, { deviceId: 'PRIVATE-DEVICE', settings: {} })); },
    probe: () => scope.probeScrcpyAudio('PRIVATE-DEVICE', 'PRIVATE-PATH', [], { mirrorNumber: 9 }), releaseStop() { assert.ok(stopWaiters.length); stopWaiters.shift()(); }, fire(ms) { const timer = timers.find(item => item.ms === ms && !item.cleared); assert.ok(timer, 'Missing active timer ' + ms); timer.cleared = true; clock += ms; timer.callback(); }, timers };
}

async function workflowFixture(options = {}) {
  const { createMirrorSessionState } = require('../electron/lib/mirror-session-state.cjs');
  const { createMirrorWorkflow } = require('../electron/lib/mirror-workflow.cjs');
  const state = createMirrorSessionState(), contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false });
  const owner = { webContents: contents, isDestroyed: () => false }, event = { sender: contents, senderFrame: contents.mainFrame }; let generation = 1;
  const workflow = createMirrorWorkflow({ profiles: { list: async () => ({ profiles: [] }) }, state, getOwner: () => owner,
    resolveRef: deviceId => ({ id: deviceId, transport: 'adb', targetKey: deviceId, status: 'device', generation }) });
  const h = fixture(options); let prepared, started;
  if (options.viaIpc) { started = h.ipcStart(workflow, event); await flush(); prepared = { ticket: { id: state.get('PRIVATE-DEVICE').id, deviceId: 'PRIVATE-DEVICE', generation } }; }
  else { prepared = await workflow.prepare(event, 'PRIVATE-DEVICE'); started = h.start({ retryWithoutAudio: true, onDiagnostic: row => workflow.observe(prepared.ticket, row),
    onAudioFallback: attempt => workflow.beginAudioFallback(prepared.ticket, attempt), assertCurrent: () => workflow.guard(prepared.ticket) }); }
  return { ...h, started, state, workflow, ticket: prepared.ticket, async replace() { generation++; return workflow.prepare(event, 'PRIVATE-DEVICE'); } };
}

test('actual scrcpy startup rejects every early exit including zero and signal-only, without waiting for its watch timer', async () => {
  for (const [code, signal] of [[0, null], [1, null], [null, 'SIGTERM']]) { const h = fixture(), start = h.start(); h.processes[0].emit('close', code, signal); await flush(); assert.equal(start.result.state, 'rejected'); assert.ok(h.timers.filter(item => item.ms === 10000).every(item => item.cleared)); }
});

test('actual lifetime callbacks update card state after the startup Promise resolved without claiming visible pixels', async () => {
  const { createMirrorSessionState } = require('../electron/lib/mirror-session-state.cjs');
  const state = createMirrorSessionState(), ticket = state.begin({ deviceId: 'PRIVATE-DEVICE', transport: 'adb', generation: 0 }).ticket;
  const h = fixture(), start = h.start({ retryWithoutAudio: false, onDiagnostic: row => state.observe(ticket, row) });
  h.processes[0].stdout.emit('data', Buffer.from('INFO: Texture: 640x360\n')); h.fire(800); await flush();
  assert.equal(start.result.state, 'resolved'); assert.equal(state.get('PRIVATE-DEVICE').phase, 'running'); assert.equal(state.get('PRIVATE-DEVICE').pictureConfirmed, false);
  h.processes[0].emit('close', 1, null); assert.equal(state.get('PRIVATE-DEVICE').phase, 'exited'); assert.equal(state.get('PRIVATE-DEVICE').exitCode, 1);
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

test('actual stop-first audio fallback reserves the next attempt before the old close and keeps one live owned session', async () => {
  const h = await workflowFixture({ viaIpc: true }), first = h.processes[0];
  first.stderr.emit('data', Buffer.from('Cannot create AudioRecord\n'));
  assert.equal(h.logs.find(row => row.event === 'exit').attemptNumber, 1, 'Owned stop emits old close before the next spawn');
  assert.equal(h.state.get('PRIVATE-DEVICE').phase, 'starting'); assert.equal(h.state.get('PRIVATE-DEVICE').attemptNumber, 2);
  assert.equal(h.state.active(h.ticket), true); assert.equal(h.state.begin({ deviceId: 'PRIVATE-DEVICE', transport: 'adb', generation: 1 }).alreadyActive, true);
  await flush(); assert.equal(h.processes.length, 2);
  h.processes[1].stdout.emit('data', Buffer.from('INFO: Texture: 640x360\n')); h.fire(800); await flush();
  assert.equal(h.started.result.state, 'resolved'); assert.equal(h.state.get('PRIVATE-DEVICE').phase, 'running');
  assert.equal(h.state.get('PRIVATE-DEVICE').pictureConfirmed, false); assert.equal(h.state.get('PRIVATE-DEVICE').audioMode, 'disabled');
  assert.equal(h.stopped.length, 1); h.processes[1].emit('close', 1, null);
  assert.equal(h.state.get('PRIVATE-DEVICE').phase, 'exited'); assert.equal(h.state.get('PRIVATE-DEVICE').attemptNumber, 2);
});

test('actual fallback startup failure ends its reserved attempt without scheduling a third process', async () => {
  const h = await workflowFixture(); h.processes[0].stderr.emit('data', Buffer.from('Cannot create AudioRecord\n')); await flush();
  assert.equal(h.processes.length, 2); h.processes[1].emit('error', new Error('synthetic spawn failure')); await flush();
  assert.equal(h.started.result.state, 'rejected'); assert.equal(h.state.get('PRIVATE-DEVICE').phase, 'failed');
  assert.equal(h.state.get('PRIVATE-DEVICE').attemptNumber, 2); assert.equal(h.state.active(h.ticket), false);
  h.processes[1].emit('close', 1, null); assert.equal(h.processes.length, 2); assert.equal(h.stopped.length, 1);
});

test('actual delayed audio handoff cannot revive a cancelled or replaced device generation', async () => {
  for (const kind of ['cancel', 'replace']) {
    const h = await workflowFixture({ deferStop: true }); h.processes[0].stderr.emit('data', Buffer.from('Cannot create AudioRecord\n'));
    let replacement;
    if (kind === 'cancel') h.workflow.fail(h.ticket, 'USER_STOP'); else replacement = await h.replace();
    h.releaseStop(); await flush(); assert.equal(h.started.result.state, 'rejected'); assert.equal(h.processes.length, 1);
    const current = h.state.get('PRIVATE-DEVICE');
    if (kind === 'cancel') { assert.equal(current.id, h.ticket.id); assert.equal(current.phase, 'failed'); assert.equal(current.reason, 'USER_STOP'); }
    else { assert.equal(current.id, replacement.ticket.id); assert.equal(current.generation, 2); assert.equal(current.phase, 'starting'); assert.equal(current.attemptNumber, 0); }
  }
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
