const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const dgram = require('node:dgram');
const net = require('node:net');
const { createIpControlService } = require('../electron/lib/ip-control-service.cjs');

async function waitFor(check) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'network operation timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function clientFixture(t) {
  const sockets = [], history = [], status = [];
  const service = createIpControlService({
    onSuccessfulEndpoint: value => history.push(value), onStatusChange: value => status.push(value),
    createSocket() {
      const socket = Object.assign(new EventEmitter(), { connect() {}, destroy() { this.destroyed = true; },
        write(data, finish) { this.lastWrite = data; this.finish = finish; } });
      sockets.push(socket); return socket;
    }
  });
  t.after(() => service.dispose());
  async function connect() {
    const opening = service.connect({ host: '127.0.0.1', port: 8192 });
    const socket = sockets.at(-1); socket.emit('connect');
    const { sessionId } = await opening;
    return { socket, scope: { sessionId, recordEpoch: service.read().recordEpoch } };
  }
  return { service, sockets, status, history, connect };
}

test('export snapshots contain every retained byte, beyond both UI pages and AI samples', async t => {
  const { service, connect } = clientFixture(t), { socket, scope } = await connect();
  assert.equal(scope.recordEpoch, 0);
  for (let i = 0; i < 10005; i++) socket.emit('data', Buffer.of(i & 255));
  assert.equal(service.read().entries.length, 100); assert.equal(service.snapshotForAnalysis(scope.sessionId).entries.length, 2000);
  const result = service.snapshotForExport(scope); assert.equal(result.ok, true);
  const { entries, dropped, host, port, sessionId, mode } = result.snapshot;
  assert.equal(sessionId, scope.sessionId); assert.equal(mode, 'tcp-client'); assert.equal(host, '127.0.0.1'); assert.equal(port, 8192);
  assert.equal(entries.length, 10000); assert.equal(dropped, 5);
  assert.equal(entries[0].id, 6); assert.deepEqual(entries[0].data, Buffer.of(5)); assert.equal(entries[0].direction, 'RX');
  const last = entries.at(-1); assert.equal(last.id, 10005); assert.ok(!Object.hasOwn(last, 'hex'));
  last.data[0] = 0xff;
  assert.equal(service.read().entries.at(-1).hex, '14');
  socket.emit('data', Buffer.of(0x81)); service.disconnect(scope);
  assert.equal(entries.at(-1).id, 10005); assert.equal(entries.length, 10000);
  assert.equal(service.snapshotForExport(scope).snapshot.entries.at(-1).data[0], 0x81);
  assert.equal(service.clearRecords(scope).ok, true);
  assert.deepEqual(entries[0].data, Buffer.of(5));
});

test('clear strictly fences session and buffer generation while preserving the active socket and pending writes', async t => {
  const { service, sockets, connect, history, status } = clientFixture(t);
  assert.equal(service.snapshotForExport({ sessionId: '', recordEpoch: 0 }).code, 'STALE_SESSION');
  const { socket, scope } = await connect();
  assert.equal(service.clearRecords(scope).code, 'EMPTY_RECORDS');
  assert.equal(service.snapshotForExport(scope).code, 'EMPTY_RECORDS');
  socket.emit('data', Buffer.of(0x11));
  for (const invalid of [{ sessionId: scope.sessionId }, { ...scope, recordEpoch: '0' }, { ...scope, recordEpoch: -1 }]) {
    assert.equal(service.clearRecords(invalid).code, 'STALE_RECORDS'); assert.equal(service.snapshotForExport(invalid).code, 'STALE_RECORDS');
  }
  const writing = service.send({ sessionId: scope.sessionId, hex: 'AA FF' });
  const previousStatus = status.length;
  const reset = service.clearRecords(scope); assert.deepEqual(reset, { ok: true, recordEpoch: 1 });
  assert.equal(status.length, previousStatus); assert.equal(history.length, 1); assert.equal(sockets.length, 1); assert.ok(!socket.destroyed);
  const empty = service.read(); assert.equal(empty.sending, true); assert.equal(empty.status, 'connected');
  assert.deepEqual([empty.sessionId, empty.firstId, empty.lastId, empty.dropped], [scope.sessionId, 0, 0, 0]);
  socket.finish(); assert.ok((await writing).ok);
  socket.emit('data', Buffer.of(0xbb));
  const oldCursor = service.read({ ...scope, after: 1 });
  assert.equal(oldCursor.recordEpoch, 1); assert.deepEqual(oldCursor.entries.map(row => row.hex), ['AAFF', 'BB']);
  const next = { ...scope, recordEpoch: 1 };
  assert.equal(service.isRecordScopeCurrent(scope), false); assert.ok(service.isRecordScopeCurrent(next));
  assert.equal(service.clearRecords(scope).code, 'STALE_RECORDS');
  assert.equal(service.snapshotForExport(scope).code, 'STALE_RECORDS');
  assert.deepEqual(service.read({ ...next, after: 1 }).entries.map(row => row.hex), ['BB']);
  service.disconnect(scope); assert.ok(service.isRecordScopeCurrent(next));
  const replacement = await connect(); replacement.socket.emit('data', Buffer.of(0xcd));
  assert.equal(replacement.scope.recordEpoch, 0);
  assert.equal(service.clearRecords(next).code, 'STALE_SESSION');
  assert.equal(service.snapshotForExport(next).code, 'STALE_SESSION');
  assert.deepEqual(service.read().entries.map(row => row.hex), ['CD']);
  service.dispose(); assert.equal(service.isRecordScopeCurrent(replacement.scope), false);
});

