const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { installCodeHooks, createApplicationIpc } = require('../electron/lib/application-log-hooks.cjs');
const { createToolObserver } = require('../electron/lib/application-log-tools.cjs');
const { normalizeCodeArguments } = require('../electron/lib/application-log-text.cjs');
const { observeRenderer } = require('../electron/lib/application-log-renderer.cjs');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { classifyToolCall } = require('../electron/lib/application-log-tool-policy.cjs');

test('console and process hooks preserve exact returns and thrown identities, skip getters/proxies and own only their wrappers', () => {
  const records = []; let enabled = false, getters = 0;
  const token = {}, originalError = Error('original');
  const log = function (value) { if (value === 'throw') throw originalError; return token; };
  const consoleObject = { info: log }, proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  const args = ['fixture.exe', ['PRIVATE_ARGUMENT'], { env: { KEY: 'PRIVATE_ENV' } }];
  const spawn = function (...received) { assert.equal(received[0], args[0]); assert.equal(received[1], args[1]); assert.equal(received[2], args[2]); return proc; };
  const childProcess = { spawn }, observer = createToolObserver({ record: row => records.push(row), isEnabled: () => enabled });
  const cleanup = installCodeHooks({ consoleObject, childProcess, record: row => records.push(row), isEnabled: () => enabled, observeToolProcess: observer.observe });
  assert.equal(consoleObject.info('off'), token); assert.equal(records.length, 0);
  enabled = true;
  const gadget = Object.defineProperty({}, 'name', { get() { getters++; throw Error('getter'); } });
  assert.equal(consoleObject.info(gadget), token);
  consoleObject.info(new Proxy({}, { ownKeys() { getters++; throw Error('proxy'); } }));
  const formatter = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  let formatters = 0; Object.defineProperty(Error, 'prepareStackTrace', { ...formatter, value: () => { formatters++; return 'PRIVATE_FORMATTER'; } });
  try { consoleObject.info(new Error('safe')); } finally { Object.defineProperty(Error, 'prepareStackTrace', formatter); }
  assert.equal(getters, 0); assert.equal(formatters, 0);
  assert.throws(() => consoleObject.info('throw'), error => error === originalError);
  assert.equal(childProcess.spawn(...args), proc);
  assert.equal(proc.stdout.listenerCount('data'), 0, 'Unknown stdout remains owned by its original consumer');
  assert.throws(() => proc.emit('error', originalError), error => error === originalError, 'errorMonitor must not consume an otherwise unhandled tool error');
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_ARGUMENT|PRIVATE_ENV|PRIVATE_FORMATTER/);
  const replacement = () => 'other observer'; consoleObject.info = replacement;
  cleanup(); observer.cleanup(); assert.equal(consoleObject.info, replacement); assert.equal(childProcess.spawn, spawn);
});

test('text handling bounds giant arguments and rejects complete sensitive payloads without changing them', () => {
  const raw = 'x'.repeat(4 * 1024 * 1024), result = normalizeCodeArguments([raw, raw, raw]);
  assert.ok(Buffer.byteLength(result.message) <= 4096); assert.ok(result.omittedCharacters > 0);
  const input = '{"messages":[{"role":"user","content":"PRIVATE_FULL_AI_BODY"}]}';
  assert.doesNotMatch(normalizeCodeArguments([input]).message, /PRIVATE_FULL_AI_BODY/);
  assert.ok(input.includes('PRIVATE_FULL_AI_BODY'));
  const error = new Error('bounded stack');
  Object.defineProperty(error, 'stack', { value: 'Error: bounded stack\n' + '    at electron/lib/source.cjs:1:2\n'.repeat(100) });
  const trace = normalizeCodeArguments([error]);
  assert.equal(trace.stack.split('\n').length, 40); assert.ok(trace.omittedCharacters > 0, 'A frame-count cutoff must be disclosed');
});

test('one observational process can upgrade to text, preserves split UTF8, counts clipping and never retains off-session tails', () => {
  let enabled = true; const rows = [], losses = [];
  const observer = createToolObserver({ record: row => rows.push(row), isEnabled: () => enabled, noteLoss: (...args) => losses.push(args) });
  const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  const original = () => {}; proc.on('error', original);
  const remove = observer.observe(proc, { tool: 'scrcpy', stdout: 'binary', stderr: 'sensitive' });
  assert.equal(proc.stdout.listenerCount('data'), 0);
  assert.equal(observer.observe(proc, { tool: 'scrcpy', operation: 'mirror', stdout: 'text', stderr: 'text' }), remove);
  assert.equal(proc.stdout.listenerCount('data'), 0, 'Observation must not force a previously unread stream into flowing mode');
  proc.stdout.on('data', () => {}); proc.stderr.on('data', () => {});
  proc.emit('spawn');
  const unicode = Buffer.from('split 中文😀\n');
  for (const byte of unicode) proc.stdout.write(Buffer.from([byte]));
  assert.ok(rows.some(row => row.message === 'split 中文😀'));
  proc.stdout.write('OLD_PENDING_WITHOUT_NEWLINE'); enabled = false; observer.reset();
  proc.stdout.write('OFF_PRIVATE_HISTORY'); enabled = true; proc.stdout.write('fresh\n');
  assert.ok(!JSON.stringify(rows).includes('OLD_PENDING_WITHOUT_NEWLINE')); assert.ok(!JSON.stringify(rows).includes('OFF_PRIVATE_HISTORY'));
  proc.stderr.write(Buffer.alloc(128 * 1024, 120)); observer.flush();
  assert.ok(losses.some(([reason]) => reason === 'text-size'));
  assert.ok(rows.filter(row => row.message).every(row => Buffer.byteLength(row.message) <= 4096));
  proc.emit('close', 1, null); remove(); remove();
  assert.equal(rows.filter(row => row.event === 'spawn').length, 1);
  assert.equal(rows.filter(row => row.event === 'exit').length, 1);
  assert.equal(proc.listenerCount('error'), 1); assert.equal(proc.listeners('error')[0], original);
});

