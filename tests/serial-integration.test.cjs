const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createSerialController } = require('../electron/lib/serial.cjs');
const { createSerialWorkspaces } = require('../electron/lib/serial-workspaces.cjs');
const { formatSerialSnapshot, writeSerialSnapshot } = require('../electron/lib/serial-export.cjs');
const { confirmSerialQuit } = require('../electron/lib/serial-quit.cjs');

function fixture() {
  const snapshot = { revision: 3, path: 'COM12', status: 'disconnected', unsaved: true, evicted: 2,
    rxBytes: 2, txBytes: 0, entries: [{ id: 3, sessionId: 'one', path: 'COM12',
      config: { baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' },
      direction: 'RX', time: 1700000000000, bytes: 2, hex: '00FF', text: '\u0000�' }] };
  const calls = [];
  const controls = { clean: false, list: async () => [{ path: 'COM12' }] };
  let connected = false;
  const sender = new EventEmitter(); sender.isDestroyed = () => false;
  sender.send = (channel, data) => calls.push({ channel, data });
  let visible = true;
  const owner = { webContents: sender, isDestroyed: () => false, isVisible: () => visible, isMinimized: () => false };
  const service = {
    listPorts: () => controls.list(), snapshot: () => structuredClone(snapshot),
    connect: async args => { connected = true; calls.push({ connect: args }); },
    disconnect: async () => { connected = false; calls.push({ disconnect: true }); },
    send: async args => calls.push({ send: args }), clear: () => calls.push({ clear: true }),
    sealReceive: () => calls.push({ seal: true }),
    markSaved: revision => calls.push({ saved: revision }), needsQuitConfirmation: () => !controls.clean,
    hasActiveConnection: () => connected, dispose: async () => { connected = false; }
  };
  const terminal = { ...service, snapshot: () => ({ ...structuredClone(snapshot), entries: [], unsaved: false }),
    needsQuitConfirmation: () => false, hasActiveConnection: () => false };
  const workspaces = createSerialWorkspaces({ createService: workspace => workspace === 'rs232' ? service : terminal });
  const controller = createSerialController({ workspaces, getOwner: () => owner,
    saveSnapshot: async data => { calls.push({ export: data }); return { success: true, path: 'snapshot.log' }; } });
  const handlers = new Map(); controller.register({ handle: (name, handler) => handlers.set(name, handler) });
  return { snapshot, sender, owner, service, workspaces, controls, controller, handlers, calls, hide: () => { visible = false; } };
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
  assert.equal((await h.handlers.get('serial:connect')(event, { workspace: 'rs232', path: 'COM8' })).success, false);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.handlers.get('serial:connect')(event, { workspace: 'rs232', path: 'COM12', config: {} })).success, true);
  await h.handlers.get('serial:subscribe')(event, { active: true });
  h.controller.publish({ workspace: 'rs232', revision: 1 });
  assert.equal(h.calls.at(-1).channel, 'serial:changed');
  const count = h.calls.length; h.hide(); h.controller.publish({ workspace: 'rs232', revision: 2 });
  assert.equal(h.calls.length, count);
  h.owner.isVisible = () => true; h.sender.emit('did-start-loading');
  h.controller.publish({ workspace: 'rs232', revision: 3 }); assert.equal(h.calls.length, count);
  assert.equal((await h.handlers.get('serial:subscribe')(event, { active: 'yes' })).success, false);
});

test('save exports an immutable revision and only marks that revision after success', async () => {
  const h = fixture();
  assert.equal((await h.controller.saveCurrent()).success, true);
  assert.equal(h.calls.find(call => call.saved).saved, 3);
  assert.equal(h.calls[0].seal, true, 'seal the receive segment before the export snapshot');
  assert.equal(h.calls.find(call => call.export).export.entries[0].hex, '00FF');
  const cancelled = createSerialController({ workspaces: h.workspaces, getOwner: () => h.owner,
    saveSnapshot: async () => ({ success: true, cancelled: true }) });
  const count = h.calls.length;
  assert.equal((await cancelled.saveCurrent()).cancelled, true);
  assert.deepEqual(h.calls.slice(count), [{ seal: true }]);
});

