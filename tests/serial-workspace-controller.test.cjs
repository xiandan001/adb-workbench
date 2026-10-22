const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSerialController } = require('../electron/lib/serial.cjs');
const { confirmSerialQuit } = require('../electron/lib/serial-quit.cjs');
const { formatSerialSnapshot } = require('../electron/lib/serial-export.cjs');

function fixture(saveSnapshot) {
  const calls = [];
  const states = Object.fromEntries(['rs232', 'terminal'].map((workspace, index) => [workspace, {
    workspace, revision: 3, unsaved: true, status: 'connected', path: `COM${index + 3}`, rxBytes: 1, txBytes: 1,
    entries: [{ id: 1, sessionId: workspace, direction: 'TX', path: `COM${index + 3}`, time: 100,
      bytes: 1, hex: index ? '0d' : 'aa', text: index ? '\r' : '�', config: { baudRate: index ? 921600 : 9600 } }]
  }]));
  const services = Object.fromEntries(Object.keys(states).map(workspace => [workspace, {
    snapshot: () => structuredClone(states[workspace]),
    listPorts: async () => [{ path: 'COM3' }, { path: 'COM4' }],
    connect: async args => calls.push({ workspace, action: 'connect', args }),
    disconnect: async () => calls.push({ workspace, action: 'disconnect' }),
    send: async args => calls.push({ workspace, action: 'send', args }),
    terminalRead: args => ({ ...args, hex: '41' }),
    terminalWrite: async args => { calls.push({ workspace, action: 'terminalWrite', args }); return { bytes: 1 }; },
    sealReceive: () => calls.push({ workspace, action: 'seal' }),
    clear: () => { states[workspace].entries = []; states[workspace].unsaved = false; calls.push({ workspace, action: 'clear' }); },
    markSaved: revision => { states[workspace].unsaved = states[workspace].revision > revision; calls.push({ workspace, action: 'saved', revision }); },
    needsQuitConfirmation: () => states[workspace].unsaved || states[workspace].status === 'connected'
  }]));
  const workspaces = {
    get: workspace => { if (!services[workspace]) throw new Error('工作区无效'); return services[workspace]; },
    snapshot: workspace => services[workspace].snapshot(),
    snapshots: () => Object.fromEntries(Object.keys(states).map(workspace => [workspace, services[workspace].snapshot()])),
    needsQuitConfirmation: () => Object.values(services).some(service => service.needsQuitConfirmation())
  };
  const sender = new EventEmitter(); sender.isDestroyed = () => false;
  sender.send = (channel, data) => calls.push({ channel, data });
  const owner = { webContents: sender, isDestroyed: () => false, isVisible: () => true, isMinimized: () => false };
  const controller = createSerialController({ workspaces, getOwner: () => owner, saveSnapshot: saveSnapshot || (async data => {
    calls.push({ workspace: data.workspace, action: 'export', data }); return { success: true, path: data.workspace + '.log' };
  }) });
  const handlers = new Map(); controller.register({ handle: (name, handler) => handlers.set(name, handler) });
  const invoke = (channel, args) => handlers.get(channel)({ sender }, args);
  return { states, services, workspaces, calls, controller, handlers, sender, invoke };
}

test('workspace IPC routes overlapping record IDs and revisions without mixing either stream', async () => {
  const h = fixture();
  const subscription = await h.invoke('serial:subscribe', { active: true });
  assert.equal(subscription.snapshots.rs232.entries[0].hex, 'aa');
  assert.equal(subscription.snapshots.terminal.entries[0].hex, '0d');
  await h.invoke('serial:send', { workspace: 'rs232', mode: 'hex', content: 'AA', lineEnding: 'none' });
  await h.invoke('serial:terminal-write', { workspace: 'rs232', sessionId: 'terminal', content: '\r' });
  assert.deepEqual(h.calls.filter(call => ['send', 'terminalWrite'].includes(call.action)).map(call => [call.workspace, call.action]), [
    ['rs232', 'send'], ['terminal', 'terminalWrite']
  ]);
  assert.equal((await h.invoke('serial:send', { workspace: 'terminal', mode: 'hex', content: 'AA' })).success, false);
  assert.equal((await h.invoke('serial:snapshot', { workspace: 'other' })).success, false);
  for (const workspace of ['', null, 0, {}]) assert.equal((await h.invoke('serial:snapshot', { workspace })).success, false);
  h.controller.publish({ workspace: 'terminal', revision: 4, entries: [{ id: 1, hex: '0d' }] });
  assert.equal(h.calls.at(-1).data.workspace, 'terminal');
});

