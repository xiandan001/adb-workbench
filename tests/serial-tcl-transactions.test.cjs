const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { createSerialService } = require('../electron/lib/serial-service.cjs');
const { createSerialTransactions } = require('../electron/lib/serial-transactions.cjs');
const { splitSerialResponses, wholeSerialResponseProtocol } = require('../electron/lib/serial-response-framer.cjs');
const { DEFAULT_CONFIG } = require('../electron/lib/serial-policy.cjs');

function frame(bytes) {
  let checksum = 0xffff;
  for (const byte of bytes) {
    checksum ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) checksum = ((checksum << 1) ^ (checksum & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return Buffer.from([...bytes, checksum >>> 8, checksum & 0xff]);
}
const ACK = Buffer.from('AB050ADF4E', 'hex');
const COMPLETED = Buffer.from('AB050BCF6F', 'hex');
const SET = frame([0xaa, 6, 0x10, 1]);
const QUERY = frame([0xaa, 6, 0x97, 0x23]);
const RESULT = frame([0xab, 7, 0x98, 0x23, 0x12]);
const rx = (bytes, id, options) => ({ direction: 'RX', kind: 'frame', protocol: 'ab', sessionId: 'current',
  id, _order: id, hex: bytes.toString('hex'), ...options });
function fixture(t) {
  let tick = 0, timer;
  const engine = createSerialTransactions({ now: () => tick, setTimer: callback => { timer = callback; return callback; }, clearTimer() {} });
  t.after(() => engine.dispose());
  return { engine, row: () => engine.snapshot().at(-1), time: value => { tick = value; }, expire: () => timer(),
    send: (bytes = QUERY, cursor = 0) => engine.begin({ sessionId: 'current', bytes, cursor, time: 1700000000000 }) };
}

test('TCL send, CRC-verified receipt, exact result and associated byte ids remain distinct', t => {
  const { engine, row, send } = fixture(t);
  const id = send(QUERY, 10);
  assert.equal(row().status, 'writing');
  engine.written(id, { id: 1 });
  assert.equal(row().status, 'waiting');
  const broken = Buffer.from(ACK); broken[4] ^= 1;
  engine.receive(rx(broken, 10));
  engine.receive(rx(ACK, 9));
  engine.receive(rx(ACK, 11, { sessionId: 'other' }));
  engine.receive(rx(RESULT, 12));
  assert.equal(row().status, 'waiting');
  const ackEntry = rx(ACK, 13);
  engine.receive(ackEntry);
  assert.equal(row().status, 'accepted');
  engine.receive(rx(frame([0xab, 7, 0x98, 0x22, 0x12]), 14));
  engine.receive(rx(COMPLETED, 15));
  assert.equal(row().status, 'accepted', 'a generic completion alone cannot satisfy a query');
  engine.receive(rx(RESULT, 16));
  assert.equal(row().status, 'result');
  assert.equal(row().resultPreview, '12');
  ackEntry.id = 51;
  assert.deepEqual([row().txRecordId, row().ackRecordId, row().completionRecordId, row().rxRecordId], [1, 51, 15, 16]);
});

test('TCL must observe acknowledgement before completion, and late or competing generic replies are not assigned', t => {
  const { engine, row, send, time, expire } = fixture(t);
  const first = send(SET); engine.written(first, { id: 1 });
  engine.receive(rx(COMPLETED, 2)); assert.equal(row().status, 'waiting');
  time(760); engine.receive(rx(ACK, 3)); assert.equal(row().status, 'accepted');
  time(1261); engine.receive(rx(COMPLETED, 4));
  expire(); assert.equal(row().status, 'timeout'); assert.equal(row().ackRecordId, 3);
  send(SET, 5); engine.receive(rx(COMPLETED, 6)); assert.equal(row().status, 'ambiguous');
  engine.endSession('current'); time(1800);
  send(SET); send(QUERY); engine.receive(rx(ACK, 7));
  assert.ok(engine.snapshot().slice(-2).every(item => item.status === 'ambiguous' && !item.ackRecordId));
});

test('transport error and unsupported traffic remain observational and cannot create a positive match', t => {
  const { engine, row, send } = fixture(t);
  const id = send(SET);
  engine.receive(rx(frame([0xab, 5, 0x0f]), 2));
  assert.equal(row().status, 'reply-before-write');
  engine.written(id, { id: 1 }); assert.equal(row().status, 'transport-error');
  engine.endSession('current');
  send(SET);
  assert.equal(send(frame([0xaa, 5, 0xdd])), null);
  engine.receive(rx(ACK, 3));
  assert.equal(row().status, 'ambiguous');
  assert.equal(row().ackRecordId, 0);
});

test('TCL indexed payloads and XBHCMD can coexist without sharing acknowledgement state', t => {
  const { engine, row, send } = fixture(t);
  const query = Buffer.from('fe08584248434d440208cf', 'hex');
  const xbh = send(query);
  const tcl = send(frame([0xaa, 6, 0x7a, 0]));
  engine.written(xbh, { id: 1 }); engine.written(tcl, { id: 2 });
  engine.receive(rx(ACK, 3));
  assert.equal(engine.snapshot()[0].status, 'waiting');
  assert.equal(row().status, 'accepted');
  engine.receive(rx(Buffer.from('fe09584248434d44020801cf', 'hex'), 4, { protocol: 'xbh' }));
  assert.equal(engine.snapshot()[0].status, 'matched');
  assert.equal(row().status, 'accepted');
  engine.receive(rx(frame([0xab, 7, 0x7b, 1, 2]), 5));
  assert.equal(row().status, 'result');
  assert.equal(row().resultPreview, '0102');
});

test('only the narrowly documented NFC and GAMMA replies extend serial framing; IP framing is unaffected', () => {
  const nfc = frame([0xaa, 7, 0x98, 0x43, 1]);
  const extended = frame([0xab, 0xfe, 1, 0, 0xed, 2, ...Array(248).fill(4)]);
  for (const [packet, protocol] of [[nfc, 'tcl-nfc'], [extended, 'tcl-extended']]) {
    assert.equal(wholeSerialResponseProtocol(packet), undefined);
    for (let size = 1; size < packet.length; size++) {
      const first = splitSerialResponses(packet.subarray(0, size));
      assert.equal(first[0].kind, 'pending');
      const last = splitSerialResponses(Buffer.concat([first[0].bytes, packet.subarray(size)]));
      assert.equal(last[0].protocol, protocol);
      assert.deepEqual(last[0].bytes, packet);
    }
  }
  const rejected = Buffer.from(nfc); rejected[6] ^= 1;
  assert.deepEqual(splitSerialResponses(rejected, { final: true }).map(row => row.kind), ['raw']);
});

test('documented NFC and GAMMA results link only after ACK1 and validate the reply header', t => {
  const { engine, row, send } = fixture(t);
  const requests = [
    [frame([0xaa, 7, 0x97, 0x43, 0]), frame([0xaa, 7, 0x98, 0x43, 1]), 'tcl-nfc', 1],
    [frame([0xaa, 6, 0xec, 2]), frame([0xab, 0xfe, 1, 0, 0xed, 2, ...Array(248).fill(4)]), 'tcl-extended', 248],
  ];
  for (const [request, reply, protocol, bytes] of requests) {
    const id = send(request);
    engine.written(id, { id: 1 }); engine.receive(rx(ACK, 2));
    engine.receive(rx(reply, 3)); assert.equal(row().status, 'accepted');
    engine.receive(rx(reply, 4, { protocol })); assert.equal(row().status, 'result');
    assert.equal(row().resultBytes, bytes);
    assert.equal(row().rxRecordId, 4);
  }
});

test('mocked serial service retains fragmented TCL responses and never adds a write or retransmit', async t => {
  class Port extends EventEmitter {
    writes = [];
    open(cb) { this.isOpen = true; cb(); }
    write(data, cb) { this.writes.push(Buffer.from(data)); cb(); }
    drain(cb) { this.finishDrain = cb; }
    close(cb) { this.isOpen = false; this.emit('close'); cb(); }
  }
  const port = new Port();
  const service = createSerialService({ createPort: () => port, listPorts: async () => [] });
  t.after(() => service.dispose());
  await service.connect({ path: 'COM_TCL_TEST_ONLY', config: DEFAULT_CONFIG });
  const sending = service.send({ sessionId: service.snapshot().sessionId, mode: 'hex', content: SET.toString('hex'), lineEnding: 'none' });
  port.emit('data', ACK.subarray(0, 2)); port.emit('data', ACK.subarray(2));
  port.emit('data', COMPLETED);
  assert.equal(service.snapshot().transactions[0].status, 'reply-before-write');
  port.finishDrain(); await sending;
  const { transactions: [row], entries } = service.snapshot();
  assert.equal(row.status, 'completed');
  assert.deepEqual([row.txRecordId, row.ackRecordId, row.completionRecordId].map(id => entries.find(item => item.id === id).hex),
    [SET, ACK, COMPLETED].map(bytes => bytes.toString('hex')));
  assert.deepEqual(port.writes, [SET]);
});