test('trusted current and legacy renderer signatures capture code but remote frames and OAuth never contribute text', () => {
  const appRoot = path.resolve(__dirname, '..'), mainFrame = {}, rows = [], excluded = [];
  const contents = Object.assign(new EventEmitter(), { mainFrame, isDestroyed: () => false, getURL: () => pathToFileURL(path.join(appRoot, 'dist/index.html')).href });
  const source = pathToFileURL(path.join(appRoot, 'dist/assets/app.js')).href;
  const remove = observeRenderer(contents, { record: row => rows.push(row), isEnabled: () => true, appRoot, noteLoss: value => excluded.push(value) });
  contents.emit('console-message', { frame: mainFrame, sourceId: source, message: 'modern', lineNumber: 5, level: 'info' });
  contents.emit('console-message', { senderFrame: mainFrame }, 3, 'legacy', 7, source);
  contents.emit('console-message', { frame: {}, sourceId: source, message: 'FOREIGN_FRAME', level: 'error' });
  contents.emit('console-message', { frame: mainFrame, sourceId: 'https://oauth.invalid/?token=PRIVATE', message: 'OAUTH_BODY', level: 'error' });
  assert.deepEqual(rows.map(row => row.message), ['modern', 'legacy']); assert.equal(excluded.length, 2);
  remove(); contents.emit('console-message', { frame: mainFrame, sourceId: source, message: 'removed', level: 'info' });
  assert.equal(rows.length, 2);
});

test('application-only IPC covers successes and rejected failures without reading payload getters or altering returns', async () => {
  const handlers = new Map(), rows = [], error = Error('safe failure'); let reads = 0;
  const original = { success: true, get body() { reads++; throw Error('private body'); } };
  const ipc = createApplicationIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, { record: row => rows.push(row), isEnabled: () => true });
  ipc.handle('adb:getDevices', () => original); assert.equal(handlers.get('adb:getDevices')({}, { secret: 'NEVER_LOG' }), original);
  ipc.handle('adb:connect', async () => { throw error; }); await assert.rejects(handlers.get('adb:connect')({}), value => value === error);
  assert.equal(reads, 0); assert.ok(rows.some(row => row.event === 'result' && row.outcome === 'success'));
  assert.ok(rows.some(row => row.event === 'failure' && Number.isFinite(row.durationMs)));
  assert.doesNotMatch(JSON.stringify(rows), /NEVER_LOG|private body/);
});

test('central tool classifier captures bounded host/read-only diagnostics, but never shell input, media, private streams or command arguments', () => {
  for (const [file, args] of [['adb.exe', ['-s', 'PRIVATE_DEVICE', 'devices', '-l']], ['adb.exe', ['shell', 'getprop ro.product.model']], ['hdc.exe', ['list', 'targets']], ['hdc.exe', ['-t', 'PRIVATE_DEVICE', 'shell', 'param get const.product.model']], ['node.exe', ['--version']]]) {
    const policy = classifyToolCall(file, args); assert.equal(policy.stdout, 'text'); assert.equal(policy.stderr, 'text'); assert.ok(!JSON.stringify(policy).includes('PRIVATE_DEVICE'));
  }
  for (const [file, args] of [['adb.exe', ['shell', 'input text PRIVATE_INPUT']], ['adb.exe', ['exec-out', 'screenrecord']], ['adb.exe', ['logcat']], ['hdc.exe', ['shell', 'hilog']], ['node.exe', ['-e', 'PRIVATE_SCRIPT']], ['unknown.exe', ['--payload', 'PRIVATE_INPUT']]]) {
    const policy = classifyToolCall(file, args); assert.equal(policy.stdout, 'sensitive'); assert.equal(policy.stderr, 'sensitive');
  }
  const rows = [], raw = Buffer.from('List of devices attached\nSHORT_PRIVATE_ID device product:fixture\n');
  const childProcess = { execFileSync: () => raw }, remove = installCodeHooks({ consoleObject: {}, childProcess, record: row => rows.push(row), isEnabled: () => true, observeToolProcess() {} });
  assert.equal(childProcess.execFileSync('adb.exe', ['devices']), raw); remove();
  assert.ok(rows.some(row => row.event === 'output')); assert.ok(!JSON.stringify(rows).includes('SHORT_PRIVATE_ID'));
  const commandFailure = normalizeCodeArguments(['Failure Command failed: adb shell input text PRIVATE_INPUT\nPRIVATE_SECOND_LINE']);
  assert.doesNotMatch(commandFailure.message, /PRIVATE_INPUT|PRIVATE_SECOND_LINE/);
  const location = normalizeCodeArguments(['electron/lib/adb.cjs:42:7 connected fc00::1']);
  assert.ok(location.message.includes('adb.cjs:42:7')); assert.ok(!location.message.includes('fc00::1'));
});
