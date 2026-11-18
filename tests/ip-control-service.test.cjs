const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const dgram = require('node:dgram');
const { EventEmitter, once } = require('node:events');
const { createIpControlService } = require('../electron/lib/ip-control-service.cjs');

test('raw TCP client exchanges exact HEX bytes with a real loopback peer without adding a line ending', async t => {
  const service = createIpControlService(), peers = new Set();
  const server = net.createServer(socket => {
    peers.add(socket); socket.on('close', () => peers.delete(socket));
    socket.on('data', data => { socket.write(data); });
  });
  t.after(async () => { service.dispose(); for (const peer of peers) peer.destroy(); await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const opened = await service.connect({ host: '127.0.0.1', port: server.address().port });
  assert.equal(opened.ok, true); const {sessionId} = service.read(); assert.ok(sessionId);
  assert.deepEqual(await service.send({sessionId, hex: '00 FF\n0d0A 80'}), {ok: true});
  await until(() => service.read().entries.some(row => row.direction === 'RX'));
  const entries = service.read().entries;
  for (const direction of ['TX','RX']) assert.equal(entries.filter(row => row.direction === direction).map(row => row.hex).join(''), '00FF0D0A80');
  assert.deepEqual(service.disconnect({sessionId}), {ok:true});
  assert.equal(service.read().status, 'idle'); assert.equal(service.read().entries.length, entries.length);
});

async function until(check) {
  const deadline = Date.now() + 4000;
  while (!check()) { assert.ok(Date.now() < deadline, 'operation timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function fixture(options = {}) {
  const sockets = [], service = createIpControlService({ ...options, createSocket: () => {
    const socket = Object.assign(new EventEmitter(), { connect() {}, write(bytes, cb) { this.bytes = bytes; this.finishWrite = cb; }, destroy() { this.destroyed = true; } });
    sockets.push(socket); return socket;
  }});
  const start = () => service.connect({host:'127.0.0.1', port:8192});
  return { sockets, service, start };
}

test('rejects non-IP, invalid ports and malformed HEX before doing I/O', async t => {
  const { sockets, service, start } = fixture(); t.after(service.dispose);
  for (const host of ['not-a-host', '256.0.0.1', '', '/tmp/socket', null])
    assert.equal((await service.connect({host,port:8192})).code, 'INVALID_IP');
  for (const port of [0,65536,1.5,'12x',null])
    assert.equal((await service.connect({host:'::1',port})).code, 'INVALID_PORT');
  assert.equal(sockets.length, 0); const connecting = start(); sockets[0].emit('connect'); await connecting;
  const {sessionId} = service.read();
  for (const hex of ['', '   ', '0 1', 'AAB', '00 0xAA', 'AB CD ?!', 5])
    assert.equal((await service.send({sessionId,hex})).code, 'INVALID_HEX');
  assert.equal((await service.send({sessionId,hex:'FF'.repeat(65537)})).code, 'SEND_TOO_LARGE');
  assert.equal(sockets[0].bytes, undefined); assert.deepEqual(service.read().entries, []);
});

test('analysis snapshot stays bound to its session, includes only complete recent records and performs no I/O', async t => {
  const { sockets, service, start } = fixture(); t.after(service.dispose);
  const connecting = start(); sockets[0].emit('connect'); const { sessionId } = await connecting;
  const data = Buffer.from([0x00, 0xff, 0xfe]);
  for (let i = 0; i < 10001; i++) sockets[0].emit('data', data);
  assert.equal(service.snapshotForAnalysis('other'), null);
  service.disconnect({sessionId});
  const snapshot = service.snapshotForAnalysis(sessionId);
  assert.equal(snapshot.mode, 'tcp-client'); assert.equal(snapshot.entries.length, 2000);
  assert.equal(snapshot.lastId, 10001); assert.equal(snapshot.dropped, 1);
  assert.equal(snapshot.entries[0].id, 8002); assert.equal(snapshot.entries.at(-1).hex, '00FFFE');
  snapshot.entries.at(-1).hex = '1'; assert.equal(service.read().entries.at(-1).hex, '00FFFE');
  assert.equal(sockets.length, 1); assert.equal(sockets[0].bytes, undefined);
  const next = start(); sockets[1].emit('connect'); await next;
  assert.equal(service.snapshotForAnalysis(sessionId), null);
});

test('cancel, reconnect and ignore stale socket events, send and disconnect actions', async t => {
  const { sockets, service, start } = fixture(); t.after(service.dispose);
  const first = start(), a = service.read().sessionId;
  assert.equal((await start()).code, 'CONNECT_BUSY');
  assert.equal(service.disconnect({sessionId:a}).ok, true); assert.equal((await first).code, 'CANCELLED');
  const second = start(), b = service.read().sessionId; assert.notEqual(a,b);
  sockets[0].emit('data', Buffer.from([1])); sockets[0].emit('error', new Error('old')); sockets[0].emit('close');
  assert.equal(service.read().status, 'connecting'); sockets[1].emit('connect'); assert.equal((await second).ok,true);
  assert.equal((await service.send({sessionId:a,hex:'AA'})).code,'STALE_SESSION');
  assert.equal(service.disconnect({sessionId:a}).code,'STALE_SESSION');
  const send = service.send({sessionId:b,hex:'00'});
  assert.equal((await service.send({sessionId:b,hex:'01'})).code,'SEND_BUSY');
  service.disconnect({sessionId:b}); assert.equal((await send).code,'CANCELLED');
  sockets[1].finishWrite(); assert.deepEqual(service.read().entries, []);
});

test('bounded connect and write deadlines, useful network errors and mid-session close', async () => {
  const { sockets, service, start } = fixture({ connectTimeoutMs: 10, writeTimeoutMs: 10 });
  try {
    assert.equal((await start()).code, 'TIMEOUT'); assert.ok(sockets[0].destroyed);
    for (const [raw, wanted] of [['ECONNREFUSED','REFUSED'],['ENETUNREACH','UNREACHABLE'],['ECONNRESET','RESET'],['ETIMEDOUT','TIMEOUT']]) {
      const attempt = start(); sockets.at(-1).emit('error', Object.assign(new Error('internal'), {code:raw}));
      assert.equal((await attempt).code, wanted); assert.equal(service.read().code, wanted);
    }
    const success = start(); sockets.at(-1).emit('connect'); await success;
    assert.equal((await service.send({sessionId:service.read().sessionId, hex:'00'})).code, 'TIMEOUT');
    const next = start(); sockets.at(-1).emit('connect'); await next; sockets.at(-1).emit('end');
    assert.equal(service.read().code,'REMOTE_CLOSED'); assert.equal(service.read().status,'error');
  } finally { service.dispose(); }
  assert.equal((await start()).code,'DISPOSED');
});

test('paged reads stay bounded for coalesced RX and report omissions and retention limits', async t => {
  const { sockets, service, start } = fixture(); t.after(service.dispose);
  const joined = start(); sockets[0].emit('connect'); await joined;
  const payload = Buffer.alloc(140000, 0x81); sockets[0].emit('data', payload);
  let cursor = 0; const recovered = [];
  do {
    const page = service.read({after:cursor}); const hex = page.entries.map(entry => entry.hex).join('');
    assert.ok(hex.length <= 131072); assert.ok(page.entries.length <= 100); assert.equal(page.omitted,0); recovered.push(hex);
    cursor = page.nextAfter; if (!page.hasMore) break;
  } while (true);
  assert.ok(Buffer.from(recovered.join(''), 'hex').equals(payload));
  for (let n=0;n<10120;n++) sockets[0].emit('data',Buffer.from([n & 255]));
  const tail = service.read(); assert.equal(tail.entries.length,100); assert.ok(tail.dropped >= 120);
  assert.ok(tail.lastId - tail.firstId + 1 <= 10000); assert.ok(tail.omitted > 0);
  const head = service.read({after:0}); assert.equal(head.omitted,tail.dropped); assert.equal(head.hasMore,true);
  assert.equal(service.read({after:-1}).code, 'INVALID_CURSOR');
});

test('4 MiB retention budget bounds large reads independently of record count; stale cursor returns only current session', async t => {
  const { sockets, service, start } = fixture(); t.after(service.dispose);
  const first = start(); sockets[0].emit('connect'); await first;
  const a = service.read().sessionId;
  for (let i=0; i<5; i++) sockets[0].emit('data', Buffer.alloc(1024 * 1024, i + 1));
  const page = service.read({after:0, sessionId:a});
  assert.equal(page.dropped,256); assert.equal(page.entries[0].id,257); assert.equal(page.entries[0].hex.slice(0,2),'02');
  assert.equal(page.entries.map(row => row.hex).join('').length / 2,65536);
  service.disconnect({sessionId:a}); const second = start(); sockets[1].emit('connect'); await second;
  for (let i=0;i<10;i++) sockets[1].emit('data', Buffer.of(i));
  assert.equal(service.read({after:6,sessionId:a}).entries[0].hex, '00');
  assert.equal(service.read({after:6,sessionId:service.read().sessionId}).entries[0].hex, '06');
});

test('accepts a full 64 KiB write and no extra bytes; socket refusal has an explicit retryable code', async t => {
  const { sockets, service, start } = fixture(); t.after(service.dispose);
  const first = start(); sockets[0].emit('connect'); await first;
  const hex = 'ff'.repeat(65536), write = service.send({sessionId:service.read().sessionId, hex});
  assert.equal(sockets[0].bytes.length, 65536); sockets[0].finishWrite(); assert.equal((await write).ok,true);
  assert.equal(service.read().entries.map(row => row.hex).join(''), hex.toUpperCase());
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server,'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  const actual = createIpControlService(); t.after(actual.dispose);
  const failure = await actual.connect({host:'127.0.0.1',port});
  assert.equal(failure.code, 'REFUSED'); assert.equal(actual.read().status, 'error');
});

async function unusedTcpPort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

test('TCP Server accepts one explicit peer, preserves wire bytes and keeps the listener for a replacement peer', {timeout: 10000}, async t => {
  const remembered = [], svc = createIpControlService({onSuccessfulEndpoint:value=>remembered.push(value)}); t.after(svc.dispose);
  const port = await unusedTcpPort();
  const { sessionId } = await svc.connect({ mode:'tcp-server', host:'127.0.0.1', port });
  assert.ok(sessionId); assert.equal(svc.read().localPort,port); assert.equal(svc.read().status,'listening');
  assert.deepEqual(remembered, []);
  assert.equal((await svc.send({sessionId,hex:'00'})).code,'NO_PEER');
  const client = net.createConnection(port,'127.0.0.1'); t.after(() => client.destroy()); await once(client,'connect');
  await until(() => svc.read().status === 'connected');
  const { peerId, peerHost, peerPort } = svc.read(); assert.ok(peerId); assert.equal(peerHost,'127.0.0.1'); assert.equal(peerPort,client.localPort);
  const competing = net.createConnection(port,'127.0.0.1'); t.after(() => competing.destroy()); await once(competing, 'close');
  assert.equal(svc.read().peerId,peerId);
  client.write(Buffer.from('00ff0d0a80','hex')); await until(() => svc.read().entries.length === 1);
  assert.equal(svc.read().entries[0].hex,'00FF0D0A80');
  assert.equal(svc.read().entries[0].peerPort,peerPort);
  const data = once(client, 'data'); assert.equal((await svc.send({sessionId,peerId,hex:'FF 00 80'})).ok,true); assert.equal((await data)[0].toString('hex'),'ff0080');
  client.end(); await until(() => svc.read().status === 'listening');
  const next = net.createConnection(port,'127.0.0.1'); t.after(() => next.destroy()); await once(next,'connect');
  await until(() => svc.read().status === 'connected');
  assert.notEqual(svc.read().peerId,peerId); assert.equal((await svc.send({sessionId,peerId,hex:'bad0'})).code,'STALE_PEER');
  assert.deepEqual(remembered, [{mode:'tcp-server',host:'127.0.0.1',port}]);
  assert.equal(svc.read().entries.length,2); assert.ok(svc.read().entries.every(item=>item.peerId===peerId));
  assert.ok(svc.disconnect({sessionId}).ok);
});

test('UDP keeps datagram boundaries and receives only the configured peer including binary and empty datagrams', {timeout: 10000}, async t => {
  const remembered = [], svc = createIpControlService({onSuccessfulEndpoint:value=>remembered.push(value)}); t.after(svc.dispose);
  const target = dgram.createSocket('udp4'), other = dgram.createSocket('udp4');
  for (const sock of [target,other]) { sock.bind(0,'127.0.0.1'); await once(sock, 'listening'); t.after(()=>sock.close()); }
  const {sessionId} = await svc.connect({mode:'udp',host:'127.0.0.1',port:target.address().port,localPort:0}); const {localPort} = svc.read();
  assert.equal(svc.read().status,'ready'); assert.ok(localPort > 0);
  const message = once(target,'message'); assert.ok((await svc.send({sessionId,hex:'00 FF 80'})).ok);
  const [out,remote] = await message; assert.equal(out.toString('hex'),'00ff80'); assert.equal(remote.port,localPort);
  assert.deepEqual(remembered, []);
  const large = Buffer.alloc(10000,0x87);
  for (const [peer,packet] of [[other,Buffer.of(0xfa)],[target,large],[target,Buffer.of(0xa5)],[target,Buffer.alloc(0)]])
    await new Promise((resolve,reject)=>peer.send(packet,localPort,'127.0.0.1',error=>error?reject(error):resolve()));
  await until(()=>svc.read().entries.some(row=>row.hex===''));
  assert.deepEqual(svc.read().entries.filter(row=>row.direction==='RX').map(row=>row.hex),[large.toString('hex').toUpperCase(),'A5','']);
  assert.deepEqual(remembered,[{mode:'udp',host:'127.0.0.1',port:target.address().port,localPort:0}]);
  assert.equal((await svc.send({sessionId,hex:'ff'.repeat(65508)})).code,'UDP_TOO_LARGE');
  assert.ok(svc.disconnect({sessionId}).ok);
});

test('invalid modes, multicast targets and invalid or occupied bind ports are reported without disturbing other listeners', {timeout: 10000}, async t => {
  const svc = createIpControlService(); t.after(svc.dispose);
  assert.equal((await svc.connect({mode:'other'})).code, 'INVALID_MODE');
  for (const host of ['255.255.255.255','239.1.2.3','0.0.0.0','ff02::1']) assert.equal((await svc.connect({mode:'udp',host,port:8192})).code, 'INVALID_IP');
  assert.equal((await svc.connect({mode:'udp',host:'127.0.0.1',port:8192,localPort:-1})).code,'INVALID_BIND');
  const tcp=net.createServer(); tcp.listen(0,'127.0.0.1'); await once(tcp,'listening'); t.after(()=>tcp.close());
  assert.equal((await svc.connect({mode:'tcp-server',host:'127.0.0.1',port:tcp.address().port})).code,'PORT_IN_USE');
  const udp=dgram.createSocket('udp4'); udp.bind(0,'0.0.0.0'); await once(udp,'listening'); t.after(()=>udp.close());
  assert.equal((await svc.connect({mode:'udp',host:'127.0.0.1',port:8192,localPort:udp.address().port})).code,'PORT_IN_USE');
});

test('cancelling a not-yet-bound TCP Server or UDP socket relinquishes the port without late readiness', {timeout:10000}, async t => {
  for (const mode of ['tcp-server','udp']) {
    const svc = createIpControlService(); t.after(svc.dispose);
    let port;
    if (mode === 'tcp-server') port = await unusedTcpPort();
    else { const s = dgram.createSocket('udp4'); s.bind(0,'127.0.0.1'); await once(s,'listening'); port=s.address().port; await new Promise(resolve=>s.close(resolve)); }
    const args = { mode, host:'127.0.0.1', port, localPort:mode === 'udp' ? port : 0 };
    const pending = svc.connect(args), id = svc.read().sessionId; assert.ok(svc.disconnect({sessionId:id}).ok);
    assert.equal((await pending).code,'CANCELLED');await new Promise(resolve=>setImmediate(resolve));
    assert.equal(svc.read().status,'idle');assert.equal((await svc.connect(args)).ok,true, mode + ' releases old port');
  }
});

test('only a current TCP Client handshake notifies success; observer failures do not affect open/write/close', async t => {
  for (const observer of [() => { throw Error('store'); }, () => Promise.reject(Error('store'))]) {
    const seen=[], { service,sockets,start }=fixture({onSuccessfulEndpoint:value=>{seen.push(value);return observer();}}); t.after(service.dispose);
    const bad=start(); sockets[0].emit('error', Object.assign(Error('refused'),{code:'ECONNREFUSED'}));assert.equal((await bad).code,'REFUSED');
    const cancelled=start();service.disconnect({sessionId:service.read().sessionId});await cancelled;
    sockets[1].emit('connect');assert.deepEqual(seen,[]);
    const ok=start();sockets[2].emit('connect');await ok;sockets[2].emit('connect');sockets[2].emit('data',Buffer.of(0xff));
    assert.deepEqual(seen,[{mode:'tcp-client',host:'127.0.0.1',port:8192}]);
    const tx=service.send({sessionId:service.read().sessionId,hex:'fF'});sockets[2].finishWrite(); assert.ok((await tx).ok);
    assert.equal(service.read().status,'connected'); assert.equal(service.read().entries.length,2);
    service.disconnect({sessionId:service.read().sessionId});await new Promise(resolve=>setImmediate(resolve));
  }
});
