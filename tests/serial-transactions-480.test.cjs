const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSerialTransactions } = require('../electron/lib/serial-transactions.cjs');
const { createSerialService } = require('../electron/lib/serial-service.cjs');
const { DEFAULT_CONFIG } = require('../electron/lib/serial-policy.cjs');
const { formatSerialSnapshot } = require('../electron/lib/serial-export.cjs');

const query = Buffer.from('fe08584248434d440208cf', 'hex');
const reply = (id = 1, order = 1, sessionId = 's') => ({ id, _order: order, sessionId, direction: 'RX', kind: 'frame', protocol: 'xbh', hex: 'fe09584248434d44020801cf' });
test('matching uses the first-byte cursor and existing row references, not drain order or copied HEX', () => {
  let tick = 0; const engine = createSerialTransactions({ now: () => tick, setTimer: () => ({ unref() {} }), clearTimer() {} });
  const id = engine.begin({ sessionId: 's', bytes: query, cursor: 10, time: 1000 });
  engine.receive(reply(1, 9)); assert.equal(engine.snapshot()[0].status, 'writing');
  const response = reply(2, 10); engine.receive(response); assert.equal(engine.snapshot()[0].status, 'reply-before-write');
  const tx = { id: 3 }; engine.written(id, tx); tick = 50;
  assert.equal(engine.snapshot()[0].status, 'matched'); assert.equal(engine.snapshot()[0].value, 1);
  response.id = 40; tx.id = 41;
  const current = engine.snapshot()[0]; assert.equal(current.rxRecordId, 40); assert.equal(current.txRecordId, 41);
  assert.doesNotMatch(JSON.stringify(current), /fe09|hex|bytes/i); engine.dispose();
});
test('same-opcode concurrency and timeout/retry remain ambiguous; wrong/AB/unsolicited frames never pair', () => {
  let tick = 0, fire;
  const engine = createSerialTransactions({ now: () => tick, setTimer: callback => { fire = callback; return { unref() {} }; }, clearTimer() {} });
  const first = engine.begin({ sessionId: 's', bytes: query, cursor: 1, time: 1000 }); engine.written(first, { id: 1 });
  const second = engine.begin({ sessionId: 's', bytes: query, cursor: 2, time: 1001 }); engine.written(second, { id: 2 }); engine.receive(reply(3, 3));
  assert.ok(engine.snapshot().every(item => item.status === 'ambiguous'));
  engine.endSession('s');
  const timeout = engine.begin({ sessionId: 'next', bytes: query, cursor: 4, time: 1002 }); engine.written(timeout, { id: 4 }); tick = 5001; fire();
  assert.equal(engine.snapshot().at(-1).status, 'timeout');
  const retry = engine.begin({ sessionId: 'next', bytes: query, cursor: 5, time: 1003 }); engine.written(retry, { id: 5 }); engine.receive(reply(6, 6, 'next'));
  assert.equal(engine.snapshot().at(-1).status, 'ambiguous');
  assert.equal(engine.begin({ sessionId: 'next', bytes: Buffer.from('fe08584248434d440221cf', 'hex'), cursor: 7, time: 1004 }), null);
  engine.dispose();
});
test('clearing the visible transaction history does not clear protocol uncertainty or enable a late false match', () => {
  const engine = createSerialTransactions({ setTimer: () => ({ unref() {} }), clearTimer() {} });
  const first = engine.begin({ sessionId: 's', bytes: query, cursor: 1, time: 1000 }); engine.written(first, { id: 1 }); engine.clear();
  const next = engine.begin({ sessionId: 's', bytes: query, cursor: 2, time: 1001 }); engine.written(next, { id: 2 }); engine.receive(reply(3, 3));
  assert.equal(engine.snapshot()[0].status, 'ambiguous'); engine.endSession('s');
  const fresh = engine.begin({ sessionId: 'fresh', bytes: query, cursor: 4, time: 1002 }); engine.written(fresh, { id: 4 }); engine.receive(reply(5, 5, 'fresh'));
  assert.equal(engine.snapshot().at(-1).status, 'matched'); engine.dispose();
});
test('malformed, wrong-type, AB and other-session frames leave a query waiting and metadata retention stays at200', () => {
  const engine = createSerialTransactions({ setTimer: () => ({ unref() {} }), clearTimer() {} });
  const first = engine.begin({ sessionId: 's', bytes: query, cursor: 1, time: 1000 }); engine.written(first, { id: 1 });
  for (const item of [{ ...reply(), hex: reply().hex.replace(/cf$/, 'ce') }, { ...reply(), hex: reply().hex.replace('440208', '440308') }, { ...reply(), protocol: 'ab' }, reply(2, 2, 'other')]) engine.receive(item);
  assert.equal(engine.snapshot()[0].status, 'waiting');
  for (let i = 0; i < 500; i++) engine.begin({ sessionId: 's', bytes: query, cursor: i + 3, time: i + 1001 });
  assert.equal(engine.snapshot().length, 200); assert.equal(engine.drainChanges().length, 200); assert.equal(engine.drainChanges().length, 0); engine.dispose();
});
class Port extends EventEmitter {
  constructor() { super(); this.isOpen = false; this.writes = []; }
  open(callback) { this.isOpen = true; queueMicrotask(() => callback()); }
  write(bytes, callback) { this.writes.push(Buffer.from(bytes)); this.finishWrite = callback; }
  drain(callback) { this.finishDrain = callback; }
  close(callback) { this.isOpen = false; queueMicrotask(() => { this.emit('close'); callback(); }); }
}
test('actual service receives a complete reply before TX drain, preserves raw bytes and never adds writes', async t => {
  const port = new Port(), service = createSerialService({ listPorts: async () => [], createPort: () => port });
  t.after(() => service.dispose()); await service.connect({ path: 'COM_TEST_ONLY', config: DEFAULT_CONFIG });
  const sessionId = service.snapshot().sessionId;
  const sending = service.send({ sessionId, mode: 'hex', content: query.toString('hex'), lineEnding: 'none' });
  port.emit('data', Buffer.from(reply().hex, 'hex')); port.finishWrite(); port.finishDrain(); await sending;
  const result = service.snapshot(); assert.equal(result.transactions.length, 1); assert.equal(result.transactions[0].status, 'matched');
  assert.deepEqual(result.entries.map(row => [row.direction, row.hex]), [['RX', reply().hex], ['TX', query.toString('hex')]]);
  assert.equal(result.entries.find(row => row.id === result.transactions[0].rxRecordId).hex, reply().hex);
  assert.equal(port.writes.length, 1);
});
test('actual write failure cannot manufacture successful TX and closing the session ends pending transactions', async t => {
  const port = new Port(), service = createSerialService({ listPorts: async () => [], createPort: () => port });
  t.after(() => service.dispose()); await service.connect({ path: 'COM_TEST_ONLY', config: DEFAULT_CONFIG });
  const sending = service.send({ sessionId: service.snapshot().sessionId, mode: 'hex', content: query.toString('hex'), lineEnding: 'none' });
  port.emit('data', Buffer.from(reply().hex, 'hex')); port.finishWrite(Error('private fixture write failed'));
  await assert.rejects(sending); assert.equal(service.snapshot().transactions[0].status, 'write-failed');
  assert.equal(service.snapshot().entries.some(row => row.direction === 'TX'), false); assert.equal(port.writes.length, 1);
});