test('clear and save affect only their explicit workspace including saved revisions', async () => {
  const h = fixture();
  await h.invoke('serial:save', { workspace: 'rs232' });
  assert.equal(h.states.rs232.unsaved, false);
  assert.equal(h.states.terminal.unsaved, true);
  assert.deepEqual(h.calls.filter(call => call.action === 'export').map(call => call.data.entries[0].hex), ['aa']);
  await h.invoke('serial:clear', { workspace: 'rs232' });
  assert.equal(h.states.rs232.entries.length, 0);
  assert.equal(h.states.terminal.entries[0].hex, '0d');
  await h.invoke('serial:save', { workspace: 'terminal' });
  assert.equal(h.calls.filter(call => call.action === 'export').at(-1).data.entries[0].hex, '0d');
});

test('save completion marks the captured workspace revision despite new data on either side', async () => {
  let finish;
  const h = fixture(async () => new Promise(resolve => { finish = resolve; }));
  const saving = h.invoke('serial:save', { workspace: 'terminal' });
  await new Promise(resolve => setImmediate(resolve));
  h.states.terminal.revision = 4;
  h.states.rs232.revision = 8;
  finish({ success: true, path: 'terminal.log' });
  assert.equal((await saving).success, true);
  assert.deepEqual(h.calls.filter(call => call.action === 'saved'), [{ workspace: 'terminal', action: 'saved', revision: 3 }]);
  assert.equal(h.states.terminal.unsaved, true);
  assert.equal(h.states.rs232.unsaved, true);
});

test('quit and migration protection see a dirty terminal even when RS232 is empty and clean', async () => {
  const h = fixture();
  Object.assign(h.states.rs232, { entries: [], unsaved: false, status: 'disconnected' });
  h.states.terminal.status = 'disconnected';
  assert.throws(() => h.controller.reserveForMigration(), /串口|终端/);
  let prompt;
  const exit = await confirmSerialQuit({ serial: h.workspaces, ask: async options => { prompt = options; return { response: 0 }; }, save: () => h.controller.saveAll() });
  assert.equal(exit, false);
  assert.match(prompt.message, /终端/);
  assert.match(prompt.buttons[0], /保存/);
  assert.deepEqual(h.calls.filter(call => call.action === 'export').map(call => call.workspace), ['terminal']);
  assert.equal(h.calls.some(call => call.action === 'disconnect'), false);
});

test('save-all cancellation preserves the unsaved workspace and never disconnects either port', async () => {
  const h = fixture(async snapshot => ({ success: true, cancelled: snapshot.workspace === 'terminal' }));
  const result = await h.controller.saveAll();
  assert.equal(result.cancelled, true);
  assert.equal(h.states.rs232.unsaved, false);
  assert.equal(h.states.terminal.unsaved, true);
  assert.equal(h.calls.some(call => call.action === 'disconnect'), false);
});

test('workspace export labels identify the originating interface and terminal control bytes stay exact', () => {
  const h = fixture();
  const text = formatSerialSnapshot(h.states.terminal);
  assert.match(text, /串口终端/);
  assert.match(text, /HEX: 0D/);
  assert.match(text, /原始终端数据/);
  assert.doesNotMatch(text, /CRC/);
  assert.match(formatSerialSnapshot(h.states.rs232), /RS232/);
});

test('unauthorized calls cannot leak either snapshot or perform terminal I/O', async () => {
  const h = fixture();
  for (const [name, handler] of h.handlers) {
    const result = await handler({ sender: {} }, { workspace: 'terminal', content: '\r', active: true });
    assert.equal(result.success, false, name);
    assert.equal(result.snapshot, undefined, name);
    assert.equal(result.snapshots, undefined, name);
  }
  assert.equal(h.calls.length, 0);
});

test('mutations require an explicit valid workspace instead of defaulting to the other interface', async () => {
  const h = fixture();
  for (const channel of ['connect', 'disconnect', 'send', 'clear', 'save']) {
    for (const workspace of [undefined, null, '', 0, 'unknown']) {
      const result = await h.invoke('serial:' + channel, { workspace, path: 'COM3', mode: 'hex', content: 'AA' });
      assert.equal(result.success, false, channel);
      assert.equal(result.snapshot, undefined, channel);
    }
  }
  assert.equal(h.calls.length, 0);
});

test('obsolete shared-service injection fails closed before loading native ports', () => {
  const serial = require('../electron/lib/serial.cjs');
  assert.throws(() => serial.register({}, { service: {} }), /分别初始化/);
});
