const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Client } = require('ssh2');
const { createSshTerminal } = require('../electron/lib/ssh-session-terminal.cjs');
const { createSshSessionService } = require('../electron/lib/ssh-session.cjs');
const { startTestServer } = require('./helpers/ssh-test-server.cjs');

const nonce = 'c'.repeat(64);
const mark = (type, extra = '', token = nonce) => Buffer.from(`\x1b]7777;AWB;${token};${type}${extra ? ';' + extra : ''}\x07`);
function terminalFixture(t) {
  const channel = new EventEmitter(); const commands = [];
  channel.stderr = new EventEmitter(); channel.end = () => {}; channel.close = () => {};
  channel.write = (_bytes, cb) => { queueMicrotask(() => cb(null)); return true; };
  const terminal = createSshTerminal({ sessionId: 'session', terminalId: 'terminal', title: 'test', cols: 80, rows: 24,
    assertCurrent: () => {}, onChange: () => {}, onShellCommand: command => commands.push(command) });
  terminal.attach(channel); t.after(() => terminal.close());
  return { terminal, channel, commands };
}
test('PTY exposes exact sanitized marker offsets including zero-byte boundary reads without exposing nonce', async t => {
  const h = terminalFixture(t); const ready = h.terminal.startShellIntegration(nonce, 1000);
  h.channel.emit('data', Buffer.concat([Buffer.from('before'), mark('R'), mark('A'), Buffer.from('$ '), mark('B')]));
  await ready;
  let read = h.terminal.read({ offset: 0 });
  assert.equal(Buffer.from(read.hex, 'hex').toString(), 'before$ ');
  assert.deepEqual(read.shellMarkers, [{ id: 1, kind: 'prompt-start', offset: 6, promptId: 0 }, { id: 2, kind: 'prompt', offset: 8, promptId: 1 }]);
  assert.equal(read.shellIntegration.promptOffset, 8);
  read = h.terminal.read({ offset: 8 });
  assert.equal(read.hex, ''); assert.deepEqual(read.shellMarkers.map(item => item.id), [2]);
  assert.ok(!JSON.stringify(h.terminal.snapshot()).includes(nonce));
  h.channel.emit('data', Buffer.concat([mark('C'), mark('E', Buffer.from('echo yes').toString('hex'))]));
  assert.deepEqual(h.commands, ['echo yes']);
  assert.equal(h.terminal.read({ offset: 8 }).shellMarkers.at(-1).kind, 'running');
});
test('PTY markers and raw ring remain bounded; read never includes a future marker', async t => {
  const h = terminalFixture(t); const ready = h.terminal.startShellIntegration(nonce, 1000);
  h.channel.emit('data', Buffer.concat([mark('R'), mark('A'), mark('B')])); await ready;
  h.channel.emit('data', Buffer.concat([Buffer.alloc(70000, 120), mark('A'), mark('B')]));
  assert.ok(h.terminal.read({ offset: 0 }).shellMarkers.every(item => item.offset <= 65536));
  h.channel.emit('data', Buffer.alloc(300000, 121));
  const read = h.terminal.read({ offset: 0 });
  assert.equal(read.truncated, true); assert.deepEqual(read.shellMarkers, []);
  for (let index = 0; index < 200; index++) h.channel.emit('data', Buffer.concat([mark('A'), mark('B')]));
  const end = h.terminal.snapshot().endOffset;
  const events = h.terminal.read({ offset: end }).shellMarkers;
  assert.equal(events.length, 256); assert.ok(events[0].id > 1);
});
test('enabling blocks ordinary writes and close cancels its acknowledgement without learning late markers', async t => {
  const h = terminalFixture(t); const ready = h.terminal.startShellIntegration(nonce, 1000);
  await assert.rejects(h.terminal.write({ content: 'not-yet' }), /命令识别/);
  await h.terminal.writeBootstrap('bootstrap\r');
  h.terminal.close(); await assert.rejects(ready, /关闭/);
  h.channel.emit('data', Buffer.concat([mark('R'), mark('A'), mark('B'), mark('C'), mark('E', '736563726574')]));
  assert.deepEqual(h.commands, []);
});
test('unsupported or silent shell leaves ordinary terminal usable without automatic retries', async t => {
  const h = terminalFixture(t); const ready = h.terminal.startShellIntegration(nonce, 30);
  h.channel.emit('data', mark('X'));
  await assert.rejects(ready, /Bash/);
  assert.equal(h.terminal.snapshot().status, 'ready');
  assert.equal(h.terminal.snapshot().shellIntegration.status, 'unsupported');
  await h.terminal.write({ content: 'ordinary\r' });
  assert.throws(() => h.terminal.startShellIntegration(nonce, 30), /新建终端/);
  const silent = terminalFixture(t); const timedOut = silent.terminal.startShellIntegration(nonce, 10);
  await assert.rejects(timedOut, /确认/);
  assert.equal(silent.terminal.snapshot().status, 'ready');
  await silent.terminal.write({ content: 'still usable' });
});
test('real SSH/SFTP enable uses one PTY, removes its own script, and publishes only verified host-scoped commands', { timeout: 15000 }, async t => {
  let server; const scripts = []; const wire = [];
  server = await startTestServer({ banner: false, onShellData: async ({ stream, data, record }) => {
    wire.push(Buffer.from(data));
    const match = /^ \. '([^']+)'\r$/.exec(data.toString());
    if (!match) return;
    try {
      const script = await fs.readFile(path.join(server.root, ...match[1].split('/')), 'utf8');
      const token = /__awb_shell_nonce='([a-f0-9]{64})'/.exec(script)[1];
      scripts.push({ path: match[1], token, record });
      stream.write(Buffer.concat([mark('R', '', token), mark('A', '', token), Buffer.from('test$ '), mark('B', '', token)]));
    } catch (error) { stream.stderr.write('fixture error: ' + error.message); }
  } });
  const commands = [];
  const service = createSshSessionService({ createClient: () => new Client(), resolveProfile: async () => ({ ...server,
    name: 'loopback', host: server.host, port: server.port, username: server.username, password: server.password }),
  verifyHostKey: async () => true, onShellCommand: value => commands.push(value), shellIntegrationTimeoutMs: 3000 });
  t.after(async () => { await service.dispose(); await server.close(); });
  const host = await service.connect();
  const first = service.snapshot().sessions[0].terminals[0].id;
  const second = (await service.openTerminal(host)).terminalId;
  const enabled = await service.enableShellIntegration({ ...host, terminalId: first });
  assert.equal(enabled.shellIntegration.status, 'ready'); assert.equal(enabled.shellIntegration.phase, 'prompt');
  assert.equal(scripts.length, 1); assert.equal(wire.length, 1);
  assert.equal(await fs.stat(path.join(server.root, ...scripts[0].path.split('/'))).then(() => true, () => false), false);
  assert.equal(service.snapshot().sessions[0].terminals.find(item => item.id === second).shellIntegration.status, 'disabled');
  const payload = Buffer.from('echo accepted').toString('hex');
  server.shells[1].stream.write(Buffer.concat([mark('R', '', scripts[0].token), mark('A', '', scripts[0].token), mark('B', '', scripts[0].token), mark('C', '', scripts[0].token), mark('E', payload, scripts[0].token)]));
  server.shells[0].stream.write(Buffer.concat([mark('C', '', scripts[0].token), mark('E', payload, scripts[0].token)]));
  const until = Date.now() + 2000;
  while (!commands.length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(commands.length, 1); assert.equal(commands[0].command, 'echo accepted');
  assert.equal(commands[0].sessionId, host.sessionId); assert.equal(commands[0].terminalId, first);
  assert.equal(commands[0].host, server.host); assert.equal(commands[0].username, server.username);
  assert.ok(!JSON.stringify(service.terminalRead({ ...host, terminalId: first, offset: 0 })).includes(scripts[0].token));
});