test('10k continuous raw records keep transaction transport dirty-only and original export byte-identical', async t => {
  let tick = 1000; const changes = [];
  const port = new Port(), service = createSerialService({ listPorts: async () => [], createPort: () => port, now: () => (tick += 60), onChange: value => changes.push(value) });
  t.after(() => service.dispose()); await service.connect({ path: 'COM_TEST_ONLY', config: DEFAULT_CONFIG });
  const sending = service.send({ sessionId: service.snapshot().sessionId, mode: 'hex', content: query.toString('hex'), lineEnding: 'none' });
  port.emit('data', Buffer.from(reply().hex, 'hex')); port.finishWrite(); port.finishDrain(); await sending;
  await new Promise(resolve => setTimeout(resolve, 120)); assert.equal(changes.at(-1).transactions.length, 1);
  for (let i = 0; i < 10050; i++) port.emit('data', Buffer.from('A'));
  await new Promise(resolve => setTimeout(resolve, 120));
  const snapshot = service.snapshot(); assert.equal(snapshot.entries.length, 10000); assert.equal(snapshot.transactions.length, 1);
  assert.equal(changes.at(-1).transactions.length, 0); assert.equal(port.writes.length, 1);
  const OriginalDate = global.Date;
  try {
    global.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : [1700000000000])); } };
    assert.equal(formatSerialSnapshot(snapshot), formatSerialSnapshot({ ...snapshot, transactions: [] }));
  } finally { global.Date = OriginalDate; }
});
