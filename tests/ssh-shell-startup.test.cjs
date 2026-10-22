const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Client } = require('ssh2');
const { spawn } = require('node:child_process');
const { probeBash, bashStartupScript, bashStartupCommand } = require('../electron/lib/ssh-shell-startup.cjs');
const { createSshSessionService } = require('../electron/lib/ssh-session.cjs');
const { startTestServer } = require('./helpers/ssh-test-server.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
function probeFixture(behavior) {
  const stream = new EventEmitter(); stream.stderr = new EventEmitter(); stream.end = () => {};
  stream.close = () => { stream.closed = true; }; const calls = [];
  const client = { exec: (command, options, callback) => { calls.push({ command, options }); queueMicrotask(() => { callback(null, stream); behavior?.(stream); }); } };
  return { stream, calls, client };
}
test('Bash probe uses a bounded noninteractive exec and accepts only validated Bash 4.4+ output', async () => {
  const h = probeFixture(stream => { stream.emit('data', Buffer.from('AWB_BASH_V1\n/bin/bash\n5.3\n')); stream.emit('exit', 0); stream.emit('close'); });
  assert.deepEqual(await probeBash(h.client, { assertCurrent: () => {} }), { path: '/bin/bash', major: 5, minor: 3 });
  assert.equal(h.calls[0].options.pty, false); assert.match(h.calls[0].command, /--noprofile --norc/);
  assert.doesNotMatch(h.calls[0].command, /\.bashrc|\.bash_history|source/);
});
test('Bash probe rejects unsupported, overlong, timed-out and cancelled responses without using stdin', async () => {
  for (const output of ['AWB_BASH_V1\n/bin/bash\n4.3\n', 'AWB_BASH_V1\n/bin/zsh\n5.3\n', 'x'.repeat(4097)]) {
    const h = probeFixture(stream => { stream.emit('data', Buffer.from(output)); stream.emit('exit', 0); stream.emit('close'); });
    await assert.rejects(probeBash(h.client, { assertCurrent: () => {} })); assert.equal(h.stream.closed, true);
  }
  const idle = probeFixture(); await assert.rejects(probeBash(idle.client, { assertCurrent: () => {}, timeoutMs: 10 })); assert.equal(idle.stream.closed, true);
  const cancelled = probeFixture(); const controller = new AbortController();
  const waiting = probeBash(cancelled.client, { signal: controller.signal, assertCurrent: () => {} }); const rejected = assert.rejects(waiting);
  controller.abort(); await rejected; await tick(); assert.equal(cancelled.stream.closed, true);
});
test('enhanced Bash launch quotes only its executable/owned rc path and loads bashrc without editing it', () => {
  assert.equal(bashStartupCommand('/bin/bash', "/home/a's file.bash"), "exec '/bin/bash' --rcfile '/home/a'\\''s file.bash' -i");
  const source = bashStartupScript('a'.repeat(64)); assert.match(source, /\. "\$HOME\/\.bashrc"/);
  assert.ok(source.indexOf('. "$HOME/.bashrc"') < source.indexOf('__awb_shell_nonce='));
  assert.doesNotMatch(source, /\.bash_profile|\.profile|>>.*bashrc/);
});
test('the actual fixed probe executes in isolated Bash without reading personal startup files', async t => {
  const executable = process.platform === 'win32' ? 'D:/AppStore/Git/bin/bash.exe' : '/bin/bash';
  if (!await fs.access(executable).then(() => true, () => false)) { t.skip('Isolated Bash unavailable'); return; }
  const client = { exec: (command, options, callback) => {
    assert.equal(options.pty, false);
    const child = spawn(executable, ['--noprofile', '--norc', '-c', command], { windowsHide: true,
      env: { ...process.env, SHELL: '/usr/bin/bash', BASH_ENV: '/dev/null', ENV: '/dev/null', INPUTRC: '/dev/null', HISTFILE: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const stream = new EventEmitter(); stream.stderr = new EventEmitter(); stream.end = () => {}; stream.close = () => { if (child.exitCode === null) child.kill(); };
    callback(null, stream); child.stdout.on('data', data => stream.emit('data', data)); child.stderr.on('data', data => stream.stderr.emit('data', data));
    child.on('error', error => stream.emit('error', error)); child.on('exit', code => { stream.emit('exit', code); stream.emit('close'); });
    t.after(() => { if (child.exitCode === null) child.kill(); });
  } };
  const result = await probeBash(client, { assertCurrent: () => {}, timeoutMs: 5000 });
  assert.ok(result.major >= 4); assert.ok(result.path.endsWith('/bash'));
});

async function autoFixture(t, { remember = true, probe = 'bash', denyWrite = false, acknowledge = true, launch = 'accept', holdOpen = false } = {}) {
  const execs = []; const stdin = []; const streams = []; const nonces = []; const commands = []; let server; let releaseLaunch; let releaseOpen;
  server = await startTestServer({ banner: false, onExec: async ({ accept, reject, info }) => {
    execs.push(info.command);
    if (info.command.startsWith('case ')) {
      if (probe === 'denied') { reject(); return; }
      const stream = accept(); stream.on('error', () => {});
      if (probe === 'bash') stream.write('AWB_BASH_V1\n/bin/bash\n5.3\n');
      stream.exit(probe === 'bash' ? 0 : 77); stream.end(); stream.close(); return;
    }
    const matched = /^exec '\/bin\/bash' --rcfile '([^']+)' -i$/.exec(info.command);
    if (!matched) { reject(); return; }
    if (launch === 'denied') { reject(); return; }
    if (launch === 'pending') { releaseLaunch = () => { const channel = accept(); channel.on('error', () => {}); return channel; }; return; }
    const stream = accept(); stream.on('error', () => {}); stream.on('data', bytes => stdin.push(Buffer.from(bytes)));
    streams.push(stream);
    const source = await fs.readFile(path.join(server.root, ...matched[1].split('/')), 'utf8');
    const nonce = /__awb_shell_nonce='([a-f0-9]{64})'/.exec(source)[1];
    nonces.push(nonce);
    if (acknowledge) stream.write(`\x1b]7777;AWB;${nonce};R\x07\x1b]7777;AWB;${nonce};A\x07$ \x1b]7777;AWB;${nonce};B\x07`);
  }, beforeRequest: async ({ name }) => {
    if (denyWrite && name === 'OPEN') throw Object.assign(new Error('fixture denied'), { code: 'EACCES' });
    if (holdOpen && name === 'OPEN') await new Promise(resolve => { releaseOpen = resolve; });
  } });
  const service = createSshSessionService({ createClient: () => new Client(),
    resolveProfile: async () => ({ host: server.host, port: server.port, username: server.username, password: server.password }),
    verifyHostKey: async () => true, shouldRememberCommands: () => remember, onShellCommand: value => commands.push(value),
    shellProbeTimeoutMs: 3000, shellIntegrationTimeoutMs: acknowledge ? 5000 : 1000, channelTimeoutMs: launch === 'pending' ? 500 : 15000, shellCleanupTimeoutMs: 1000 });
  t.after(async () => { await service.dispose(); await server.close(); });
  return { service, server, execs, stdin, streams, nonces, commands, releaseLaunch: () => releaseLaunch?.(), releaseOpen: () => releaseOpen?.() };
}
async function until(predicate) { const end = Date.now() + 4000; while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(predicate()); }
test('new remembered SSH terminal automatically starts enhanced Bash and never writes a source command to stdin', async t => {
  const h = await autoFixture(t); const host = await h.service.connect();
  let terminals = h.service.snapshot().sessions[0].terminals;
  assert.equal(terminals[0].status, 'ready'); assert.equal(terminals[0].shellIntegration.status, 'ready');
  assert.equal(h.server.shells.length, 0); assert.equal(h.execs.length, 2); assert.deepEqual(h.stdin, []);
  await h.service.openTerminal(host); terminals = h.service.snapshot().sessions[0].terminals;
  assert.equal(terminals.length, 2); assert.ok(terminals.every(item => item.shellIntegration.status === 'ready'));
  const event = (nonce, type, value = '') => `\x1b]7777;AWB;${nonce};${type}${value ? ';' + value : ''}\x07`;
  h.streams[0].write(event(h.nonces[1], 'C') + event(h.nonces[1], 'E', Buffer.from('wrong terminal').toString('hex')));
  h.streams[1].write(event(h.nonces[1], 'C') + event(h.nonces[1], 'E', Buffer.from('echo own').toString('hex')));
  await until(() => h.commands.length === 1); assert.equal(h.commands[0].command, 'echo own'); assert.equal(h.commands[0].terminalId, terminals[1].id);
  assert.equal((await fs.readdir(path.join(h.server.root, 'home', 'test'))).filter(name => name.startsWith('.adb-workbench-shell-')).length, 0);
});
test('paused history opens a normal shell without exec probes, SFTP scripts or hidden stdin writes', async t => {
  const h = await autoFixture(t, { remember: false }); await h.service.connect();
  assert.equal(h.server.shells.length, 1); assert.deepEqual(h.execs, []); assert.equal(h.server.requests.length, 0);
  assert.deepEqual(h.server.shells[0].received, []);
});
test('non-Bash, denied exec and nonwritable SFTP safely fall back to normal shell with an explanation', async t => {
  for (const options of [{ probe: 'other' }, { probe: 'denied' }, { denyWrite: true }, { launch: 'denied' }]) {
    await t.test(JSON.stringify(options), async subtest => {
      const h = await autoFixture(subtest, options); await h.service.connect();
      const terminal = h.service.snapshot().sessions[0].terminals[0];
      assert.equal(terminal.status, 'ready'); assert.notEqual(terminal.shellIntegration.status, 'ready');
      assert.ok(terminal.shellIntegration.error); assert.equal(h.server.shells.length, 1);
      assert.deepEqual(h.server.shells[0].received, []); assert.deepEqual(h.stdin, []);
    });
  }
});
test('an accepted enhanced PTY without markers is retained after timeout rather than launching a second shell', async t => {
  const h = await autoFixture(t, { acknowledge: false }); await h.service.connect();
  const terminal = h.service.snapshot().sessions[0].terminals[0];
  assert.equal(terminal.status, 'ready'); assert.equal(terminal.shellIntegration.status, 'error');
  assert.equal(h.execs.length, 2); assert.equal(h.server.shells.length, 0); assert.deepEqual(h.stdin, []);
  assert.equal((await fs.readdir(path.join(h.server.root, 'home', 'test'))).length, 0);
});
test('uncertain exec acknowledgement never starts a second shell and a late accepted channel is closed', async t => {
  const h = await autoFixture(t, { launch: 'pending' }); await h.service.connect();
  const terminal = h.service.snapshot().sessions[0].terminals[0];
  assert.equal(terminal.status, 'error'); assert.equal(h.server.shells.length, 0); assert.equal(h.execs.length, 2);
  let closed = false; const late = h.releaseLaunch(); late.on('close', () => { closed = true; }); late.resume();
  await until(() => closed);
  assert.equal((await fs.readdir(path.join(h.server.root, 'home', 'test'))).length, 0);
});
test('disconnect during automatic exclusive creation cleans only its owned script and never launches an interactive command', async t => {
  const h = await autoFixture(t, { holdOpen: true }); const connecting = h.service.connect(); const rejected = assert.rejects(connecting);
  await until(() => h.server.requests.some(request => request.name === 'OPEN'));
  const sessionId = h.service.snapshot().sessions[0].id; const closing = h.service.disconnect({ sessionId });
  h.releaseOpen(); await closing; await rejected;
  assert.equal(h.service.snapshot().sessions[0].status, 'disconnected'); assert.equal(h.execs.length, 1);
  assert.equal(h.server.shells.length, 0); assert.deepEqual(h.stdin, []);
  assert.equal((await fs.readdir(path.join(h.server.root, 'home', 'test'))).length, 0);
});
test('disconnect after enhanced PTY acceptance cancels marker initialization and cleans the script', async t => {
  const h = await autoFixture(t, { acknowledge: false }); const connecting = h.service.connect(); const rejected = assert.rejects(connecting);
  await until(() => h.streams.length === 1);
  const state = h.service.snapshot().sessions[0];
  await assert.rejects(h.service.terminalWrite({ sessionId: state.id, terminalId: state.terminals[0].id, content: 'not ready' }));
  await h.service.disconnect({ sessionId: state.id }); await rejected;
  assert.deepEqual(h.stdin, []); assert.equal(h.server.shells.length, 0);
  assert.equal((await fs.readdir(path.join(h.server.root, 'home', 'test'))).length, 0);
});
