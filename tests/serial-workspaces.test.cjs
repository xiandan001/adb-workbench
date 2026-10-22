const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSerialWorkspaces } = require('../electron/lib/serial-workspaces.cjs');
const { createSerialService } = require('../electron/lib/serial-service.cjs');
const { DEFAULT_CONFIG } = require('../electron/lib/serial-policy.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

class Port extends EventEmitter {
  constructor(options, behavior) { super(); this.options = options; this.behavior = behavior; this.isOpen = false; this.writes = []; this.closeCalls = 0; }
  open(callback) {
    this.finishOpen = error => { this.isOpen = !error; callback(error); };
    if (!this.behavior.manualOpen) queueMicrotask(() => this.finishOpen(this.behavior.openError));
  }
  write(bytes, callback) { this.writes.push(Buffer.from(bytes)); queueMicrotask(callback); }
  drain(callback) { queueMicrotask(callback); }
  close(callback) {
    this.closeCalls++;
    this.finishClose = error => { if (!error) { this.isOpen = false; this.emit('close'); } callback(error); };
    if (!this.behavior.manualClose) queueMicrotask(() => this.finishClose(this.behavior.closeError));
  }
}

function fixture(t, options = {}) {
  const ports = { rs232: [], terminal: [] };
  const services = {};
  const events = [];
  const created = [];
  const manager = createSerialWorkspaces({
    onChange: event => events.push(event),
    createService: (workspace, onChange) => {
      created.push(workspace);
      services[workspace] = createSerialService({
        listPorts: () => options.list?.[workspace]?.() || Promise.resolve([{ path: 'COM17' }, { path: 'COM3' }]),
        createPort: config => {
          const behavior = options.behavior?.[workspace] || {};
          const port = new Port(config, behavior); ports[workspace].push(port); return port;
        },
        onChange, mergeReceive: workspace === 'rs232', writeTimeoutMs: 40, closeTimeoutMs: 30
      });
      return services[workspace];
    }
  });
  t.after(() => manager.dispose().catch(() => {}));
  return { manager, ports, services, events, created };
}

test('manager creates exactly two workspaces and defaults only omitted workspace values', t => {
  const { manager, created } = fixture(t);
  assert.deepEqual(created, ['rs232', 'terminal']);
  assert.equal(manager.snapshot().workspace, 'rs232');
  assert.equal(manager.snapshot().reservedPort, '');
  assert.equal(manager.get('terminal').snapshot().workspace, 'terminal');
  assert.deepEqual(Object.keys(manager.snapshots()).sort(), ['rs232', 'terminal']);
  for (const invalid of ['', null, 'hex', 'other', {}]) {
    assert.throws(() => manager.get(invalid), /工作区|模式/);
    assert.throws(() => manager.snapshot(invalid), /工作区|模式/);
  }
  assert.equal(manager.needsQuitConfirmation(), false);
});

test('two COM ports retain independent connections, parameters, records, counters and dirty flags', async t => {
  const { manager, ports, events } = fixture(t);
  await manager.connect('rs232', { path: 'COM17', config: DEFAULT_CONFIG });
  await manager.connect('terminal', { path: 'COM3', config: { ...DEFAULT_CONFIG, baudRate: 921600 } });
  const rs = manager.get('rs232'); const terminal = manager.get('terminal');
  const rsId = rs.snapshot().sessionId; const terminalId = terminal.snapshot().sessionId;
  assert.notEqual(rsId, terminalId);
  await terminal.terminalWrite({ sessionId: terminalId, content: '\r\r\r' });
  assert.equal(rs.snapshot().txBytes, 0);
  assert.deepEqual(rs.snapshot().entries, []);
  ports.rs232[0].emit('data', Buffer.from('ab050adf4eab07984401860b', 'hex'));
  ports.terminal[0].emit('data', Buffer.from('debug output\r\n'));
  assert.equal(rs.snapshot().rxBytes, 12);
  assert.equal(rs.snapshot().entries.length, 2);
  assert.equal(terminal.snapshot().txBytes, 3);
  assert.equal(terminal.snapshot().rxBytes, 14);
  assert.equal(terminal.terminalRead({ sessionId: terminalId, offset: 0 }).hex, Buffer.from('debug output\r\n').toString('hex'));
  assert.equal(terminal.snapshot().config.baudRate, 921600);
  assert.equal(rs.snapshot().config.baudRate, 9600);
  terminal.clear();
  assert.equal(terminal.snapshot().unsaved, false);
  assert.equal(rs.snapshot().unsaved, true);
  assert.equal(manager.needsQuitConfirmation(), true);
  await manager.disconnect('terminal');
  assert.equal(rs.snapshot().status, 'connected');
  assert.equal(ports.rs232[0].closeCalls, 0);
  await delay(115);
  assert.ok(events.some(event => event.workspace === 'rs232'));
  assert.ok(events.some(event => event.workspace === 'terminal'));
});

test('same COM is reserved before delayed enumeration and aliases cannot bypass the lease', async t => {
  const listing = deferred();
  const { manager, ports, services, events } = fixture(t, { list: { rs232: () => listing.promise } });
  const pending = manager.connect('rs232', { path: 'COM17', config: DEFAULT_CONFIG });
  assert.equal(manager.needsQuitConfirmation(), true);
  const subscribed = manager.snapshots().rs232;
  assert.equal(subscribed.status, 'connecting');
  assert.equal(subscribed.path, 'COM17');
  assert.equal(subscribed.reservedPort, 'COM17');
  assert.equal(services.rs232.snapshot().status, 'disconnected', 'projection must not mutate the native service state');
  assert.equal(subscribed.revision, services.rs232.snapshot().revision);
  services.rs232.clear();
  await delay(115);
  const projected = events.filter(event => event.workspace === 'rs232').at(-1);
  assert.equal(projected.status, 'connecting');
  assert.equal(projected.path, 'COM17');
  assert.equal(projected.reservedPort, 'COM17');
  for (const path of ['COM17', 'com17', '\\\\.\\COM17', '\\\\?\\com017']) {
    await assert.rejects(manager.connect('terminal', { path, config: DEFAULT_CONFIG }), error => error.code === 'SERIAL_PORT_IN_USE');
  }
  assert.equal(ports.terminal.length, 0);
  listing.resolve([{ path: 'COM17' }]);
  await pending;
  await assert.rejects(manager.get('terminal').connect({ path: 'COM17', config: DEFAULT_CONFIG }), error => error.code === 'SERIAL_PORT_IN_USE');
});

test('disconnect cancels a pending list without opening later or releasing a new owner lease', async t => {
  const listing = deferred();
  const { manager, ports } = fixture(t, { list: { rs232: () => listing.promise } });
  const old = manager.connect('rs232', { path: 'COM17', config: DEFAULT_CONFIG });
  const cancelled = assert.rejects(old, /取消/);
  await manager.disconnect('rs232');
  await manager.connect('terminal', { path: 'COM17', config: DEFAULT_CONFIG });
  listing.resolve([{ path: 'COM17' }]); await cancelled;
  assert.equal(ports.rs232.length, 0);
  assert.equal(ports.terminal.length, 1);
  await assert.rejects(manager.connect('rs232', { path: 'COM17', config: DEFAULT_CONFIG }), error => error.code === 'SERIAL_PORT_IN_USE');
});

test('a cancelled old enumeration cannot release a newer lease in the same workspace', async t => {
  const listing = deferred(); let calls = 0;
  const { manager, ports } = fixture(t, { list: { rs232: () => ++calls === 1 ? listing.promise : Promise.resolve([{ path: 'COM17' }]) } });
  const previous = manager.connect('rs232', { path: 'COM17', config: DEFAULT_CONFIG });
  const cancelled = assert.rejects(previous, /取消/);
  await manager.disconnect('rs232');
  await manager.connect('rs232', { path: 'COM17', config: DEFAULT_CONFIG });
  const currentId = manager.snapshot('rs232').sessionId;
  listing.resolve([{ path: 'COM17' }]); await cancelled;
  assert.equal(ports.rs232.length, 1);
  assert.equal(manager.snapshot('rs232').sessionId, currentId);
  await assert.rejects(manager.connect('terminal', { path: 'COM17', config: DEFAULT_CONFIG }), error => error.code === 'SERIAL_PORT_IN_USE');
});

test('native pending open remains reserved through cancelled-open timeout until the late handle closes', async t => {
  const { manager, ports } = fixture(t, { behavior: { rs232: { manualOpen: true } } });
  const opening = manager.connect('rs232', { path: 'COM17', config: DEFAULT_CONFIG });
  const cancelled = assert.rejects(opening, /取消|断开/);
  await delay(1);
  await assert.rejects(manager.connect('terminal', { path: 'COM17', config: DEFAULT_CONFIG }), error => error.code === 'SERIAL_PORT_IN_USE');
  await assert.rejects(manager.disconnect('rs232'), /超时|释放/);
  await cancelled;
  await assert.rejects(manager.connect('terminal', { path: 'COM17', config: DEFAULT_CONFIG }), error => error.code === 'SERIAL_PORT_IN_USE');
  ports.rs232[0].finishOpen();
  await delay(5);
  await manager.connect('terminal', { path: 'COM17', config: DEFAULT_CONFIG });
  assert.equal(ports.rs232[0].closeCalls, 1);
});

test('failed open releases ownership but failed close retains it until actual release', async t => {
  const behavior = { openError: new Error('port busy') };
  const { manager, ports, events } = fixture(t, { behavior: { rs232: behavior } });
  await assert.rejects(manager.connect('rs232', { path: 'COM17', config: DEFAULT_CONFIG }));
  assert.equal(manager.snapshot('rs232').reservedPort, '');
  await manager.connect('terminal', { path: 'COM17', config: DEFAULT_CONFIG });
  await manager.disconnect('terminal');
  delete behavior.openError;
  behavior.closeError = new Error('cannot release handle');
  await manager.connect('rs232', { path: 'COM17', config: DEFAULT_CONFIG });
  await assert.rejects(manager.disconnect('rs232'), /关闭|释放/);
  assert.equal(manager.snapshot('rs232').status, 'error');
  assert.equal(manager.snapshot('rs232').reservedPort, 'COM17');
  await delay(115);
  const retained = events.filter(event => event.workspace === 'rs232').at(-1);
  assert.equal(retained.status, 'error');
  assert.equal(retained.reservedPort, 'COM17');
  await assert.rejects(manager.connect('terminal', { path: 'COM17', config: DEFAULT_CONFIG }), error => error.code === 'SERIAL_PORT_IN_USE');
  assert.equal(ports.terminal.length, 1);
  delete behavior.closeError;
  await manager.disconnect('rs232');
  assert.equal(manager.snapshot('rs232').reservedPort, '');
  await delay(115);
  assert.equal(events.filter(event => event.workspace === 'rs232').at(-1).reservedPort, '');
  await manager.connect('terminal', { path: 'COM17', config: DEFAULT_CONFIG });
});

test('unsaved records do not retain a released port and quit protection aggregates both archives', async t => {
  const { manager, ports } = fixture(t);
  await manager.connect('rs232', { path: 'COM17', config: DEFAULT_CONFIG });
  ports.rs232[0].emit('data', Buffer.from('kept record'));
  await manager.disconnect('rs232');
  assert.equal(manager.snapshot('rs232').unsaved, true);
  await manager.connect('terminal', { path: 'COM17', config: DEFAULT_CONFIG });
  await manager.disconnect('terminal');
  assert.equal(manager.needsQuitConfirmation(), true);
  manager.get('rs232').markSaved(manager.snapshot('rs232').revision);
  assert.equal(manager.needsQuitConfirmation(), false);
});

test('stale native close callbacks cannot release a subsequently acquired workspace lease', async t => {
  const { manager, ports } = fixture(t, { behavior: { rs232: { manualClose: true } } });
  await manager.connect('rs232', { path: 'COM17', config: DEFAULT_CONFIG });
  await assert.rejects(manager.disconnect('rs232'), /超时|释放/);
  ports.rs232[0].finishClose();
  await manager.connect('terminal', { path: 'COM17', config: DEFAULT_CONFIG });
  ports.rs232[0].finishClose();
  ports.rs232[0].emit('error', new Error('old callback'));
  await assert.rejects(manager.connect('rs232', { path: 'COM17', config: DEFAULT_CONFIG }), error => error.code === 'SERIAL_PORT_IN_USE');
  assert.equal(manager.snapshot('terminal').status, 'connected');
});

test('both disposal paths run even when one close fails, and dispose cancels pending enumeration', async t => {
  const first = fixture(t, { behavior: { rs232: { closeError: new Error('held by driver') } } });
  await first.manager.connect('rs232', { path: 'COM17', config: DEFAULT_CONFIG });
  await first.manager.connect('terminal', { path: 'COM3', config: DEFAULT_CONFIG });
  await assert.rejects(first.manager.dispose(), /关闭|释放/);
  assert.equal(first.ports.rs232[0].closeCalls, 1);
  assert.equal(first.ports.terminal[0].closeCalls, 1);
  assert.equal(first.ports.terminal[0].isOpen, false);
  const listing = deferred(); const second = fixture(t, { list: { terminal: () => listing.promise } });
  const opening = second.manager.connect('terminal', { path: 'COM3', config: DEFAULT_CONFIG });
  const cancelled = assert.rejects(opening, /取消|退出/);
  await second.manager.dispose();
  listing.resolve([{ path: 'COM3' }]); await cancelled;
  assert.equal(second.ports.terminal.length, 0);
  await assert.rejects(second.manager.connect('rs232', { path: 'COM17', config: DEFAULT_CONFIG }), /退出|关闭/);
});

test('unavailable ports and invalid requests never leave stale reservations', async t => {
  const { manager, ports } = fixture(t);
  await assert.rejects(manager.connect('rs232', { path: 'COM9', config: DEFAULT_CONFIG }), /不可用|选择|串口/);
  await assert.rejects(manager.connect('rs232', { path: 'COM17\n', config: DEFAULT_CONFIG }), /串口/);
  await manager.connect('terminal', { path: 'COM17', config: DEFAULT_CONFIG });
  assert.equal(ports.rs232.length, 0);
  assert.equal(ports.terminal.length, 1);
});
