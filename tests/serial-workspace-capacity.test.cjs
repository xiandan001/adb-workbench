const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');

const lib = path.resolve(__dirname, '../electron/lib');
function load(name, override, globals = {}) {
  const file = path.join(lib, name); const localRequire = createRequire(file); const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports,Buffer){${fs.readFileSync(file, 'utf8')}\n})`)(
    dependency => override(dependency) || localRequire(dependency), module, module.exports, globals.Buffer || Buffer);
  return module.exports;
}

test('production controller routes large replay only to terminal; RS232 records never allocate the raw ring', async t => {
  const allocations = [], configurations = [], ports = [];
  const buffers = load('serial-terminal-buffer.cjs', () => null, { Buffer: {
    isBuffer: Buffer.isBuffer, alloc: size => { allocations.push(size); return Buffer.alloc(size); }
  } });
  const services = load('serial-service.cjs', name => name === './serial-terminal-buffer.cjs' ? buffers : null);
  const owner = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false,
    webContents: Object.assign(new EventEmitter(), { isDestroyed: () => false, send() {} }) };
  class FakePort extends EventEmitter {
    static async list() { return [{ path: 'COM3' }, { path: 'COM17' }]; }
    constructor(options) { super(); this.options = options; this.isOpen = false; ports.push(this); }
    open(callback) { this.isOpen = true; queueMicrotask(() => callback()); }
    close(callback) { this.isOpen = false; this.emit('close'); queueMicrotask(() => callback()); }
    write(_data, callback) { queueMicrotask(() => callback()); }
    drain(callback) { queueMicrotask(() => callback()); }
  }
  const serial = load('serial.cjs', name => {
    if (name === 'electron') return { app: { getPath: () => assert.fail('No real profile or downloads access') }, dialog: { showSaveDialog: () => assert.fail('No save dialog in capacity fixture') } };
    if (name === './app-context.cjs') return { getMainWindow: () => owner };
    if (name === './serial-service.cjs') return { createSerialService: options => { configurations.push(options.terminalReplayBytes); return services.createSerialService(options); } };
    if (name === 'serialport') return { SerialPort: FakePort };
    return null;
  });
  const handlers = new Map(); serial.register({ handle: (name, callback) => handlers.set(name, callback) });
  t.after(() => serial.cleanup());
  const invoke = (channel, args) => handlers.get(channel)({ sender: owner.webContents }, args);
  const config = { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' };
  assert.deepEqual(configurations, [0, 16 * 1024 * 1024]); assert.deepEqual(allocations, []);
  assert.equal((await invoke('serial:connect', { workspace: 'rs232', path: 'COM3', config })).success, true);
  ports[0].emit('data', Buffer.from('ab050adf4e', 'hex'));
  assert.equal(serial.snapshot('rs232').entries.length, 1); assert.deepEqual(allocations, []);
  assert.equal((await invoke('serial:connect', { workspace: 'terminal', path: 'COM17', config })).success, true);
  assert.deepEqual(allocations, [], 'Connecting alone must not allocate replay memory');
  const row = Buffer.alloc(500, 0x61); row[499] = 10;
  const expected = createHash('sha256');
  for (let index = 0; index < 10000; index++) { ports[1].emit('data', row); expected.update(row); }
  assert.deepEqual(allocations, [16 * 1024 * 1024]);
  const snapshot = (await invoke('serial:snapshot', { workspace: 'terminal' })).snapshot;
  assert.equal(snapshot.entries.length, 10000); assert.equal(snapshot.evicted, 0); assert.equal(snapshot.rxBytes, 5000000);
  const actual = createHash('sha256'); let offset = 0;
  while (offset < snapshot.rxBytes) {
    const result = await invoke('serial:terminal-read', { sessionId: snapshot.sessionId, offset });
    assert.equal(result.success, true); assert.equal(result.truncated, false); assert.equal(result.startOffset, 0);
    assert.ok(result.nextOffset > offset && result.nextOffset - offset <= 64 * 1024);
    actual.update(Buffer.from(result.hex, 'hex')); offset = result.nextOffset;
  }
  assert.equal(actual.digest('hex'), expected.digest('hex'));
  assert.equal(serial.snapshot('rs232').rxBytes, 5); assert.equal(serial.snapshot('rs232').entries.length, 1);
});