test('pending connect blocks migration and reservation blocks late new connects', async () => {
  const h = fixture(); const event = { sender: h.sender };
  h.controls.clean = true;
  let resolve;
  h.controls.list = () => new Promise(done => { resolve = done; });
  const pending = h.handlers.get('serial:connect')(event, { workspace: 'rs232', path: 'COM12' });
  assert.equal(h.controller.needsQuitConfirmation(), true);
  assert.throws(() => h.controller.reserveForMigration(), /串口/);
  await h.handlers.get('serial:disconnect')(event, { workspace: 'rs232' });
  resolve([{ path: 'COM12' }]);
  assert.equal((await pending).success, false);
  assert.equal(h.calls.some(call => call.connect), false);
  const release = h.controller.reserveForMigration();
  assert.equal((await h.handlers.get('serial:connect')(event, { workspace: 'rs232', path: 'COM12' })).success, false);
  release(); h.controls.list = async () => [{ path: 'COM12' }];
  assert.equal((await h.handlers.get('serial:connect')(event, { workspace: 'rs232', path: 'COM12' })).success, true);
});

test('serial export preserves binary evidence, scope and safe atomic file writes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'serial-export-test-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const snapshot = fixture().snapshot;
  const formatted = formatSerialSnapshot(snapshot);
  assert.match(formatted, /COM12/); assert.match(formatted, /9600/); assert.match(formatted, /HEX: 00 FF/);
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

test('export renders the user HEX response with readable ASCII without changing binary evidence', () => {
  const snapshot = fixture().snapshot;
  Object.assign(snapshot.entries[0], { hex: 'ab050adf4e', bytes: 5, parts: 2, endTime: 1700000000010 });
  const formatted = formatSerialSnapshot(snapshot);
  assert.ok(formatted.includes('HEX: AB 05 0A DF 4E'));
  const slash = String.fromCharCode(92);
  assert.ok(formatted.includes(`ASCII: ${slash}xAB${slash}x05${slash}n${slash}xDFN`));
  assert.match(formatted, /合并.*2/);
  assert.equal(snapshot.entries[0].hex, 'ab050adf4e');
});

test('quit cancel/save leaves the connection untouched; only explicit exit proceeds', async () => {
  const h = fixture(); let saved = 0;
  const args = { serial: h.workspaces, save: async () => { saved++; }, ask: async () => ({ response: 2 }) };
  assert.equal(await confirmSerialQuit(args), false); assert.equal(h.calls.length, 0);
  assert.equal(await confirmSerialQuit({ ...args, ask: async () => ({ response: 0 }) }), false);
  assert.equal(saved, 1); assert.equal(h.calls.length, 0);
  assert.equal(await confirmSerialQuit({ ...args, ask: async () => ({ response: 1 }) }), true);
  h.controls.clean = true;
  assert.equal(await confirmSerialQuit({ ...args, ask: () => assert.fail('no prompt needed') }), true);
});

test('export describes canonical AB frames and preserves separate rows and unrecognized bytes', () => {
  const snapshot = fixture().snapshot;
  const base = snapshot.entries[0];
  snapshot.rxBytes = 27;
  snapshot.entries = [
    { ...base, id: 3, kind: 'frame', protocol: 'ab', hex: 'ab050adf4e', bytes: 5, parts: 1 },
    { ...base, id: 4, kind: 'frame', protocol: 'ab', hex: 'ab07984401860b', bytes: 7, parts: 1 },
    { ...base, id: 5, kind: 'pending', hex: 'ab07', bytes: 2, parts: 1 },
    { ...base, id: 6, kind: 'raw', hex: 'ff', bytes: 1, parts: 1 },
    { ...base, id: 7, kind: 'frame', protocol: 'xbh', hex: 'fe09584248434d4401f101cf', bytes: 12, parts: 3 }
  ];
  const formatted = formatSerialSnapshot(snapshot);
  assert.deepEqual([...formatted.matchAll(/^HEX: (.*)$/gm)].map(match => match[1]), [
    'AB 05 0A DF 4E', 'AB 07 98 44 01 86 0B', 'AB 07', 'FF', 'FE 09 58 42 48 43 4D 44 01 F1 01 CF'
  ]);
  assert.equal((formatted.match(/记录类型：完整报文（AB 长度与 CRC 已校验）/g) || []).length, 2);
  assert.match(formatted, /记录类型：待补齐（原始字节已保留）/);
  assert.match(formatted, /记录类型：完整报文（FE \/ XBHCMD 长度、固定标识与包尾已校验）/);
  assert.match(formatted, /记录类型：原始数据（未识别为完整 AB 或 FE 报文）/);
  assert.doesNotMatch(formatted, /每行最多 2 段/);
});
