const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, createPrivateKey } = require('node:crypto');
const { Client } = require('ssh2');
const { createSshSessionService } = require('../electron/lib/ssh-session.cjs');
const { startTestServer } = require('./helpers/ssh-test-server.cjs');

const waitFor = async (predicate, message, timeout = 5000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(message);
};
const invoke = (owner, method, ...args) => new Promise((resolve, reject) => owner[method](...args, (error, result) => error ? reject(error) : resolve(result)));

async function harness(t, definitions, { verifyHostKey = async () => true } = {}) {
  const servers = [];
  let service;
  t.after(async () => { await service?.dispose(); await Promise.all(servers.map(server => server.close())); });
  for (const options of definitions) servers.push(await startTestServer({ banner: false, ...options }));
  service = createSshSessionService({ createClient: () => new Client(),
    resolveProfile: async args => {
      const server = servers[args.server];
      return { host: server.host, port: server.port, username: server.username, name: 'Loopback ' + args.server,
        ...(args.auth || { password: server.password }) };
    }, verifyHostKey, connectTimeoutMs: 5000, channelTimeoutMs: 5000, closeTimeoutMs: 1000, writeTimeoutMs: 5000 });
  return { service, servers };
}

test('real loopback SSH isolates concurrent hosts and PTYs, controls, UTF-8 and resizing', { timeout: 20000 }, async t => {
  const { service, servers } = await harness(t, [{}, {}]);
  const [first, second] = await Promise.all([service.connect({ server: 0, cols: 91, rows: 26 }), service.connect({ server: 1 })]);
  const firstTerminal = service.snapshot().sessions.find(session => session.id === first.sessionId).terminals[0].id;
  const secondTerminal = service.snapshot().sessions.find(session => session.id === second.sessionId).terminals[0].id;
  const extra = await service.openTerminal({ sessionId: first.sessionId, cols: 120, rows: 35 });
  assert.equal(servers[0].shells.length, 2); assert.equal(servers[1].shells.length, 1);
  const payloads = ['host-A\t\x1b[A\x03\r\n中文', 'PTY-two\r', 'host-B\n'];
  await Promise.all([
    service.terminalWrite({ sessionId: first.sessionId, terminalId: firstTerminal, content: payloads[0] }),
    service.terminalWrite({ sessionId: first.sessionId, terminalId: extra.terminalId, content: payloads[1] }),
    service.terminalWrite({ sessionId: second.sessionId, terminalId: secondTerminal, content: payloads[2] })
  ]);
  await waitFor(() => servers[0].shells.every(shell => shell.received.length) && servers[1].shells[0].received.length, 'loopback shells did not receive input');
  assert.equal(Buffer.concat(servers[0].shells[0].received).toString('utf8'), payloads[0]);
  assert.equal(Buffer.concat(servers[0].shells[1].received).toString('utf8'), payloads[1]);
  assert.equal(Buffer.concat(servers[1].shells[0].received).toString('utf8'), payloads[2]);
  await waitFor(() => service.terminalRead({ sessionId: first.sessionId, terminalId: firstTerminal, offset: 0 }).hex.length === Buffer.byteLength(payloads[0]) * 2, 'host-A echo was not captured');
  assert.equal(service.terminalRead({ sessionId: first.sessionId, terminalId: firstTerminal, offset: 0 }).hex, Buffer.from(payloads[0]).toString('hex'));
  await service.terminalResize({ sessionId: first.sessionId, terminalId: extra.terminalId, cols: 132, rows: 42 });
  await waitFor(() => servers[0].shells[1].pty.cols === 132 && servers[0].shells[1].pty.rows === 42, 'window-change did not reach the selected PTY');
  assert.equal(servers[0].shells[0].pty.cols, 91);
  await service.closeTerminal({ sessionId: first.sessionId, terminalId: extra.terminalId });
  await waitFor(() => servers[0].shells[1].closed, 'closing one PTY did not close its channel');
  assert.equal(servers[0].shells[0].closed, false);
  assert.equal(await invoke(await service.getSftp(first.sessionId), 'realpath', '.'), '/home/test');
  await service.disconnect(first);
  assert.equal(service.snapshot().sessions.find(session => session.id === second.sessionId).status, 'connected');
  assert.deepEqual(await service.terminalWrite({ sessionId: second.sessionId, terminalId: secondTerminal, content: 'still-open' }), { bytes: 10 });
});

test('real loopback encrypted private-key authentication stays main-only and password failure is sanitized', { timeout: 20000 }, async t => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const passphrase = 'ephemeral-fixture-passphrase';
  const encrypted = createPrivateKey(pair.privateKey).export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase });
  const { service } = await harness(t, [{ passwordAuth: false, authorizedKeys: [pair.privateKey] }]);
  const { sessionId } = await service.connect({ server: 0, auth: { privateKey: encrypted, passphrase } });
  const terminalId = service.snapshot().sessions.find(session => session.id === sessionId).terminals[0].id;
  assert.deepEqual(await service.terminalWrite({ sessionId, terminalId, content: 'key-auth\r' }), { bytes: 9 });
  assert.doesNotMatch(JSON.stringify(service.snapshot()), /BEGIN RSA|ephemeral-fixture-passphrase|PRIVATE KEY/);
  await assert.rejects(service.connect({ server: 0, auth: { password: 'never-log-this-password' } }), error => {
    assert.equal(error.code, 'SSH_AUTH_FAILED');
    assert.doesNotMatch(error.message, /never-log-this-password/); return true;
  });
  assert.equal(service.snapshot().sessions.find(session => session.id === sessionId).status, 'connected');
});

test('real loopback rejects untrusted host keys before opening shell or SFTP channels', { timeout: 15000 }, async t => {
  const { service, servers } = await harness(t, [{}], { verifyHostKey: async challenge => {
    assert.equal(challenge.host, '127.0.0.1'); assert.match(challenge.fingerprint, /^SHA256:/); return false;
  } });
  await assert.rejects(service.connect({ server: 0 }), /指纹/);
  assert.equal(servers[0].shells.length, 0);
  assert.equal(servers[0].requests.length, 0);
  assert.equal(service.needsQuitConfirmation(), false);
});

test('real loopback SFTP close is channel-local and remote host loss preserves history and rejects stale operations', { timeout: 15000 }, async t => {
  const { service, servers } = await harness(t, [{}]);
  const { sessionId } = await service.connect({ server: 0 });
  const terminalId = service.snapshot().sessions[0].terminals[0].id;
  const channel = await service.getSftp(sessionId);
  assert.equal(await invoke(channel, 'realpath', '.'), '/home/test');
  servers[0].closeSftp();
  await waitFor(() => channel.readable === false || channel.outgoing.state === 'closed', 'SFTP channel was not closed');
  const next = await service.getSftp(sessionId);
  assert.notEqual(next, channel);
  assert.equal(await invoke(next, 'realpath', '.'), '/home/test');
  await service.terminalWrite({ sessionId, terminalId, content: 'retained\r' });
  await waitFor(() => service.terminalRead({ sessionId, terminalId, offset: 0 }).hex.length > 0, 'shell output was not captured');
  const before = service.terminalRead({ sessionId, terminalId, offset: 0 }).hex;
  const context = service.getSessionContext(sessionId);
  servers[0].disconnectClient();
  await waitFor(() => context.signal.aborted, 'remote close did not cancel the session context');
  assert.equal(service.terminalRead({ sessionId, terminalId, offset: 0 }).hex, before);
  await assert.rejects(service.terminalWrite({ sessionId, terminalId, content: 'stale' }), /会话|断开/);
  await assert.rejects(service.getSftp(sessionId), /会话|断开/);
});
