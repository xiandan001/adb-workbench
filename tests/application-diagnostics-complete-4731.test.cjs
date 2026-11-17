const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { pathToFileURL } = require('node:url');

test('actual explicit capture exports code, safe original stack, trusted renderer, IPC outcomes and complete textual tool diagnostics, never off history', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veylo-complete-diagnostics-'));
  const appRoot = path.resolve(__dirname, '..'), handlers = new Map();
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false,
    getURL: () => pathToFileURL(path.join(appRoot, 'dist/index.html')).href });
  const owner = { webContents: contents, isDestroyed: () => false }, app = Object.assign(new EventEmitter(), {
    getAppPath: () => appRoot, getPath: () => directory, getVersion: () => '4.7.19', getGPUFeatureStatus: () => ({}) });
  const filename = path.join(appRoot, 'electron/lib/application-log.cjs'), actualRequire = createRequire(filename), module = { exports: {} };
  const exported = path.join(directory, 'exported.log');
  vm.runInNewContext(syncFs.readFileSync(filename, 'utf8'), { module, process, console, Buffer,
    require: name => name === 'electron' ? { app, dialog: { showSaveDialog: async () => ({ filePath: exported, canceled: false }) }, webContents: { getAllWebContents: () => [contents] } }
      : name === 'electron-updater' ? { autoUpdater: new EventEmitter() }
        : name === './app-context.cjs' ? { getMainWindow: () => owner } : actualRequire(name) }, { filename });
  const api = module.exports;
  t.after(async () => { await api.cleanup(); await fs.rm(directory, { recursive: true, force: true }); });
  const originalCalls = [], fakeConsole = Object.fromEntries(['log', 'info', 'debug', 'warn', 'error', 'trace'].map(level => [level, (...args) => { originalCalls.push({ level, args }); return level; }]));
  api.installEarlyHooks({ consoleObject: fakeConsole, childProcess: {}, appRoot });
  api.register({ handle: (channel, handler) => handlers.set(channel, handler) });
  const event = { sender: contents, senderFrame: contents.mainFrame };
  fakeConsole.info('OFF_PRIVATE_HISTORY');
  await handlers.get('app-log:start')(event);
  fakeConsole.info('MAIN_CODE_MARKER password=CONSOLE_SECRET');
  const error = new Error('CODE_FAILURE_MARKER token=STACK_SECRET');
  fakeConsole.error(error);
  const observed = api.observeIpc({ handle: (channel, handler) => handlers.set(channel, handler) });
  observed.handle('fixture:success', () => ({ success: true, body: 'RESULT_PRIVATE_PAYLOAD' }));
  const originalError = new Error('IPC_FAILURE_MARKER password=IPC_SECRET');
  observed.handle('fixture:failure', () => { throw originalError; });
  assert.equal(handlers.get('fixture:success')(event).success, true);
  assert.throws(() => handlers.get('fixture:failure')(event), value => value === originalError);
  contents.emit('console-message', { level: 'info', message: 'RENDERER_CODE_MARKER password=RENDERER_SECRET',
    sourceId: pathToFileURL(path.join(appRoot, 'dist/assets/app.js')).href, lineNumber: 42, frame: contents.mainFrame });
  contents.emit('console-message', { level: 'error', message: 'REMOTE_PRIVATE_PAYLOAD', sourceId: 'https://oauth.invalid/callback?token=secret', lineNumber: 3, frame: {} });
  const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  proc.stdout.on('data', () => {}); proc.stderr.on('data', () => {});
  const originalListener = () => {}; proc.on('error', originalListener);
  const remove = api.observeToolProcess(proc, { tool: 'scrcpy', operation: 'mirror', stdout: 'text', stderr: 'text', mirrorNumber: 1, attemptNumber: 1 });
  assert.equal(api.observeToolProcess(proc, { tool: 'scrcpy', operation: 'mirror', stdout: 'text', stderr: 'text' }), remove);
  proc.emit('spawn');
  proc.stdout.write('TOOL_STDOUT_MARKER password=TOOL_SECRET\n');
  proc.stderr.write('TOOL_STDERR_MARKER C:\\Users\\Alice\\work\\electron\\lib\\adb.cjs:42:7\n');
  proc.emit('close', 1, null);
  await handlers.get('app-log:stop')(event);
  assert.equal((await handlers.get('app-log:export')(event)).success, true);
  const text = await fs.readFile(exported, 'utf8'), rows = text.trim().split('\n').map(JSON.parse);
  for (const marker of ['MAIN_CODE_MARKER', 'CODE_FAILURE_MARKER', 'IPC_FAILURE_MARKER', 'RENDERER_CODE_MARKER', 'TOOL_STDOUT_MARKER', 'TOOL_STDERR_MARKER']) assert.ok(text.includes(marker), marker);
  assert.match(text, /application-diagnostics-complete-4731\.test\.cjs:\d+:\d+/);
  assert.match(text, /electron\/lib\/adb\.cjs:42:7/);
  for (const secret of ['OFF_PRIVATE_HISTORY', 'CONSOLE_SECRET', 'STACK_SECRET', 'IPC_SECRET', 'RENDERER_SECRET', 'TOOL_SECRET', 'Alice', 'REMOTE_PRIVATE_PAYLOAD', 'RESULT_PRIVATE_PAYLOAD']) assert.ok(!text.includes(secret), secret);
  assert.ok(rows.some(row => row.source === 'ipc' && row.event === 'result' && row.outcome === 'success' && Number.isFinite(row.durationMs)));
  assert.equal(rows[0].version, '4.7.19');
  fakeConsole.info('AFTER_STOP'); proc.stdout.write('AFTER_STOP');
  await handlers.get('app-log:export')(event);
  assert.equal(await fs.readFile(exported, 'utf8'), text);
  assert.equal(proc.listeners('error').includes(originalListener), true);
  assert.ok(originalCalls.length >= 4);
  await handlers.get('app-log:start')(event);
  const tailProcess = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  tailProcess.stdout.on('data', () => {});
  api.observeToolProcess(tailProcess, { tool: 'scrcpy', operation: 'mirror', stdout: 'text', stderr: 'sensitive' });
  tailProcess.stdout.write('CLEANUP_TAIL_WITHOUT_NEWLINE');
  await api.cleanup();
  const restored = require('../electron/lib/application-log-session.cjs').createApplicationLogSession({ directory: path.join(directory, 'application-logs') });
  assert.ok((await restored.text()).includes('CLEANUP_TAIL_WITHOUT_NEWLINE')); await restored.dispose();
});
