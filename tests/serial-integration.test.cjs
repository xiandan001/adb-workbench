const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createSerialController } = require('../electron/lib/serial.cjs');
const { formatSerialSnapshot, writeSerialSnapshot } = require('../electron/lib/serial-export.cjs');
const { confirmSerialQuit } = require('../electron/lib/serial-quit.cjs');

function fixture() {
  const snapshot = { revision: 3, path: 'COM12', status: 'connected', unsaved: true, evicted: 2,
    rxBytes: 2, txBytes: 0, entries: [{ id: 3, sessionId: 'one', path: 'COM12',
      config: { baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' },
      direction: 'RX', time: 1700000000000, bytes: 2, hex: '00FF', text: '\u0000�' }] };
  const calls = [];
  const sender = new EventEmitter(); sender.isDestroyed = () => false;
  sender.send = (channel, data) => calls.push({ channel, data });
  let visible = true;
  const owner = { webContents: sender, isDestroyed: () => false, isVisible: () => visible, isMinimized: () => false };
  const service = {
    listPorts: async () => [{ path: 'COM12' }], snapshot: () => structuredClone(snapshot),
    connect: async args => calls.push({ connect: args }), disconnect: async () => calls.push({ disconnect: true }),
    send: async args => calls.push({ send: args }), clear: () => calls.push({ clear: true }),
    markSaved: revision => calls.push({ saved: revision }), needsQuitConfirmation: () => true
  };
  const controller = createSerialController({ service, getOwner: () => owner,
    saveSnapshot: async data => { calls.push({ export: data }); return { success: true, path: 'snapshot.log' }; } });
  const handlers = new Map(); controller.register({ handle: (name, handler) => handlers.set(name, handler) });
  return { snapshot, sender, owner, service, controller, handlers, calls, hide: () => { visible = false; } };
}

test('serial IPC accepts main window only and never leaks a snapshot to other windows', async () => {
  const h = fixture();
  for (const [name, action] of h.handlers) {
    const result = await action({ sender: {} }, { path: 'COM12', active: true });
    assert.equal(result.success, false, name); assert.equal(result.snapshot, undefined, name);
  }
  assert.equal(h.calls.length, 0);
  assert.equal((await h.handlers.get('serial:list')({ sender: h.sender })).ports[0].path, 'COM12');
  assert.equal(h.calls.length, 0, 'enumeration cannot open or send');
});

test('connect checks current enumeration, subscription obeys visibility and reload', async () => {
  const h = fixture(); const event = { sender: h.sender };
  assert.equal((await h.handlers.get('serial:connect')(event, { path: 'COM8' })).success, false);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.handlers.get('serial:connect')(event, { path: 'COM12', config: {} })).success, true);
  await h.handlers.get('serial:subscribe')(event, { active: true });
  h.controller.publish({ revision: 1 });
  assert.equal(h.calls.at(-1).channel, 'serial:changed');
  const count = h.calls.length; h.hide(); h.controller.publish({ revision: 2 });
  assert.equal(h.calls.length, count);
  h.owner.isVisible = () => true; h.sender.emit('did-start-loading');
  h.controller.publish({ revision: 3 }); assert.equal(h.calls.length, count);
  assert.equal((await h.handlers.get('serial:subscribe')(event, { active: 'yes' })).success, false);
});

test('save exports an immutable revision and only marks that revision after success', async () => {
  const h = fixture();
  assert.equal((await h.controller.saveCurrent()).success, true);
  assert.equal(h.calls.find(call => call.saved).saved, 3);
  assert.equal(h.calls.find(call => call.export).export.entries[0].hex, '00FF');
  const cancelled = createSerialController({ service: h.service, getOwner: () => h.owner,
    saveSnapshot: async () => ({ success: true, cancelled: true }) });
  const count = h.calls.length;
  assert.equal((await cancelled.saveCurrent()).cancelled, true);
  assert.equal(h.calls.length, count);
});

test('pending connect blocks migration and reservation blocks late new connects', async () => {
  const h = fixture(); const event = { sender: h.sender };
  h.service.needsQuitConfirmation = () => false;
  let resolve;
  h.service.listPorts = () => new Promise(done => { resolve = done; });
  const pending = h.handlers.get('serial:connect')(event, { path: 'COM12' });
  assert.equal(h.controller.needsQuitConfirmation(), true);
  assert.throws(() => h.controller.reserveForMigration(), /串口/);
  await h.handlers.get('serial:disconnect')(event);
  resolve([{ path: 'COM12' }]);
  assert.equal((await pending).success, false);
  assert.equal(h.calls.some(call => call.connect), false);
  const release = h.controller.reserveForMigration();
  assert.equal((await h.handlers.get('serial:connect')(event, { path: 'COM12' })).success, false);
  release(); h.service.listPorts = async () => [{ path: 'COM12' }];
  assert.equal((await h.handlers.get('serial:connect')(event, { path: 'COM12' })).success, true);
});

test('serial export preserves binary evidence, scope and safe atomic file writes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'serial-export-test-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const snapshot = fixture().snapshot;
  const formatted = formatSerialSnapshot(snapshot);
  assert.match(formatted, /COM12/); assert.match(formatted, /9600/); assert.match(formatted, /00FF/);
  assert.match(formatted, /截断|移出/); assert.match(formatted, /\\u0000/);
  const output = path.join(root, 'capture.log');
  await writeSerialSnapshot(output, snapshot);
  assert.equal(fs.readFileSync(output, 'utf8').replace(/^导出时间：.*$/m, ''), formatted.replace(/^导出时间：.*$/m, ''));
  await assert.rejects(writeSerialSnapshot(path.join(root, 'capture.exe'), snapshot), /log|txt/);
  await assert.rejects(writeSerialSnapshot(root, snapshot));
  const linked = path.join(root, 'linked.log'); fs.linkSync(output, linked);
  await assert.rejects(writeSerialSnapshot(linked, snapshot), /链接|普通/);
  assert.deepEqual(fs.readdirSync(root).sort(), ['capture.log', 'linked.log']);
});

test('quit cancel/save leaves the connection untouched; only explicit exit proceeds', async () => {
  const h = fixture(); let saved = 0;
  const args = { serial: h.service, save: async () => { saved++; }, ask: async () => ({ response: 2 }) };
  assert.equal(await confirmSerialQuit(args), false); assert.equal(h.calls.length, 0);
  assert.equal(await confirmSerialQuit({ ...args, ask: async () => ({ response: 0 }) }), false);
  assert.equal(saved, 1); assert.equal(h.calls.length, 0);
  assert.equal(await confirmSerialQuit({ ...args, ask: async () => ({ response: 1 }) }), true);
  h.service.needsQuitConfirmation = () => false;
  assert.equal(await confirmSerialQuit({ ...args, ask: () => assert.fail('no prompt needed') }), true);
});
