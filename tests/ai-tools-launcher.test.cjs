const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createAiToolsLauncher, buildLaunchScript } = require('../electron/lib/ai-tools-launcher.cjs');

const input = { executable: 'C:\\fixture\\tool.cmd', args: ["literal' argument"], cwd: 'C:\\fixture\\project', env: { GEMINI_API_KEY: 'fixture-only-secret' } };
function fixture(options = {}) {
  const server = new EventEmitter(); server.listen = (_name, callback) => { queueMicrotask(callback); return server; }; server.close = () => {};
  const children = []; const sockets = [];
  const launcher = createAiToolsLauncher({ platform: 'win32', environment: { SystemRoot: 'C:\\Windows', PATH: 'C:\\fixture', UNRELATED_SECRET: 'must-not-inherit' },
    timeoutMs: 80, createServer: callback => { server.connect = callback; return server; }, randomId: () => '11111111-1111-4111-8111-111111111111',
    spawnProcess: (executable, args, settings) => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => { child.killed = true; }; children.push({ child, executable, args, settings });
      queueMicrotask(() => child.emit('spawn')); return child;
    }, ...options,
  });
  const connect = message => {
    const socket = new EventEmitter(); socket.end = value => { socket.sent = value; socket.emit('close'); }; socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
    sockets.push(socket); server.connect(socket); socket.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)); return socket;
  };
  return { launcher, children, sockets, connect };
}
const ready = { nonce: '11111111-1111-4111-8111-111111111111', state: 'ready', pid: 322, parentPid: 321, inputTTY: true, outputTTY: true };

test('spawn alone is not success; only an interactive matching-PID nonce handshake permits the CLI', async () => {
  const h = fixture(); let settled = false;
  const pending = h.launcher.launchTerminal(input).then(value => { settled = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  const row = h.children[0];
  assert.equal(row.settings.windowsHide, true); assert.deepEqual(row.settings.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(row.settings.detached, undefined); assert.equal(row.settings.env.GEMINI_API_KEY, input.env.GEMINI_API_KEY);
  assert.equal(row.settings.env.UNRELATED_SECRET, undefined); assert.ok(!JSON.stringify(row.args).includes(input.env.GEMINI_API_KEY));
  const bootstrap = Buffer.from(row.args.at(-1), 'base64').toString('utf16le');
  assert.match(bootstrap, /Start-Process -FilePath 'C:\\Windows\\System32\\cmd.exe'/);
  assert.match(bootstrap, /\/D \/K/); assert.match(bootstrap, /-WindowStyle Normal/);
  const inner = Buffer.from(bootstrap.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)[1], 'base64').toString('utf16le');
  assert.match(inner, /BackgroundColor = \[ConsoleColor\]::Black/); assert.doesNotMatch(inner, /-NoExit|终端已就绪|CLI 已退出/);
  assert.ok(!bootstrap.includes(input.env.GEMINI_API_KEY)); assert.ok(!inner.includes(input.env.GEMINI_API_KEY));
  const socket = h.connect(ready); assert.equal(settled, false, 'visible PID must also match the creator acknowledgement');
  row.child.stdout.write('{"pid":321}\n'); row.child.emit('exit', 0);
  assert.deepEqual(await pending, { terminalReady: true, terminalPid: 321, launcherPid: 322 }); assert.equal(socket.sent, 'launch\n');
});

test('wrong nonce and redirected console cannot be accepted as ready', async () => {
  const h = fixture(); const pending = h.launcher.launchTerminal(input);
  const rejected = assert.rejects(pending, { code: 'AI_TOOLS_LAUNCH_FAILED' });
  await new Promise(resolve => setImmediate(resolve)); h.children[0].child.stdout.write('{"pid":321}\n');
  const bad = h.connect({ ...ready, nonce: 'wrong' }); assert.equal(bad.destroyed, true);
  h.connect({ ...ready, inputTTY: false }); await rejected;
  assert.ok(h.sockets.every(socket => socket.sent !== 'launch\n'));
});

test('a console that disconnects before the creator PID arrives cannot receive late launch permission', async () => {
  const h = fixture(); const pending = h.launcher.launchTerminal(input);
  const rejected = assert.rejects(pending, { code: 'AI_TOOLS_LAUNCH_FAILED' });
  await new Promise(resolve => setImmediate(resolve)); const socket = h.connect(ready);
  socket.destroyed = true; socket.emit('close');
  h.children[0].child.stdout.write('{"pid":321}\n');
  await rejected; assert.notEqual(socket.sent, 'launch\n');
});

test('PID mismatch, initialization failure and timeout never release a launch permission', async () => {
  for (const mode of ['pid', 'failed', 'timeout']) {
    const h = fixture(); const pending = h.launcher.launchTerminal(input);
    const rejected = assert.rejects(pending, error => ['AI_TOOLS_LAUNCH_FAILED', 'AI_TOOLS_LAUNCH_TIMEOUT'].includes(error.code) && !error.message.includes(input.env.GEMINI_API_KEY));
    await new Promise(resolve => setImmediate(resolve)); h.children[0].child.stdout.write('{"pid":321}\n');
    if (mode !== 'timeout') h.connect(mode === 'pid' ? { ...ready, parentPid: 999 } : { ...ready, state: 'failed' });
    await rejected; assert.ok(h.sockets.every(socket => socket.sent !== 'launch\n'));
  }
});

test('abort before launch starts nothing and abort during handshake rejects any late ready message', async () => {
  const pre = new AbortController(); pre.abort(); const h = fixture();
  await assert.rejects(h.launcher.launchTerminal({ ...input, signal: pre.signal }), { code: 'AI_TOOLS_CANCELLED' });
  assert.equal(h.children.length, 0);
  const abort = new AbortController(); const pending = h.launcher.launchTerminal({ ...input, signal: abort.signal });
  const rejected = assert.rejects(pending, { code: 'AI_TOOLS_CANCELLED' });
  await new Promise(resolve => setImmediate(resolve)); abort.abort(); await rejected;
  const late = h.connect(ready); assert.equal(late.destroyed, true); assert.notEqual(late.sent, 'launch\n');
});

test('bootstrap errors and oversized acknowledgements are sanitized failures', async () => {
  for (const mode of ['error', 'exit', 'oversized']) {
    const h = fixture(); const pending = h.launcher.launchTerminal(input);
    const rejected = assert.rejects(pending, error => error.code === 'AI_TOOLS_LAUNCH_FAILED' && !error.message.includes('private'));
    await new Promise(resolve => setImmediate(resolve)); const child = h.children[0].child;
    if (mode === 'error') child.emit('error', new Error('private bootstrap error'));
    if (mode === 'exit') { child.stderr.write('private error'); child.emit('exit', 1); }
    if (mode === 'oversized') child.stdout.write('private'.repeat(1000));
    await rejected;
  }
});

test('literal quoting remains intact and invalid launch requests do not start processes', async () => {
  assert.match(buildLaunchScript({ executable: "C:\\it's a path\\tool.cmd", args: ["$(not-a-command); 'literal'"] }), /'\$\(not-a-command\); ''literal'''/);
  const h = fixture();
  for (const change of [{ cwd: 'relative' }, { executable: 'relative.cmd' }, { args: ['bad\0arg'] }, { env: { KEY: 'bad\0value' } }]) {
    await assert.rejects(h.launcher.launchTerminal({ ...input, ...change }), { code: 'AI_TOOLS_LAUNCH_ARGUMENT' });
  }
  assert.equal(h.children.length, 0);
});