async function pendingBootstrap(t, cleanupTimeoutMs = 1000) {
  let sourced = false;
  const server = await startTestServer({ banner: false, onShellData: ({ data }) => { if (data.toString().startsWith(' . ')) sourced = true; } });
  const service = createSshSessionService({ createClient: () => new Client(),
    resolveProfile: async () => ({ host: server.host, port: server.port, username: server.username, password: server.password }),
    verifyHostKey: async () => true, shellIntegrationTimeoutMs: 3000, shellCleanupTimeoutMs: cleanupTimeoutMs });
  t.after(async () => { await service.dispose(); await server.close(); });
  const host = await service.connect(); const terminalId = service.snapshot().sessions[0].terminals[0].id;
  const enabling = service.enableShellIntegration({ ...host, terminalId });
  const outcome = enabling.then(() => null, error => error);
  const rejected = assert.rejects(enabling);
  const until = Date.now() + 2000;
  while (!sourced && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(sourced, true);
  return { server, service, host, terminalId, rejected, outcome,
    scripts: async () => (await fs.readdir(path.join(server.root, 'home', 'test'))).filter(name => name.startsWith('.adb-workbench-shell-')) };
}
test('manual disconnect cancels pending initialization and removes its script before closing SFTP', async t => {
  const h = await pendingBootstrap(t);
  await h.service.disconnect(h.host); await h.rejected;
  assert.deepEqual(await h.scripts(), []);
  assert.equal(h.service.snapshot().sessions[0].status, 'disconnected');
});
test('closing one initializing PTY waits for script cleanup without closing sibling PTY or SFTP', async t => {
  const h = await pendingBootstrap(t); const sibling = await h.service.openTerminal(h.host);
  await h.service.closeTerminal({ ...h.host, terminalId: h.terminalId });
  assert.deepEqual(await h.scripts(), []);
  await h.rejected;
  const state = h.service.snapshot().sessions[0]; assert.equal(state.status, 'connected');
  assert.deepEqual(state.terminals.map(item => item.id), [sibling.terminalId]);
  assert.ok(await h.service.getSftp(h.host.sessionId));
});
test('dispose gives owned bootstrap cleanup a bounded opportunity before closing SSH', async t => {
  const h = await pendingBootstrap(t);
  await h.service.dispose(); await h.rejected;
  assert.deepEqual(await h.scripts(), []);
});
test('natural network loss reports the exact possibly retained script without exposing its nonce', async t => {
  const h = await pendingBootstrap(t); const [file] = await h.scripts();
  h.server.disconnectClient(); await h.rejected;
  const error = await h.outcome;
  assert.equal(error.code, 'SSH_SHELL_CLEANUP_FAILED');
  const state = h.service.snapshot().sessions[0];
  assert.match(state.error, /可能未清理/); assert.ok(state.error.includes(file));
  assert.equal(state.terminals[0].shellIntegration.status, 'error');
  assert.doesNotMatch(JSON.stringify(state), /[a-f0-9]{64}/);
});
test('stalled cleanup cannot hang disconnect; connection closes and warning remains visible', async t => {
  // Keep the short deadline specifically for the deliberately stalled cleanup.
  const h = await pendingBootstrap(t, 30); const sftp = await h.service.getSftp(h.host.sessionId);
  sftp.unlink = () => {};
  await assert.rejects(h.service.disconnect(h.host), { code: 'SSH_SHELL_CLEANUP_FAILED' }); await h.rejected;
  const state = h.service.snapshot().sessions[0];
  assert.equal(state.status, 'disconnected'); assert.match(state.error, /可能未清理/);
  assert.deepEqual(await h.service.disconnect(h.host), h.host);
});
