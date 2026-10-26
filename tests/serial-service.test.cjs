const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSerialService } = require('../electron/lib/serial-service.cjs');
const { MAX_ENTRIES, MAX_BYTES } = require('../electron/lib/serial-buffer.cjs');

const CONFIG = { baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class FakePort extends EventEmitter {
  constructor(options, behavior = {}) {
    super();
    this.options = options;
    this.behavior = behavior;
    this.isOpen = false;
    this.writes = [];
    this.calls = { open: 0, close: 0, drain: 0 };
  }
  open(callback) {
    this.calls.open++;
    this.finishOpen = error => {
      this.isOpen = !error;
      if (!error) this.emit('open');
      callback(error);
    };
    if (!this.behavior.manualOpen) queueMicrotask(() => this.finishOpen(this.behavior.openError));
  }
  write(bytes, callback) {
    this.writes.push(Buffer.from(bytes));
    this.finishWrite = callback;
    if (!this.behavior.manualWrite) queueMicrotask(() => callback(this.behavior.writeError));
  }
  drain(callback) {
    this.calls.drain++;
    this.finishDrain = callback;
    if (!this.behavior.manualDrain) queueMicrotask(() => callback(this.behavior.drainError));
  }
  close(callback) {
    this.calls.close++;
    this.finishClose = error => {
      if (!error) {
        this.isOpen = false;
        this.emit('close');
      }
      callback(error);
    };
    if (!this.behavior.manualClose) queueMicrotask(() => this.finishClose(this.behavior.closeError));
  }
}

function harness(t, options = {}) {
  const ports = [];
  const changes = [];
  let sequence = 1000;
  const service = createSerialService({
    listPorts: options.listPorts || (async () => [{ path: 'COM10' }, { path: 'COM2', manufacturer: 'Maker' }]),
    createPort: config => {
      const port = new FakePort(config, typeof options.behavior === 'function' ? options.behavior(ports.length) : options.behavior);
      ports.push(port);
      return port;
    },
    onChange: delta => changes.push(delta),
    now: () => sequence++,
    writeTimeoutMs: 35,
    closeTimeoutMs: 35,
    ...options.service
  });
  t.after(() => service.dispose().catch(() => {}));
  return { service, ports, changes };
}

test('pending ACK survives TX drain completion and completes without hiding the TX row', async t => {
  const { service, ports } = harness(t, { behavior: { manualWrite: true, manualDrain: true } });
  await service.connect({ path: 'COM2', config: CONFIG });
  const sending = service.send({ sessionId: service.snapshot().sessionId, mode: 'hex', content: 'aa061001a7ef', lineEnding: 'none' });
  ports[0].emit('data', Buffer.from('ab05', 'hex'));
  const pendingId = service.snapshot().entries[0].id;
  ports[0].finishWrite();
  ports[0].finishDrain();
  await sending;
  assert.equal(service.snapshot().entries.filter(row => row.direction === 'TX').length, 1);
  ports[0].emit('data', Buffer.from('0adf4e', 'hex'));
  const rows = service.snapshot().entries;
  assert.deepEqual(rows.filter(row => row.direction === 'RX').map(row => [row.id, row.kind, row.hex]), [[pendingId, 'frame', 'ab050adf4e']]);
  assert.equal(service.snapshot().rxBytes, 5);
  assert.equal(service.snapshot().txBytes, 6);
});

test('bad-length resync across TX commit preserves chronological RX and TX bytes', async t => {
  const { service, ports, changes } = harness(t, { behavior: { manualWrite: true, manualDrain: true } });
  await service.connect({ path: 'COM2', config: CONFIG });
  const sending = service.send({ sessionId: service.snapshot().sessionId, mode: 'text', content: 'T', lineEnding: 'none' });
  ports[0].emit('data', Buffer.from('abffab05', 'hex'));
  ports[0].finishWrite();
  ports[0].finishDrain();
  await sending;
  ports[0].emit('data', Buffer.from('0adf4e', 'hex'));
  service.sealReceive();
  const rows = service.snapshot().entries;
  assert.deepEqual(rows.map(row => [row.direction, row.kind, row.hex]), [
    ['RX', 'raw', 'abff'], ['RX', 'frame', 'ab050adf4e'], ['TX', 'raw', '54']
  ]);
  assert.equal(service.snapshot().rxBytes, 7);
  assert.equal(service.snapshot().txBytes, 1);
  assert.equal(service.snapshot().evicted, 0);
  assert.ok(rows.every((row, index) => !index || row.id === rows[index - 1].id + 1));
  await delay(115);
  assert.equal(changes.at(-1).reset, true);
  assert.deepEqual(changes.at(-1).entries, rows);
});

test('500 ms receive idle finalizes false length without dropping immediately visible bytes', async t => {
  const { service, ports } = harness(t);
  await service.connect({ path: 'COM2', config: CONFIG });
  ports[0].emit('data', Buffer.from('abffab050adf4e', 'hex'));
  assert.equal(service.snapshot().rxBytes, 7);
  assert.equal(service.snapshot().entries[0].kind, 'pending');
  await delay(550);
  assert.deepEqual(service.snapshot().entries.map(row => [row.kind, row.hex]), [['raw', 'abff'], ['frame', 'ab050adf4e']]);
  assert.equal(service.snapshot().rxBytes, 7);
});

test('clear cancels protocol idle work and a later suffix cannot revive the old prefix', async t => {
  const { service, ports } = harness(t);
  await service.connect({ path: 'COM2', config: CONFIG });
  ports[0].emit('data', Buffer.from('ab05', 'hex'));
  assert.equal(service.snapshot().entries[0].kind, 'pending');
  service.clear();
  const revision = service.snapshot().revision;
  await delay(550);
  assert.equal(service.snapshot().revision, revision);
  assert.equal(service.snapshot().entries.length, 0);
  ports[0].emit('data', Buffer.from('0adf4e', 'hex'));
  assert.deepEqual(service.snapshot().entries.map(row => [row.kind, row.hex]), [['raw', '0adf4e']]);
  assert.equal(service.snapshot().rxBytes, 3);
});

test('a saved pending snapshot is immutable and completing its frame remains unsaved', async t => {
  const { service, ports } = harness(t);
  await service.connect({ path: 'COM2', config: CONFIG });
  ports[0].emit('data', Buffer.from('ab05', 'hex'));
  const saved = service.snapshot();
  service.markSaved(saved.revision);
  assert.equal(service.snapshot().unsaved, false);
  ports[0].emit('data', Buffer.from('0adf4e', 'hex'));
  assert.equal(saved.entries[0].kind, 'pending');
  assert.equal(saved.entries[0].hex, 'ab05');
  assert.equal(service.snapshot().entries[0].kind, 'frame');
  assert.equal(service.snapshot().entries[0].id, saved.entries[0].id);
  assert.equal(service.snapshot().unsaved, true);
  assert.equal(service.snapshot().rxBytes, 5);
});

test('terminal raw reads replay RX exactly once independently of protocol updates and RS232 clear', async t => {
  const { service, ports } = harness(t);
  await service.connect({ path: 'COM2', config: CONFIG });
  const sessionId = service.snapshot().sessionId;
  ports[0].emit('data', Buffer.from('ab05', 'hex'));
  const first = service.terminalRead({ sessionId, offset: 0 });
  assert.equal(first.hex, 'ab05');
  ports[0].emit('data', Buffer.from('0adf4e', 'hex'));
  const second = service.terminalRead({ sessionId, offset: first.nextOffset });
  assert.equal(second.hex, '0adf4e');
  assert.equal(second.nextOffset, 5);
  service.clear();
  assert.equal(service.terminalRead({ sessionId, offset: 0 }).hex, 'ab050adf4e');
  await service.disconnect();
  assert.equal(service.terminalRead({ sessionId, offset: 5 }).hex, '');
  await service.connect({ path: 'COM10', config: CONFIG });
  assert.throws(() => service.terminalRead({ sessionId, offset: 0 }), error => error.code === 'SERIAL_TERMINAL_SESSION_CHANGED');
  assert.equal(service.terminalRead({ sessionId: service.snapshot().sessionId, offset: 0 }).endOffset, 0);
});

test('RX typed-array and DataView offsets are normalized once for both serial buffers', async t => {
  const { service, ports } = harness(t);
  await service.connect({ path: 'COM2', config: CONFIG });
  const sessionId = service.snapshot().sessionId;
  const first = new Uint8Array([255, 65, 66, 255]);
  const second = new Uint8Array([255, 67, 68, 255]);
  assert.doesNotThrow(() => ports[0].emit('data', first.subarray(1, 3)));
  assert.doesNotThrow(() => ports[0].emit('data', new DataView(second.buffer, 1, 2)));
  first.fill(0); second.fill(0);
  assert.equal(service.terminalRead({ sessionId, offset: 0 }).hex, '41424344');
  assert.equal(service.snapshot().entries.map(row => row.hex).join(''), '41424344');
  assert.equal(service.snapshot().entries.map(row => row.text).join(''), 'ABCD');
  assert.equal(service.snapshot().rxBytes, 4);
});

test('terminal key writes are FIFO and compact with exact UTF-8 and control bytes', async t => {
  const { service, ports } = harness(t, { behavior: { manualWrite: true, manualDrain: true }, service: { writeTimeoutMs: 1000 } });
  await service.connect({ path: 'COM2', config: CONFIG });
  const sessionId = service.snapshot().sessionId;
  const values = ['A', '\t\x1b[A', '\x03\r中'];
  const pending = values.map(content => service.terminalWrite({ sessionId, content }));
  await delay(1);
  assert.equal(ports[0].writes.length, 1);
  await assert.rejects(service.send({ sessionId, mode: 'text', content: 'not interleaved', lineEnding: 'none' }), /发送|写入/);
  for (let index = 0; index < values.length; index++) {
    assert.equal(ports[0].writes.length, index + 1);
    ports[0].finishWrite(); ports[0].finishDrain();
    assert.deepEqual(await pending[index], { bytes: Buffer.byteLength(values[index]) });
    await delay(1);
  }
  assert.equal(Buffer.concat(ports[0].writes).equals(Buffer.from(values.join(''))), true);
  assert.equal(service.snapshot().txBytes, Buffer.byteLength(values.join('')));
});

test('terminal input waits behind a normal send without racing its native write', async t => {
  const { service, ports } = harness(t, { behavior: { manualWrite: true, manualDrain: true }, service: { writeTimeoutMs: 1000 } });
  await service.connect({ path: 'COM2', config: CONFIG });
  const sessionId = service.snapshot().sessionId;
  const normal = service.send({ sessionId, mode: 'text', content: 'AT\r', lineEnding: 'none' });
  const terminal = service.terminalWrite({ sessionId, content: '\t' });
  assert.equal(ports[0].writes.length, 1);
  ports[0].finishWrite(); ports[0].finishDrain(); await normal;
  await delay(1);
  assert.equal(ports[0].writes.length, 2);
  ports[0].finishWrite(); ports[0].finishDrain();
  assert.deepEqual(await terminal, { bytes: 1 });
});

test('terminal queue enforces byte and item backpressure before accepting excess input', async t => {
  const first = harness(t, { behavior: { manualWrite: true }, service: { writeTimeoutMs: 1000 } });
  await first.service.connect({ path: 'COM2', config: CONFIG });
  const sessionId = first.service.snapshot().sessionId;
  const held = first.service.terminalWrite({ sessionId, content: 'A'.repeat(65536) });
  const rejectedHeld = assert.rejects(held, /无法确认|断开|退出/);
  await assert.rejects(first.service.terminalWrite({ sessionId, content: 'B' }), error => error.code === 'SERIAL_TERMINAL_BACKPRESSURE');
  await first.service.disconnect(); await rejectedHeld;
  const second = harness(t, { behavior: { manualWrite: true }, service: { writeTimeoutMs: 1000 } });
  await second.service.connect({ path: 'COM2', config: CONFIG });
  const nextId = second.service.snapshot().sessionId;
  const items = Array.from({ length: 256 }, () => second.service.terminalWrite({ sessionId: nextId, content: 'x' }).catch(error => error));
  await assert.rejects(second.service.terminalWrite({ sessionId: nextId, content: 'z' }), error => error.code === 'SERIAL_TERMINAL_BACKPRESSURE');
  await second.service.disconnect();
  assert.ok((await Promise.all(items)).every(result => result instanceof Error));
});

test('disconnect and dispose reject queued terminal input without replaying it into the next session', async t => {
  const { service, ports } = harness(t, { behavior: index => index ? {} : { manualWrite: true }, service: { writeTimeoutMs: 1000 } });
  await service.connect({ path: 'COM2', config: CONFIG });
  const oldId = service.snapshot().sessionId;
  const items = ['one', 'two', 'three'].map(content => service.terminalWrite({ sessionId: oldId, content }).catch(error => error));
  await delay(1);
  await service.disconnect();
  assert.ok((await Promise.all(items)).every(result => result instanceof Error));
  await service.connect({ path: 'COM10', config: CONFIG });
  ports[0].finishWrite();
  await delay(1);
  assert.equal(ports[0].writes.length, 1);
  assert.equal(ports[1].writes.length, 0);
  await assert.rejects(service.terminalWrite({ sessionId: oldId, content: 'stale' }), error => error.code === 'SERIAL_TERMINAL_SESSION_CHANGED');
  const currentId = service.snapshot().sessionId;
  assert.deepEqual(await service.terminalWrite({ sessionId: currentId, content: 'new' }), { bytes: 3 });
  ports[1].behavior.manualWrite = true;
  const disposed = ['four', 'five'].map(content => service.terminalWrite({ sessionId: currentId, content }).catch(error => error));
  await delay(1);
  await service.dispose();
  assert.ok((await Promise.all(disposed)).every(result => result instanceof Error));
});

test('terminal native failure rejects the queued suffix and closes without retry', async t => {
  const { service, ports } = harness(t, { behavior: { writeError: new Error('device removed') } });
  await service.connect({ path: 'COM2', config: CONFIG });
  const sessionId = service.snapshot().sessionId;
  const items = ['a', 'b', 'c'].map(content => service.terminalWrite({ sessionId, content }).catch(error => error));
  assert.ok((await Promise.all(items)).every(result => result instanceof Error));
  await delay(5);
  assert.equal(ports[0].writes.length, 1);
  assert.equal(ports[0].calls.close, 1);
  assert.equal(service.snapshot().txBytes, 0);
});

test('terminal drain timeout cancels queued suffix with distinct unknown and never-written results', async t => {
  const { service, ports } = harness(t, { behavior: { manualDrain: true } });
  await service.connect({ path: 'COM2', config: CONFIG });
  const sessionId = service.snapshot().sessionId;
  const items = ['a', 'b'].map(content => service.terminalWrite({ sessionId, content }).catch(error => error));
  const failures = await Promise.all(items);
  assert.equal(failures[0].code, 'SERIAL_TERMINAL_WRITE_UNKNOWN');
  assert.equal(failures[1].code, 'SERIAL_TERMINAL_SESSION_CLOSED');
  await delay(5);
  assert.equal(ports[0].writes.length, 1);
  ports[0].finishDrain();
  assert.equal(service.snapshot().txBytes, 0);
  assert.equal(service.snapshot().status, 'error');
});

test('terminal rejects malformed or oversized input before touching the port and leaves queue capacity intact', async t => {
  const { service, ports } = harness(t);
  await service.connect({ path: 'COM2', config: CONFIG });
  const sessionId = service.snapshot().sessionId;
  for (const content of ['', null, 3, '中'.repeat(22000), 'x'.repeat(65537)]) {
    await assert.rejects(service.terminalWrite({ sessionId, content }), error => error.code === 'SERIAL_TERMINAL_INPUT_INVALID');
  }
  assert.equal(ports[0].writes.length, 0);
  assert.deepEqual(await service.terminalWrite({ sessionId, content: '\x00\x03\t\x1b[A\r\n' }), { bytes: 8 });
  assert.equal(ports[0].writes[0].toString('hex'), '0003091b5b410d0a');
});

test('terminal keystrokes do not flush an in-progress protocol response', async t => {
  const { service, ports } = harness(t);
  await service.connect({ path: 'COM2', config: CONFIG });
  const sessionId = service.snapshot().sessionId;
  ports[0].emit('data', Buffer.from('ab05', 'hex'));
  await service.terminalWrite({ sessionId, content: '\t' });
  ports[0].emit('data', Buffer.from('0adf4e', 'hex'));
  assert.deepEqual(service.snapshot().entries.filter(row => row.direction === 'RX').map(row => [row.kind, row.hex]), [['frame', 'ab050adf4e']]);
});

test('synchronous disconnect before queued write starts performs no late native write', async t => {
  const { service, ports } = harness(t);
  await service.connect({ path: 'COM2', config: CONFIG });
  const sessionId = service.snapshot().sessionId;
  const input = service.terminalWrite({ sessionId, content: 'never written' }).catch(error => error);
  await service.disconnect();
  assert.ok(await input instanceof Error);
  await delay(1);
  assert.equal(ports[0].writes.length, 0);
  assert.equal(service.snapshot().txBytes, 0);
});

test('terminal IPC preserves main-owner authorization and compact successes and errors', async () => {
  const { createSerialController } = require('../electron/lib/serial.cjs');
  const handlers = new Map();
  const sender = new EventEmitter(); sender.isDestroyed = () => false;
  const owner = { webContents: sender, isDestroyed: () => false };
  let writes = 0;
  let reads = 0;
  const service = {
    snapshot: () => assert.fail('terminal IPC must never allocate a full snapshot'),
    terminalRead: args => { reads++; return { sessionId: args.sessionId, startOffset: 0, endOffset: 1, nextOffset: 1, hex: '41', truncated: false }; },
    terminalWrite: async args => { writes++; if (args.content === 'fail') throw Object.assign(new Error('input refused'), { code: 'SERIAL_TERMINAL_BACKPRESSURE' }); return { bytes: Buffer.byteLength(args.content) }; }
  };
  const workspaces = { get: workspace => { assert.equal(workspace, 'terminal'); return service; }, snapshot: service.snapshot };
  createSerialController({ workspaces, getOwner: () => owner, saveSnapshot: () => {} }).register({ handle: (name, handler) => handlers.set(name, handler) });
  for (const name of ['serial:terminal-read', 'serial:terminal-write']) {
    const denied = await handlers.get(name)({ sender: {} }, { sessionId: 'test', content: 'A', offset: 0 });
    assert.equal(denied.success, false);
    assert.equal(denied.snapshot, undefined);
    assert.equal(denied.hex, undefined);
  }
  assert.equal(writes + reads, 0);
  assert.deepEqual(await handlers.get('serial:terminal-write')({ sender }, { sessionId: 'test', content: '\t' }), { success: true, bytes: 1 });
  const failure = await handlers.get('serial:terminal-write')({ sender }, { sessionId: 'test', content: 'fail' });
  assert.deepEqual(failure, { success: false, error: 'input refused', code: 'SERIAL_TERMINAL_BACKPRESSURE' });
  const data = await handlers.get('serial:terminal-read')({ sender }, { sessionId: 'test', offset: 0 });
  assert.equal(data.hex, '41'); assert.equal(data.snapshot, undefined);
});

test('enumeration is naturally sorted, preserves safe optional metadata and never opens ports', async t => {
  const { service, ports } = harness(t, {
    listPorts: async () => [
      { path: 'COM10', serialNumber: 'N-10', locationId: '1', vendorId: '1234', productId: '5678', friendlyName: 'USB serial' },
      { path: 'COM2', manufacturer: 'Maker' }, { path: 'COM1' }
    ]
  });
  const listed = await service.listPorts();
  assert.deepEqual(listed.map(port => port.path), ['COM1', 'COM2', 'COM10']);
  assert.equal(listed[2].serialNumber, 'N-10');
  assert.equal(listed[2].friendlyName, 'USB serial');
  assert.equal(ports.length, 0);
  assert.equal(service.snapshot().status, 'disconnected');
  assert.equal(service.needsQuitConfirmation(), false);
});

test('enumeration error is friendly and does not disconnect a live port', async t => {
  const { service, ports } = harness(t, { listPorts: async () => { throw new Error('Access denied'); } });
  await service.connect({ path: 'COM2', config: CONFIG });
  await assert.rejects(service.listPorts(), /串口.*(枚举|列表|扫描)/);
  assert.equal(service.snapshot().status, 'connected');
  assert.equal(ports[0].calls.close, 0);
});

test('connection validates before creating, normalizes native flow options and blocks duplicate opens', async t => {
  const { service, ports } = harness(t);
  await assert.rejects(service.connect({ path: 'COM2', config: { ...CONFIG, baudRate: 0 } }));
  await assert.rejects(service.connect({ path: 'COM2\n', config: CONFIG }));
  assert.equal(ports.length, 0);
  await service.connect({ path: 'COM2', config: { ...CONFIG, flowControl: 'xonxoff' } });
  assert.equal(ports[0].options.autoOpen, false);
  assert.equal(ports[0].options.xon, true);
  assert.equal(ports[0].options.xoff, true);
  assert.equal(ports[0].options.rtscts, false);
  await assert.rejects(service.connect({ path: 'COM10', config: CONFIG }), /断开|释放/);
  assert.equal(ports.length, 1);
  assert.equal(service.needsQuitConfirmation(), true);
});

test('open failures release only the failed session and report occupied/device errors', async t => {
  const { service, ports } = harness(t, { behavior: index => index ? {} : { openError: new Error('Access denied / port busy') } });
  await assert.rejects(service.connect({ path: 'COM2', config: CONFIG }), /串口.*(打开|连接)|占用/);
  assert.equal(service.snapshot().status, 'error');
  assert.equal(service.needsQuitConfirmation(), false);
  await service.connect({ path: 'COM10', config: CONFIG });
  ports[0].emit('error', new Error('late failure'));
  assert.equal(service.snapshot().status, 'connected');
  assert.equal(service.snapshot().path, 'COM10');
});

test('write and drain both complete before TX is recorded with exact bytes and framing', async t => {
  const { service, ports } = harness(t, { behavior: { manualWrite: true, manualDrain: true } });
  await service.connect({ path: 'COM10', config: CONFIG });
  const sessionId = service.snapshot().sessionId;
  const sending = service.send({ sessionId, mode: 'text', content: '中\n', lineEnding: 'crlf' });
  assert.equal(service.snapshot().sending, true);
  assert.equal(service.snapshot().txBytes, 0);
  await assert.rejects(service.send({ sessionId, mode: 'hex', content: 'FF', lineEnding: 'none' }), /发送|写入/);
  ports[0].finishWrite();
  assert.equal(service.snapshot().txBytes, 0);
  ports[0].finishDrain();
  await sending;
  assert.deepEqual([...ports[0].writes[0]], [...Buffer.from('中\n\r\n')]);
  assert.equal(service.snapshot().txBytes, 6);
  assert.equal(service.snapshot().entries[0].direction, 'TX');
  assert.equal(service.snapshot().entries[0].hex, 'e4b8ad0a0d0a');
  assert.equal(service.snapshot().sending, false);
});

test('invalid HEX and stale session never reach the native port', async t => {
  const { service, ports } = harness(t);
  await service.connect({ path: 'COM2', config: CONFIG });
  const oldId = service.snapshot().sessionId;
  await assert.rejects(service.send({ sessionId: oldId, mode: 'hex', content: '0', lineEnding: 'none' }));
  await service.disconnect();
  await service.connect({ path: 'COM10', config: CONFIG });
  await assert.rejects(service.send({ sessionId: oldId, mode: 'text', content: 'x', lineEnding: 'none' }), /会话|连接/);
  assert.equal(ports.reduce((sum, port) => sum + port.writes.length, 0), 0);
  await service.send({ sessionId: service.snapshot().sessionId, mode: 'hex', content: '00 ff 80', lineEnding: 'crlf' });
  assert.deepEqual([...ports[1].writes[0]], [0, 255, 128]);
});

test('UTF-8 crosses native callbacks intact, RX/TX decoders are separate and HEX is byte exact', async t => {
  const { service, ports } = harness(t, { service: { mergeReceive: false } });
  await service.connect({ path: 'COM2', config: CONFIG });
  const bytes = Buffer.from('中');
  ports[0].emit('data', bytes.subarray(0, 2));
  await service.send({ sessionId: service.snapshot().sessionId, mode: 'text', content: 'A', lineEnding: 'none' });
  ports[0].emit('data', bytes.subarray(2));
  ports[0].emit('data', Buffer.from([0, 255, 128]));
  const data = service.snapshot();
  assert.equal(data.entries.filter(entry => entry.direction === 'RX').slice(0, 2).map(entry => entry.text).join(''), '中');
  assert.equal(data.entries.filter(entry => entry.direction === 'RX').map(entry => entry.hex).join(''), 'e4b8ad00ff80');
  assert.equal(data.rxBytes, 6);
  assert.equal(data.txBytes, 1);
});

test('incomplete UTF-8 is finalized on disconnect and never combines across sessions', async t => {
  const { service, ports } = harness(t);
  await service.connect({ path: 'COM2', config: CONFIG });
  const firstSession = service.snapshot().sessionId;
  ports[0].emit('data', Buffer.from([0xe4, 0xb8]));
  await service.disconnect();
  const closed = service.snapshot();
  assert.equal(closed.entries[0].hex, 'e4b8');
  assert.equal(closed.entries[0].text, '�');
  await service.connect({ path: 'COM10', config: CONFIG });
  ports[1].emit('data', Buffer.from([0xad]));
  const after = service.snapshot();
  assert.equal(after.entries[1].text, '�');
  assert.equal(after.entries[0].sessionId, firstSession);
  assert.notEqual(after.entries[1].sessionId, firstSession);
  assert.equal(after.entries[0].path, 'COM2');
});

test('large native chunks are split to 16 KiB while retaining all raw bytes', async t => {
  const { service, ports } = harness(t);
  await service.connect({ path: 'COM2', config: CONFIG });
  const bytes = Buffer.alloc(16 * 1024 * 2 + 7, 0xa5);
  ports[0].emit('data', bytes);
  const data = service.snapshot();
  assert.deepEqual(data.entries.map(entry => entry.bytes), [16384, 16384, 7]);
  assert.equal(Buffer.from(data.entries.map(entry => entry.hex).join(''), 'hex').equals(bytes), true);
});

test('retention is constrained by raw byte and entry limits with chronological IDs', async t => {
  const { service, ports } = harness(t, { service: { maxEntries: 3, maxBytes: 6, mergeReceive: false } });
  await service.connect({ path: 'COM2', config: CONFIG });
  for (let number = 1; number <= 5; number++) ports[0].emit('data', Buffer.from([number, number]));
  const data = service.snapshot();
  assert.equal(data.entries.length, 3);
  assert.equal(data.entries.reduce((sum, entry) => sum + entry.bytes, 0), 6);
  assert.deepEqual(data.entries.map(entry => entry.id), [3, 4, 5]);
  assert.equal(data.evicted, 2);
  assert.equal(data.firstId, 3);
  assert.equal(data.lastId, 5);
  assert.equal(data.rxBytes, 10);
});

test('deltas batch additions rather than replaying the full snapshot, and clear is a reset', async t => {
  const { service, ports, changes } = harness(t, { service: { mergeReceive: false } });
  await service.connect({ path: 'COM2', config: CONFIG });
  ports[0].emit('data', Buffer.from('a'));
  ports[0].emit('data', Buffer.from('b'));
  assert.equal(changes.length, 0);
  await delay(115);
  assert.deepEqual(changes[0].entries.map(entry => entry.text), ['a', 'b']);
  ports[0].emit('data', Buffer.from('c'));
  await delay(115);
  assert.deepEqual(changes[1].entries.map(entry => entry.text), ['c']);
  assert.ok(changes[1].revision > changes[0].revision);
  await service.clear();
  await delay(115);
  assert.equal(changes[2].reset, true);
  assert.deepEqual(changes[2].entries, []);
  assert.equal(changes[2].firstId, 0);
  assert.equal(changes[2].lastId, 0);
  ports[0].emit('data', Buffer.from('d'));
  assert.equal(service.snapshot().entries[0].id, 4);
  assert.equal(service.snapshot().rxBytes, 1);
  assert.equal(service.snapshot().evicted, 0);
});

test('saving a captured revision never marks subsequent data saved; metadata alone stays clean', async t => {
  const { service, ports } = harness(t);
  await service.connect({ path: 'COM2', config: CONFIG });
  ports[0].emit('data', Buffer.from('a'));
  const exported = service.snapshot();
  ports[0].emit('data', Buffer.from('b'));
  service.markSaved(exported.revision);
  assert.equal(service.snapshot().unsaved, true);
  service.markSaved(service.snapshot().revision);
  assert.equal(service.snapshot().unsaved, false);
  await service.disconnect();
  assert.equal(service.snapshot().unsaved, false);
  assert.equal(service.needsQuitConfirmation(), false);
  await service.clear();
  assert.equal(service.snapshot().unsaved, false);
});

test('returned snapshots cannot mutate retained entries, config or delta data', async t => {
  const { service, ports } = harness(t);
  await service.connect({ path: 'COM2', config: CONFIG });
  ports[0].emit('data', Buffer.from('hello'));
  const copied = service.snapshot();
  copied.entries[0].text = 'changed';
  copied.entries[0].config.baudRate = 1;
  copied.config.baudRate = 2;
  assert.equal(service.snapshot().entries[0].text, 'hello');
  assert.equal(service.snapshot().entries[0].config.baudRate, 9600);
  assert.equal(service.snapshot().config.baudRate, 9600);
});

test('disconnect while opening rejects the original action and closes a cancelled late open', async t => {
  const { service, ports } = harness(t, { behavior: { manualOpen: true } });
  const pending = service.connect({ path: 'COM2', config: CONFIG });
  const rejected = assert.rejects(pending, /取消|断开/);
  const closing = service.disconnect();
  await assert.rejects(service.connect({ path: 'COM10', config: CONFIG }), /断开|释放/);
  ports[0].finishOpen();
  await closing;
  await rejected;
  assert.equal(ports[0].calls.close, 1);
  assert.equal(service.snapshot().status, 'disconnected');
  assert.equal(ports.length, 1);
});

test('opening cancellation timeout retains identity until a late open is closed', async t => {
  const { service, ports } = harness(t, { behavior: index => index ? {} : { manualOpen: true } });
  const rejected = assert.rejects(service.connect({ path: 'COM2', config: CONFIG }), /取消|断开/);
  await assert.rejects(service.disconnect(), /超时|释放/);
  await rejected;
  assert.equal(service.needsQuitConfirmation(), true);
  await assert.rejects(service.connect({ path: 'COM10', config: CONFIG }), /断开|释放/);
  ports[0].finishOpen();
  await delay(5);
  assert.equal(ports[0].calls.close, 1);
  await service.connect({ path: 'COM10', config: CONFIG });
  assert.equal(service.snapshot().status, 'connected');
});

test('close failure prevents a second port from opening and can explicitly retry release', async t => {
  const { service, ports } = harness(t, { behavior: { closeError: new Error('driver refused close') } });
  await service.connect({ path: 'COM2', config: CONFIG });
  await assert.rejects(service.disconnect(), /关闭|释放|断开/);
  assert.equal(service.snapshot().status, 'error');
  assert.equal(service.needsQuitConfirmation(), true);
  await assert.rejects(service.connect({ path: 'COM10', config: CONFIG }), /断开|释放/);
  assert.equal(ports.length, 1);
  ports[0].behavior.closeError = undefined;
  await service.disconnect();
  assert.equal(service.needsQuitConfirmation(), false);
});

test('close timeout blocks reopening even if an old callback arrives late', async t => {
  const { service, ports } = harness(t, { behavior: index => index ? {} : { manualClose: true } });
  await service.connect({ path: 'COM2', config: CONFIG });
  await assert.rejects(service.disconnect(), /超时|释放/);
  await assert.rejects(service.connect({ path: 'COM10', config: CONFIG }));
  ports[0].finishClose();
  await service.connect({ path: 'COM10', config: CONFIG });
  ports[0].finishClose();
  ports[0].emit('data', Buffer.from('old data'));
  ports[0].emit('error', new Error('old error'));
  assert.equal(service.snapshot().path, 'COM10');
  assert.equal(service.snapshot().status, 'connected');
  assert.equal(service.snapshot().rxBytes, 0);
});

test('write timeout is uncertain, closes the session and late callbacks cannot record TX', async t => {
  const { service, ports } = harness(t, { behavior: index => index ? {} : { manualWrite: true } });
  await service.connect({ path: 'COM2', config: CONFIG });
  await assert.rejects(service.send({ sessionId: service.snapshot().sessionId, mode: 'text', content: 'A', lineEnding: 'none' }), /结果无法确认/);
  await delay(5);
  assert.equal(ports[0].calls.close, 1);
  assert.equal(service.snapshot().txBytes, 0);
  await service.connect({ path: 'COM10', config: CONFIG });
  ports[0].finishWrite();
  assert.equal(service.snapshot().txBytes, 0);
  assert.equal(service.snapshot().status, 'connected');
});

test('drain timeout/failure is uncertain rather than success and never retries write', async t => {
  const { service, ports } = harness(t, { behavior: { manualDrain: true } });
  await service.connect({ path: 'COM2', config: CONFIG });
  await assert.rejects(service.send({ sessionId: service.snapshot().sessionId, mode: 'hex', content: 'AA', lineEnding: 'none' }), /结果无法确认/);
  await delay(5);
  assert.equal(ports[0].writes.length, 1);
  assert.equal(service.snapshot().txBytes, 0);
  ports[0].finishDrain();
  assert.equal(service.snapshot().txBytes, 0);
});

test('disconnect and removal while writing reject in-flight data and preserve received records', async t => {
  const { service, ports } = harness(t, { behavior: { manualWrite: true } });
  await service.connect({ path: 'COM2', config: CONFIG });
  ports[0].emit('data', Buffer.from('keep'));
  const failed = assert.rejects(service.send({ sessionId: service.snapshot().sessionId, mode: 'text', content: 'x', lineEnding: 'none' }), /结果无法确认/);
  await service.disconnect();
  await failed;
  ports[0].finishWrite();
  assert.equal(service.snapshot().entries[0].text, 'keep');
  assert.equal(service.snapshot().txBytes, 0);
  await service.connect({ path: 'COM10', config: CONFIG });
  ports[1].emit('error', new Error('device disconnected'));
  await delay(5);
  assert.equal(service.snapshot().status, 'error');
  await assert.rejects(service.send({ sessionId: service.snapshot().sessionId, mode: 'text', content: 'x', lineEnding: 'none' }), /连接/);
  assert.equal(service.snapshot().entries[0].text, 'keep');
});

test('unsolicited close releases old identity and dispose stops callbacks and future operations', async t => {
  const { service, ports, changes } = harness(t);
  await service.connect({ path: 'COM2', config: CONFIG });
  ports[0].isOpen = false;
  ports[0].emit('close');
  assert.equal(service.snapshot().status, 'error');
  await service.connect({ path: 'COM10', config: CONFIG });
  await service.dispose();
  const count = changes.length;
  ports[1].emit('data', Buffer.from('ignored'));
  await delay(115);
  assert.equal(changes.length, count);
  assert.equal(ports[1].calls.close, 1);
  assert.equal(ports[1].listenerCount('data'), 0);
  await assert.rejects(service.connect({ path: 'COM2', config: CONFIG }), /关闭|退出|释放/);
});

test('native write and drain errors close uncertain sends without recording or retrying', async t => {
  for (const failure of ['writeError', 'drainError']) {
    const { service, ports } = harness(t, { behavior: { [failure]: new Error('device removed') } });
    await service.connect({ path: 'COM2', config: CONFIG });
    await assert.rejects(service.send({ sessionId: service.snapshot().sessionId, mode: 'hex', content: '00', lineEnding: 'none' }), /结果无法确认/);
    await delay(5);
    assert.equal(ports[0].writes.length, 1);
    assert.equal(ports[0].calls.close, 1);
    assert.equal(service.snapshot().txBytes, 0);
    assert.equal(service.snapshot().status, 'error');
  }
});

test('native synchronous close error event does not trigger recursive close calls', async t => {
  const { service, ports } = harness(t);
  await service.connect({ path: 'COM2', config: CONFIG });
  ports[0].close = callback => {
    ports[0].calls.close++;
    ports[0].emit('error', new Error('driver disconnected'));
    ports[0].isOpen = false;
    ports[0].emit('close');
    callback();
  };
  await service.disconnect();
  assert.equal(ports[0].calls.close, 1);
  assert.equal(service.snapshot().status, 'error');
});

test('production retention supports 10k rows and keeps the 64MiB byte guard after a burst', async t => {
  const { service, ports } = harness(t, { service: { mergeReceive: false } });
  await service.connect({ path: 'COM2', config: CONFIG });
  for (let index = 0; index < MAX_ENTRIES + 1; index++) ports[0].emit('data', Buffer.from([index % 256]));
  let data = service.snapshot();
  assert.equal(data.entries.length, MAX_ENTRIES);
  assert.equal(data.evicted, 1);
  const burst = Buffer.alloc(MAX_BYTES + 1, 0x41);
  ports[0].emit('data', burst);
  data = service.snapshot();
  assert.ok(data.entries.length <= MAX_ENTRIES);
  assert.ok(data.entries.reduce((sum, entry) => sum + entry.bytes, 0) <= MAX_BYTES);
  assert.equal(data.rxBytes, burst.length + MAX_ENTRIES + 1);
  assert.equal(data.entries.at(-1).hex, '41');
  assert.equal(data.entries.at(-1).bytes, 1);
});

test('disconnect finalization publishes corrected text as a bounded reset', async t => {
  const { service, ports, changes } = harness(t);
  await service.connect({ path: 'COM2', config: CONFIG });
  ports[0].emit('data', Buffer.from([0xe4]));
  await delay(115);
  assert.equal(changes[0].entries[0].text, '');
  const revision = service.snapshot().revision;
  service.markSaved(revision);
  await service.disconnect();
  await delay(115);
  assert.equal(changes[1].reset, true);
  assert.equal(changes[1].entries[0].text, '�');
  assert.equal(changes[1].entries[0].hex, 'e4');
  assert.equal(service.snapshot().unsaved, true);
});

test('clear resets pending decoders without touching the hardware or next record identity', async t => {
  const { service, ports } = harness(t);
  await service.connect({ path: 'COM2', config: CONFIG });
  ports[0].emit('data', Buffer.from([0xe4]));
  service.clear();
  ports[0].emit('data', Buffer.from([0xb8, 0xad]));
  assert.equal(service.snapshot().entries[0].text, '��');
  assert.equal(service.snapshot().entries[0].id, 2);
  assert.equal(ports[0].calls.close, 0);
  assert.equal(ports[0].writes.length, 0);
});

test('RX user reply AB05 + 0ADF4E is stored immediately and merged within 50 ms', async t => {
  let clock = 1000;
  const { service, ports } = harness(t, { service: { now: () => clock } });
  await service.connect({ path: 'COM2', config: CONFIG });
  ports[0].emit('data', Buffer.from('ab05', 'hex'));
  const first = service.snapshot();
  assert.equal(first.rxBytes, 2);
  assert.equal(first.entries[0].hex, 'ab05');
  clock += 10;
  ports[0].emit('data', Buffer.from('0adf4e', 'hex'));
  const merged = service.snapshot();
  assert.equal(merged.entries.length, 1);
  assert.equal(merged.entries[0].id, first.entries[0].id);
  assert.equal(merged.entries[0].hex, 'ab050adf4e');
  assert.equal(merged.entries[0].bytes, 5);
  assert.equal(merged.entries[0].parts, 2);
  assert.equal(merged.entries[0].time, 1000);
  assert.equal(merged.entries[0].endTime, 1010);
  assert.equal(merged.rxBytes, 5);
  assert.equal(first.entries[0].hex, 'ab05', 'old snapshots remain consistent');
});

test('published RX same-ID growth is an upsert with chained baseRevision', async t => {
  let clock = 1000;
  const { service, ports, changes } = harness(t, { service: { now: () => clock } });
  await service.connect({ path: 'COM2', config: CONFIG });
  ports[0].emit('data', Buffer.from('ab05', 'hex'));
  await delay(115);
  assert.equal(changes[0].baseRevision, 0);
  const exported = service.snapshot();
  service.markSaved(exported.revision);
  clock += 10;
  ports[0].emit('data', Buffer.from('0adf4e', 'hex'));
  await delay(115);
  assert.equal(changes[1].reset, false);
  assert.equal(changes[1].baseRevision, changes[0].revision);
  assert.equal(changes[1].entries.length, 1);
  assert.equal(changes[1].entries[0].id, changes[0].entries[0].id);
  assert.equal(changes[1].entries[0].hex, 'ab050adf4e');
  assert.equal(changes[1].rxBytes, 5);
  assert.equal(service.snapshot().unsaved, true);
  service.markSaved(exported.revision);
  assert.equal(service.snapshot().unsaved, true, 'an older save cannot mark amended bytes clean');
  clock += 10;
  ports[0].emit('data', Buffer.from('ab079844', 'hex'));
  clock += 10;
  ports[0].emit('data', Buffer.from('00962a', 'hex'));
  await delay(115);
  assert.equal(changes[2].baseRevision, changes[1].revision);
  assert.deepEqual(changes[2].entries.map(entry => entry.hex), ['ab07984400962a']);
  assert.deepEqual(service.snapshot().entries.map(entry => entry.hex), ['ab050adf4e', 'ab07984400962a']);
  assert.deepEqual(service.snapshot().entries.map(entry => entry.parts), [2, 2]);
  clock += 10;
  ports[0].emit('data', Buffer.from('ff', 'hex'));
  assert.deepEqual(service.snapshot().entries.map(entry => entry.parts), [2, 2, 1]);
  await delay(115);
  assert.deepEqual(changes[3].entries.map(entry => entry.hex), ['ff']);
  assert.equal(service.snapshot().rxBytes, 13);
});

test('RX grouping keeps independent 50 ms and rollback boundaries with two-part precedence over the span limit', async t => {
  let clock = 1000;
  const { service, ports } = harness(t, { service: { now: () => clock } });
  await service.connect({ path: 'COM2', config: CONFIG });
  ports[0].emit('data', Buffer.from([1]));
  clock += 50;
  ports[0].emit('data', Buffer.from([2]));
  assert.equal(service.snapshot().entries.length, 1);
  service.clear();
  ports[0].emit('data', Buffer.from([3]));
  clock += 51;
  ports[0].emit('data', Buffer.from([4]));
  assert.equal(service.snapshot().entries.length, 2, 'the gap still splits a one-part row before its two-part limit');
  service.clear();
  clock = 2000;
  for (let index = 0; index <= 20; index++) {
    ports[0].emit('data', Buffer.from([index]));
    clock += 50;
  }
  assert.equal(service.snapshot().entries.length, 11, 'two-part rows finish before a stream can reach the 1 second cap');
  assert.deepEqual(service.snapshot().entries.map(entry => entry.parts), [...Array(10).fill(2), 1]);
  clock = 1500;
  ports[0].emit('data', Buffer.from([255]));
  assert.equal(service.snapshot().entries.length, 12, 'clock rollback cannot extend the prior one-part segment');
});

test('RX grouping splits exactly at 16 KiB without losing data or recounting prior bytes', async t => {
  let clock = 1000;
  const { service, ports } = harness(t, { service: { now: () => clock } });
  await service.connect({ path: 'COM2', config: CONFIG });
  ports[0].emit('data', Buffer.alloc(16380, 0x41));
  clock += 1;
  ports[0].emit('data', Buffer.alloc(10, 0x42));
  const snapshot = service.snapshot();
  assert.deepEqual(snapshot.entries.map(entry => entry.bytes), [16384, 6]);
  assert.deepEqual(snapshot.entries.map(entry => entry.parts), [2, 1]);
  assert.equal(snapshot.rxBytes, 16390);
  assert.equal(snapshot.entries.map(entry => entry.hex).join(''), Buffer.concat([Buffer.alloc(16380, 0x41), Buffer.alloc(10, 0x42)]).toString('hex'));
});

test('sealReceive ends grouping but not UTF-8 decoding; ordinary snapshots do not seal', async t => {
  let clock = 1000;
  const { service, ports } = harness(t, { service: { now: () => clock } });
  await service.connect({ path: 'COM2', config: CONFIG });
  ports[0].emit('data', Buffer.from([0xe4, 0xb8]));
  service.sealReceive();
  clock += 1;
  ports[0].emit('data', Buffer.from([0xad]));
  const snapshot = service.snapshot();
  assert.equal(snapshot.entries.length, 2);
  assert.equal(snapshot.entries[0].text + snapshot.entries[1].text, '中');
  const exportedRevision = snapshot.revision;
  service.sealReceive();
  service.markSaved(exportedRevision);
  clock += 1;
  ports[0].emit('data', Buffer.from('A'));
  service.snapshot();
  clock += 1;
  ports[0].emit('data', Buffer.from('B'));
  assert.deepEqual(service.snapshot().entries.map(entry => entry.hex), ['e4b8', 'ad', '4142']);
  assert.equal(service.snapshot().unsaved, true);
});

test('valid send start and TX commit seal RX; invalid send does not split received data', async t => {
  let clock = 1000;
  const { service, ports } = harness(t, { behavior: { manualWrite: true, manualDrain: true }, service: { now: () => clock } });
  await service.connect({ path: 'COM2', config: CONFIG });
  ports[0].emit('data', Buffer.from('A'));
  await assert.rejects(service.send({ sessionId: service.snapshot().sessionId, mode: 'hex', content: '0', lineEnding: 'none' }));
  clock += 1;
  ports[0].emit('data', Buffer.from('B'));
  assert.equal(service.snapshot().entries[0].text, 'AB');
  const sending = service.send({ sessionId: service.snapshot().sessionId, mode: 'text', content: 'T', lineEnding: 'none' });
  clock += 1;
  ports[0].emit('data', Buffer.from('C'));
  assert.equal(service.snapshot().entries.length, 2, 'RX during write cannot merge with pre-write RX');
  ports[0].finishWrite();
  ports[0].finishDrain();
  await sending;
  clock += 1;
  ports[0].emit('data', Buffer.from('D'));
  assert.deepEqual(service.snapshot().entries.map(entry => `${entry.direction}:${entry.text}`), ['RX:AB', 'RX:C', 'TX:T', 'RX:D']);
});

test('dirty RX updates are pruned on eviction, remain bounded and clear starts a new identity', async t => {
  let clock = 1000;
  const { service, ports, changes } = harness(t, { service: { now: () => clock, maxEntries: 2, maxBytes: 6 } });
  await service.connect({ path: 'COM2', config: CONFIG });
  ports[0].emit('data', Buffer.from('ABC'));
  clock += 1;
  ports[0].emit('data', Buffer.from('DEF'));
  clock += 1;
  ports[0].emit('data', Buffer.from('GHI'));
  await delay(115);
  assert.equal(changes[0].entries.length, 1);
  assert.equal(changes[0].entries[0].text, 'GHI');
  assert.equal(changes[0].evicted, 1);
  assert.equal(changes[0].rxBytes, 9);
  const oldId = changes[0].entries[0].id;
  service.clear();
  clock += 1;
  ports[0].emit('data', Buffer.from('Z'));
  await delay(115);
  assert.equal(changes[1].reset, true);
  assert.deepEqual(changes[1].entries.map(entry => entry.text), ['Z']);
  assert.ok(changes[1].entries[0].id > oldId);
  assert.equal(changes[1].rxBytes, 1);
});

test('disconnection and a cancelled write preserve merged RX and never merge a later session', async t => {
  let clock = 1000;
  const { service, ports } = harness(t, { behavior: index => index ? {} : { manualWrite: true }, service: { now: () => clock } });
  await service.connect({ path: 'COM2', config: CONFIG });
  ports[0].emit('data', Buffer.from('A'));
  clock += 1;
  ports[0].emit('data', Buffer.from('B'));
  const failure = assert.rejects(service.send({ sessionId: service.snapshot().sessionId, mode: 'text', content: 'T', lineEnding: 'none' }), /结果无法确认/);
  clock += 1;
  ports[0].emit('data', Buffer.from('C'));
  await service.disconnect();
  await failure;
  await service.connect({ path: 'COM10', config: CONFIG });
  clock += 1;
  ports[1].emit('data', Buffer.from('D'));
  ports[0].finishWrite();
  assert.deepEqual(service.snapshot().entries.map(entry => entry.text), ['AB', 'C', 'D']);
  assert.notEqual(service.snapshot().entries[1].sessionId, service.snapshot().entries[2].sessionId);
  assert.equal(service.snapshot().txBytes, 0);
});