test('clearing server records leaves the client attached; exported metadata stays with the original peer', { timeout: 10000 }, async t => {
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const service = createIpControlService(); t.after(() => service.dispose());
  const { sessionId } = await service.connect({ mode: 'tcp-server', host: '127.0.0.1', port });
  const peer = net.createConnection(port, '127.0.0.1'); t.after(() => peer.destroy()); await once(peer, 'connect');
  const frame = Buffer.from('fe09584248434d44020801cf', 'hex'); peer.write(frame);
  await waitFor(() => service.read().entries.length > 0);
  const scope = { sessionId, recordEpoch: 0 }, { snapshot } = service.snapshotForExport(scope);
  assert.equal(snapshot.mode, 'tcp-server'); assert.equal(snapshot.localPort, port);
  assert.deepEqual(Buffer.concat(snapshot.entries.map(row => row.data)), frame);
  const first = snapshot.entries[0]; assert.equal(first.peerPort, peer.localPort); assert.equal(first.peerHost, '127.0.0.1');
  assert.ok(service.clearRecords(scope).ok); assert.equal(service.read().peerId, first.peerId);
  peer.write(Buffer.of(0xf1)); await waitFor(() => service.read().entries.some(row => row.hex === 'F1'));
  assert.equal(service.read().status, 'connected'); assert.equal(service.read().entries[0].id, 1);
  peer.end(); await waitFor(() => service.read().status === 'listening');
  assert.equal(first.peerId.length > 0, true); assert.ok(first.peerPort > 0);
});

test('UDP zero-byte datagrams are legitimate export records and receiving continues after clear', { timeout: 10000 }, async t => {
  const peer = dgram.createSocket('udp4'); peer.bind(0, '127.0.0.1'); await once(peer, 'listening'); t.after(() => peer.close());
  const service = createIpControlService(); t.after(() => service.dispose());
  const { sessionId } = await service.connect({ mode: 'udp', host: '127.0.0.1', port: peer.address().port });
  const port = service.read().localPort;
  peer.send(Buffer.alloc(0), port, '127.0.0.1'); await waitFor(() => service.read().entries.length === 1);
  const scope = { sessionId, recordEpoch: 0 }, { snapshot } = service.snapshotForExport(scope);
  assert.equal(snapshot.mode, 'udp'); assert.deepEqual(snapshot.entries[0].data, Buffer.alloc(0));
  assert.ok(service.clearRecords(scope).ok); assert.equal(service.read().status, 'ready');
  peer.send(Buffer.of(0x00, 0xff), port, '127.0.0.1'); await waitFor(() => service.read().entries.length === 1);
  assert.equal(service.read().entries[0].hex, '00FF'); assert.equal(service.read().localPort, port);
});
