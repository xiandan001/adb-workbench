const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSshSessionService } = require('../electron/lib/ssh-session.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const HOST_KEY = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.alloc(32, 7)]);

class Channel extends EventEmitter {
  constructor(behavior = {}) { super(); this.behavior = behavior; this.stderr = new EventEmitter(); this.writes = []; this.windows = []; this.closed = false; }
  write(bytes, callback) { this.writes.push(Buffer.from(bytes)); this.finishWrite = callback; if (!this.behavior.manualWrite) queueMicrotask(() => callback(this.behavior.writeError)); return !this.behavior.backpressure; }
  setWindow(...args) { this.windows.push(args); }
  end() { this.endCalls = (this.endCalls || 0) + 1; }
  close() { if (this.closed) return; this.closed = true; queueMicrotask(() => this.emit('close')); }
  destroy() { this.close(); }
}

class Client extends EventEmitter {
  constructor(behavior = {}) { super(); this.behavior = behavior; this.channels = []; this.shellCalls = []; this.sftpCalls = 0; this.authAccepted = false; this.closed = false; }
  connect(config) {
    this.config = config;
    this.finishVerify = accepted => {
      this.authAccepted = accepted;
      if (!accepted) this.emit('error', Object.assign(new Error('host rejected'), { level: 'client-handshake' }));
      else if (this.behavior.authError) this.emit('error', Object.assign(new Error('secret-value private-key-content'), { level: 'client-authentication' }));
      else this.emit('ready');
    };
    queueMicrotask(() => config.hostVerifier(HOST_KEY, this.finishVerify));
    return this;
  }
  shell(window, callback) {
    this.shellCalls.push(window);
    const channel = new Channel(this.behavior.channel);
    this.channels.push(channel);
    this.finishShell = () => callback(this.behavior.shellError, channel);
    if (!this.behavior.manualShell) queueMicrotask(this.finishShell);
  }
  sftp(callback) {
    this.sftpCalls++;
    const channel = new Channel();
    this.sftpChannel = channel;
    this.finishSftp = () => callback(null, channel);
    if (!this.behavior.manualSftp) queueMicrotask(this.finishSftp);
  }
  setNoDelay(value) { this.noDelay = value; this.noDelayBeforeShell = this.shellCalls.length === 0; return this; }
  end() { this.endCalls = (this.endCalls || 0) + 1; if (!this.behavior.manualClose) queueMicrotask(() => this.destroy()); }
  destroy() { if (this.closed) return; this.closed = true; this.emit('close'); }
}

function fixture(t, options = {}) {
  const clients = [];
  const changes = [];
  const trust = [];
  const service = createSshSessionService({
    createClient: () => { const client = new Client(typeof options.behavior === 'function' ? options.behavior(clients.length) : options.behavior); clients.push(client); return client; },
    resolveProfile: options.resolveProfile || (async args => ({ name: args.name || 'Fixture', profileId: args.profileId || 'fixture', host: 'example.invalid', port: 22, username: 'tester', password: 'secret-value' })),
    verifyHostKey: async request => { trust.push(request); return options.verifyHostKey ? options.verifyHostKey(request) : true; },
    onChange: () => changes.push(service.snapshot()),
    connectTimeoutMs: 1000, channelTimeoutMs: 80, closeTimeoutMs: 20, writeTimeoutMs: 50
  });
  t.after(() => service.dispose());
  return { service, clients, changes, trust };
}

test('multiple hosts and PTYs have independent IDs, output and compact typed input', async t => {
  const { service, clients, trust } = fixture(t);
  const first = await service.connect({ profileId: 'one', cols: 90, rows: 25 });
  const second = await service.connect({ profileId: 'two' });
  assert.notEqual(first.sessionId, second.sessionId);
  const state = service.snapshot();
  assert.equal(state.sessions.length, 2);
  assert.ok(state.sessions.every(session => session.status === 'connected' && session.terminals.length === 1));
  const firstTerminal = state.sessions[0].terminals[0].id;
  const another = await service.openTerminal({ sessionId: first.sessionId, cols: 100, rows: 30 });
  clients[0].channels[0].emit('data', Buffer.from('hello\r\n'));
  clients[0].channels[0].stderr.emit('data', Buffer.from('error'));
  clients[0].channels[1].emit('data', Buffer.from('other PTY'));
  assert.equal(service.terminalRead({ sessionId: first.sessionId, terminalId: firstTerminal, offset: 0 }).hex, Buffer.from('hello\r\nerror').toString('hex'));
  assert.equal(service.terminalRead({ sessionId: first.sessionId, terminalId: another.terminalId, offset: 0 }).hex, Buffer.from('other PTY').toString('hex'));
  assert.deepEqual(await service.terminalWrite({ sessionId: first.sessionId, terminalId: firstTerminal, content: '\t\x1b[A\x03\r中' }), { bytes: 9 });
  assert.equal(clients[0].channels[0].writes[0].toString('hex'), Buffer.from('\t\x1b[A\x03\r中').toString('hex'));
  assert.equal(clients[1].channels[0].writes.length, 0);
  assert.match(trust[0].fingerprint, /^SHA256:[A-Za-z0-9+/]+$/);
  assert.equal(trust[0].keyType, 'ssh-ed25519');
  assert.doesNotMatch(JSON.stringify(state), /secret-value|private-key-content/);
});

test('host verification is mandatory and rejection cannot authenticate or expose credentials', async t => {
  const { service, clients } = fixture(t, { verifyHostKey: async () => false });
  await assert.rejects(service.connect({ profileId: 'one' }), /主机|指纹/);
  assert.equal(clients[0].authAccepted, false);
  assert.equal(clients[0].shellCalls.length, 0);
  assert.ok(service.snapshot().sessions.every(session => !JSON.stringify(session).includes('secret-value')));
});
test('SSH enables TCP no-delay before opening the first interactive shell', async t => {
  const { service, clients } = fixture(t); await service.connect();
  assert.equal(clients[0].noDelay, true); assert.equal(clients[0].noDelayBeforeShell, true);
});

test('cancelled host approval cannot authorize late authentication', async t => {
  const approval = deferred();
  const { service, clients, trust } = fixture(t, { verifyHostKey: () => approval.promise });
  const connecting = service.connect({ profileId: 'one' });
  const rejection = assert.rejects(connecting, /取消|断开/);
  await delay(1);
  const sessionId = service.snapshot().sessions[0].id;
  await service.disconnect({ sessionId });
  approval.resolve(true);
  await rejection; await delay(1);
  assert.equal(trust[0].signal.aborted, true);
  assert.equal(clients[0].authAccepted, false);
  assert.equal(clients[0].shellCalls.length, 0);
});

test('cancelling profile resolution never creates or connects a late client', async t => {
  const profile = deferred();
  const { service, clients } = fixture(t, { resolveProfile: () => profile.promise });
  const connecting = service.connect({ profileId: 'one' });
  const rejected = assert.rejects(connecting, /取消|断开/);
  await service.disconnect({ sessionId: service.snapshot().sessions[0].id });
  profile.resolve({ host: 'example.invalid', port: 22, username: 'tester', password: 'secret-value' });
  await rejected; await delay(1);
  assert.equal(clients.length, 0);
});

test('SFTP acquisition is lazy, cached and channel closure does not close shell or host', async t => {
  const { service, clients } = fixture(t);
  const { sessionId } = await service.connect({ profileId: 'one' });
  assert.equal(clients[0].sftpCalls, 0);
  const [first, second] = await Promise.all([service.getSftp(sessionId), service.getSftp(sessionId)]);
  assert.equal(first, second);
  assert.equal(clients[0].sftpCalls, 1);
  first.emit('close');
  assert.equal(service.snapshot().sessions[0].status, 'connected');
  assert.equal(clients[0].channels[0].closed, false);
  assert.notEqual(await service.getSftp(sessionId), first);
  assert.equal(clients[0].sftpCalls, 2);
});

test('late SFTP and shell callbacks after disconnect are closed and cannot revive old state', async t => {
  const { service, clients } = fixture(t);
  const { sessionId } = await service.connect({ profileId: 'one' });
  clients[0].behavior.manualSftp = true;
  clients[0].behavior.manualShell = true;
  const sftp = service.getSftp(sessionId);
  const sftpRejected = assert.rejects(sftp, /断开|会话/);
  const shell = service.openTerminal({ sessionId });
  const shellRejected = assert.rejects(shell, /断开|会话/);
  const context = service.getSessionContext(sessionId);
  await service.disconnect({ sessionId });
  clients[0].finishSftp(); clients[0].finishShell();
  await Promise.all([sftpRejected, shellRejected]); await delay(1);
  assert.equal(clients[0].sftpChannel.closed, true);
  assert.equal(clients[0].channels[1].closed, true);
  assert.equal(context.signal.aborted, true);
  assert.throws(context.assertCurrent, /断开|会话/);
  assert.equal(service.snapshot().sessions[0].status, 'disconnected');
});

test('PTY resize validates bounds, preserves row/column order and remains session scoped', async t => {
  const { service, clients } = fixture(t);
  const { sessionId } = await service.connect({ profileId: 'one' });
  const terminalId = service.snapshot().sessions[0].terminals[0].id;
  await service.terminalResize({ sessionId, terminalId, cols: 120, rows: 35 });
  assert.deepEqual(clients[0].channels[0].windows.at(-1), [35, 120, 0, 0]);
  await assert.rejects(service.terminalResize({ sessionId, terminalId, cols: 0, rows: 35 }), /尺寸|列|行/);
  await assert.rejects(service.terminalWrite({ sessionId: 'other', terminalId, content: 'x' }), /会话/);
  assert.equal(clients[0].channels[0].writes.length, 0);
});

test('terminal writes wait for callback and drain, keep FIFO and reject overflow before writing', async t => {
  const { service, clients } = fixture(t, { behavior: { channel: { backpressure: true, manualWrite: true } } });
  const { sessionId } = await service.connect({ profileId: 'one' });
  const terminalId = service.snapshot().sessions[0].terminals[0].id;
  const channel = clients[0].channels[0];
  const first = service.terminalWrite({ sessionId, terminalId, content: 'a' });
  const second = service.terminalWrite({ sessionId, terminalId, content: 'b' });
  await delay(1); assert.equal(channel.writes.length, 1);
  channel.finishWrite(); await delay(1); assert.equal(channel.writes.length, 1);
  channel.emit('drain'); assert.deepEqual(await first, { bytes: 1 });
  await delay(1); assert.equal(channel.writes.length, 2);
  channel.finishWrite(); channel.emit('drain'); assert.deepEqual(await second, { bytes: 1 });
  const held = service.terminalWrite({ sessionId, terminalId, content: 'x'.repeat(65536) }).catch(error => error);
  await assert.rejects(service.terminalWrite({ sessionId, terminalId, content: 'z' }), /队列/);
  await service.closeTerminal({ sessionId, terminalId });
  assert.ok(await held instanceof Error);
});

test('closing one PTY does not affect sibling terminals or host SFTP access', async t => {
  const { service, clients } = fixture(t);
  const { sessionId } = await service.connect({ profileId: 'one' });
  const firstId = service.snapshot().sessions[0].terminals[0].id;
  const second = await service.openTerminal({ sessionId });
  await service.closeTerminal({ sessionId, terminalId: firstId });
  assert.equal(clients[0].channels[0].closed, true);
  assert.equal(clients[0].channels[1].closed, false);
  assert.equal(service.snapshot().sessions[0].terminals.length, 1);
  assert.equal(service.snapshot().sessions[0].terminals[0].id, second.terminalId);
  assert.ok(await service.getSftp(sessionId));
});

test('shell denial leaves authenticated host usable for SFTP and sanitizes errors', async t => {
  const { service } = fixture(t, { behavior: { shellError: new Error('secret-value private-key-content') } });
  const { sessionId } = await service.connect({ profileId: 'one' });
  const host = service.snapshot().sessions[0];
  assert.equal(host.status, 'connected');
  assert.equal(host.terminals[0].status, 'error');
  assert.doesNotMatch(JSON.stringify(host), /secret-value|private-key-content/);
  assert.ok(await service.getSftp(sessionId));
});

test('disconnected history remains readable until an explicit closed-session removal', async t => {
  const { service, clients } = fixture(t);
  const { sessionId } = await service.connect({ profileId: 'one' });
  const terminalId = service.snapshot().sessions[0].terminals[0].id;
  clients[0].channels[0].emit('data', Buffer.from('kept'));
  await assert.rejects(service.removeSession({ sessionId }), /断开/);
  await service.disconnect({ sessionId });
  assert.equal(service.terminalRead({ sessionId, terminalId, offset: 0 }).hex, '6b657074');
  assert.equal(service.needsQuitConfirmation(), false);
  await service.removeSession({ sessionId });
  assert.equal(service.snapshot().sessions.length, 0);
});

test('explicit PTY limits reject extra channels and allow closed tab removal', async t => {
  const { service, clients } = fixture(t);
  const { sessionId } = await service.connect({ profileId: 'one' });
  for (let index = 1; index < 16; index++) await service.openTerminal({ sessionId });
  await assert.rejects(service.openTerminal({ sessionId }), /16/);
  assert.equal(clients[0].shellCalls.length, 16);
  const firstId = service.snapshot().sessions[0].terminals[0].id;
  clients[0].channels[0].emit('close');
  await service.closeTerminal({ sessionId, terminalId: firstId });
  await service.openTerminal({ sessionId });
  assert.equal(service.snapshot().sessions[0].terminals.length, 16);
});

test('closing a PTY cancels all queued input and a late write cannot leak into its sibling', async t => {
  const { service, clients } = fixture(t, { behavior: { channel: { manualWrite: true } } });
  const { sessionId } = await service.connect({ profileId: 'one' });
  const terminalId = service.snapshot().sessions[0].terminals[0].id;
  const sibling = await service.openTerminal({ sessionId });
  const pending = ['a', 'b', 'c'].map(content => service.terminalWrite({ sessionId, terminalId, content }).catch(error => error));
  await service.closeTerminal({ sessionId, terminalId });
  assert.ok((await Promise.all(pending)).every(result => result instanceof Error));
  clients[0].channels[0].finishWrite();
  assert.equal(clients[0].channels[0].writes.length, 1);
  assert.equal(clients[0].channels[1].writes.length, 0);
  assert.equal(service.snapshot().sessions[0].terminals[0].id, sibling.terminalId);
});

test('native terminal failure rejects its queue with sanitized errors but leaves sibling SFTP usable', async t => {
  const { service, clients } = fixture(t, { behavior: { channel: { writeError: new Error('secret-value private-key-content') } } });
  const { sessionId } = await service.connect({ profileId: 'one' });
  const terminalId = service.snapshot().sessions[0].terminals[0].id;
  const results = await Promise.all(['a', 'b'].map(content => service.terminalWrite({ sessionId, terminalId, content }).catch(error => error)));
  assert.ok(results.every(result => result instanceof Error));
  assert.doesNotMatch(results.map(result => result.message).join(''), /secret-value|private-key-content/);
  assert.equal(clients[0].channels[0].writes.length, 1);
  assert.equal(service.snapshot().sessions[0].status, 'connected');
  assert.ok(await service.getSftp(sessionId));
});

test('verified SSH rekey does not demote a connected host or create another automatic PTY', async t => {
  const { service, clients } = fixture(t);
  await service.connect({ profileId: 'one' });
  const result = deferred();
  clients[0].config.hostVerifier(HOST_KEY, accepted => result.resolve(accepted));
  assert.equal(await result.promise, true);
  assert.equal(service.snapshot().sessions[0].status, 'connected');
  clients[0].emit('ready');
  assert.equal(clients[0].shellCalls.length, 1);
});

test('authentication errors are redacted while trusted main host-key change messages remain actionable', async t => {
  const first = fixture(t, { behavior: { authError: true } });
  await assert.rejects(first.service.connect({ profileId: 'one' }), error => error.code === 'SSH_AUTH_FAILED' && !/secret-value/.test(error.message));
  assert.doesNotMatch(JSON.stringify(first.service.snapshot()), /secret-value|private-key-content/);
  const second = fixture(t, { verifyHostKey: () => { throw Object.assign(new Error('SSH 主机指纹已变化，请核验服务器'), { code: 'SSH_HOST_KEY_CHANGED' }); } });
  await assert.rejects(second.service.connect({ profileId: 'one' }), /主机指纹已变化/);
  assert.equal(second.clients[0].authAccepted, false);
});

test('natural host end aborts its session operations and preserves terminal history', async t => {
  const { service, clients } = fixture(t);
  const { sessionId } = await service.connect({ profileId: 'one' });
  const terminalId = service.snapshot().sessions[0].terminals[0].id;
  const context = service.getSessionContext(sessionId);
  clients[0].channels[0].emit('data', Buffer.from('history'));
  clients[0].emit('end');
  assert.equal(context.signal.aborted, true);
  assert.equal(service.snapshot().sessions[0].status, 'disconnected');
  assert.equal(service.terminalRead({ sessionId, terminalId, offset: 0 }).hex, '686973746f7279');
  assert.equal(service.needsQuitConfirmation(), false);
});

test('active host limit is independent of retained disconnected history', async t => {
  const { service, clients } = fixture(t);
  for (let index = 0; index < 16; index++) await service.connect({ profileId: 'host-' + index });
  await assert.rejects(service.connect({ profileId: 'too-many' }), /16/);
  assert.equal(clients.length, 16);
  const closedId = service.snapshot().sessions[0].id;
  await service.disconnect({ sessionId: closedId });
  await service.connect({ profileId: 'replacement' });
  assert.equal(service.snapshot().sessions.length, 17);
  assert.equal(service.snapshot().sessions.filter(session => session.status === 'connected').length, 16);
  assert.equal(service.snapshot().sessions.find(session => session.id === closedId).status, 'disconnected');
});

test('closed host history has a finite cap and only explicit removal makes new room', async t => {
  const { service } = fixture(t);
  for (let index = 0; index < 64; index++) {
    const result = await service.connect({ profileId: 'history-' + index });
    await service.disconnect(result);
  }
  await assert.rejects(service.connect({ profileId: 'too-many' }), /64/);
  const retainedId = service.snapshot().sessions[0].id;
  await service.removeSession({ sessionId: retainedId });
  await service.connect({ profileId: 'now-allowed' });
  assert.equal(service.snapshot().sessions.length, 64);
});

test('terminal write timeout stops only its channel and never replays a queued suffix', async t => {
  const { service, clients } = fixture(t, { behavior: { channel: { manualWrite: true } } });
  const { sessionId } = await service.connect({ profileId: 'one' });
  const firstId = service.snapshot().sessions[0].terminals[0].id;
  const second = await service.openTerminal({ sessionId });
  const result = await Promise.all(['a', 'b'].map(content => service.terminalWrite({ sessionId, terminalId: firstId, content }).catch(error => error)));
  assert.ok(result.every(error => error instanceof Error));
  clients[0].channels[0].finishWrite();
  assert.equal(clients[0].channels[0].writes.length, 1);
  assert.equal(service.snapshot().sessions[0].status, 'connected');
  assert.equal(service.snapshot().sessions[0].terminals.find(terminal => terminal.id === second.terminalId).status, 'ready');
});

test('terminal raw ring stays bounded and reports byte offsets with both session and terminal IDs', async t => {
  const { service, clients } = fixture(t);
  const { sessionId } = await service.connect({ profileId: 'one' });
  const terminalId = service.snapshot().sessions[0].terminals[0].id;
  clients[0].channels[0].emit('data', Buffer.alloc(300 * 1024, 0x41));
  const read = service.terminalRead({ sessionId, terminalId, offset: 0 });
  assert.equal(read.sessionId, sessionId); assert.equal(read.terminalId, terminalId);
  assert.equal(read.truncated, true);
  assert.equal(read.startOffset, 44 * 1024);
  assert.equal(read.endOffset, 300 * 1024);
  assert.equal(read.hex.length, 128 * 1024);
  assert.throws(() => service.terminalRead({ sessionId, terminalId, offset: read.endOffset + 1 }), /位置/);
});
