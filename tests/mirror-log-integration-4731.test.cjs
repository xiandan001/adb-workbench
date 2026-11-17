const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { pathToFileURL } = require('node:url');
const { parse } = require('@babel/parser');
const { createMirrorDiagnostics } = require('../electron/lib/mirror-diagnostics.cjs');

test('actual scrcpy callbacks export full lifetime semantics and sanitized tool text through the real explicit capture, excluding binary/off history', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veylo-mirror-log-integration-')), root = path.resolve(__dirname, '..'), handlers = new Map();
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, getURL: () => pathToFileURL(path.join(root, 'dist/index.html')).href });
  const owner = { webContents: contents, isDestroyed: () => false }, app = Object.assign(new EventEmitter(), { getAppPath: () => root, getPath: () => directory, getVersion: () => '4.7.31', getGPUFeatureStatus: () => ({}) });
  const filename = path.join(root, 'electron/lib/application-log.cjs'), actualRequire = createRequire(filename), module = { exports: {} }, exported = path.join(directory, 'export.log');
  vm.runInNewContext(syncFs.readFileSync(filename, 'utf8'), { module, process, console, Buffer,
    require: name => name === 'electron' ? { app, dialog: { showSaveDialog: async () => ({ filePath: exported, canceled: false }) }, webContents: { getAllWebContents: () => [contents] } }
      : name === 'electron-updater' ? { autoUpdater: new EventEmitter() } : name === './app-context.cjs' ? { getMainWindow: () => owner } : actualRequire(name) }, { filename });
  const api = module.exports; api.register({ handle: (channel, handler) => handlers.set(channel, handler) });
  t.after(async () => { await api.cleanup(); await fs.rm(directory, { recursive: true, force: true }); });
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const off = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() }); api.observeToolProcess(off, { tool: 'scrcpy', operation: 'mirror', stdout: 'text', stderr: 'text' }); off.stdout.write('OFF_PRIVATE_HISTORY\n'); off.emit('close', 0, null);
  assert.equal((await handlers.get('app-log:status')(event)).state.available, false); await handlers.get('app-log:start')(event);
  const proc = Object.assign(new EventEmitter(), { pid: 501, stdout: new PassThrough(), stderr: new PassThrough(), unref() {} }); proc.stdout.unref = proc.stderr.unref = () => {};
  const timers = []; let clock = 0;
  const adbSource = syncFs.readFileSync(path.join(root, 'electron/lib/adb.cjs'), 'utf8'), declaration = parse(adbSource, { sourceType: 'script' }).program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'startScrcpyProcess');
  const scope = { Promise, Buffer, applicationLog: api, scrcpyMirrorSequence: 0, scrcpyAudioModeCache: new Map(), SCRCPY_READY_GRACE_MS: 800, SCRCPY_STARTUP_WATCH_MS: 10000,
    createMirrorDiagnostics: options => { const monitor = createMirrorDiagnostics({ ...options, now: () => clock }); return { ...monitor, event: (name, data) => monitor.event(name, data && structuredClone(data)), finish: (name, data) => monitor.finish(name, data && structuredClone(data)) }; },
    buildScrcpySpawn: () => ({ command: 'SYNTHETIC', args: [], options: {} }), spawn: () => proc, stopScrcpyStartupProcess: () => { assert.fail('No process termination required'); },
    tr: value => value, setTimeout(callback, ms) { const timer = { callback, ms }; timers.push(timer); return timer; }, clearTimeout(timer) { if (timer) timer.cleared = true; } };
  vm.createContext(scope); vm.runInContext(adbSource.slice(declaration.start, declaration.end), scope);
  const pending = scope.startScrcpyProcess('PRIVATE_DEVICE', 'PRIVATE_EXECUTABLE', [], { retryWithoutAudio: false }); proc.emit('spawn');
  proc.stdout.write('scrcpy 5.0.1 <https://github.com/Genymobile/scrcpy>\nINFO: Texture: 640x360\n'); clock = 800; timers.find(timer => timer.ms === 800).callback(); assert.equal((await pending).ready, true);
  proc.stderr.write('MIRROR_FAILURE_MARKER token=PRIVATE_TOKEN\n'); clock = 1400; proc.emit('close', 1, null);
  const binary = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() }); api.observeToolProcess(binary, { tool: 'hdc', operation: 'mirror', stdout: 'binary', stderr: 'sensitive' }); assert.equal(binary.stdout.listenerCount('data'), 0); binary.stdout.write(Buffer.from('RAW_FRAME_PRIVATE')); binary.emit('close', 0, null); binary.stdout.destroy(); binary.stderr.destroy();
  await handlers.get('app-log:stop')(event); assert.equal((await handlers.get('app-log:export')(event)).success, true);
  const text = await fs.readFile(exported, 'utf8'), rows = text.trim().split('\n').map(JSON.parse), mirror = rows.filter(row => row.source === 'mirror');
  assert.equal(rows[0].version, '4.7.31'); assert.equal(rows.at(-1).source, 'session'); assert.deepEqual(mirror.map(row => row.event), ['opening', 'spawn', 'startup-check', 'tool-version', 'ready', 'exit']);
  assert.equal(mirror.at(-1).exitCode, 1); assert.equal(mirror.at(-1).durationMs, 1400); assert.equal(mirror.at(-1).toolVersion, '5.0.1'); assert.equal(mirror.at(-1).width, 640); assert.equal(mirror.at(-1).height, 360);
  assert.ok(rows.some(row => row.source === 'tool' && row.event === 'output' && row.message.includes('MIRROR_FAILURE_MARKER'))); assert.ok(rows.some(row => row.source === 'tool' && row.event === 'exit' && row.tool === 'scrcpy' && row.exitCode === 1)); assert.ok(rows.some(row => row.source === 'tool' && row.event === 'excluded'));
  assert.doesNotMatch(text, /PRIVATE_TOKEN|PRIVATE_DEVICE|PRIVATE_EXECUTABLE|RAW_FRAME_PRIVATE|OFF_PRIVATE_HISTORY/);
  proc.stdout.write('AFTER_STOP_PRIVATE\n'); await handlers.get('app-log:export')(event); assert.equal(await fs.readFile(exported, 'utf8'), text);
});
