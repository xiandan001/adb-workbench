const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createIpControlService } = require('../electron/lib/ip-control-service.cjs');
const { registerIpControl } = require('../electron/lib/ip-control-ipc.cjs');
const { ipConnectionStatus, serialConnectionStatus } = require('../electron/lib/connection-status.cjs');

test('RS232 and terminal remain independently navigable; server listen, peer and UDP ready count one local session', () => {
  const summary = serialConnectionStatus({ rs232: { path: 'COM1', status: 'connected' }, terminal: { path: 'COM2', status: 'error', unsaved: true } });
  assert.equal(summary.activeCount, 1);
  assert.equal(summary.workspaces.rs232.activeCount, 1);
  assert.deepEqual(summary.workspaces.terminal.labels, ['COM2']);
  assert.equal(summary.workspaces.terminal.failedCount, 1);
  for (const [mode, phase] of [['tcp-server', 'listening'], ['tcp-server', 'connected'], ['udp', 'ready']]) {
    const value = ipConnectionStatus({ mode, status: phase, host: '::1', port: 8192, peerHost: phase === 'connected' ? '127.0.0.1' : '', peerPort: 10000, entries: ['PRIVATE'] });
    assert.equal(value.activeCount, 1); assert.equal(value.phase, phase); assert.equal(value.labels[0], '[::1]:8192');
    assert.ok(!JSON.stringify(value).includes('PRIVATE'));
  }
});

test('status-only subscription never opens a socket or reads traffic; changes publish only to the visible owner', async () => {
  const handlers = new Map(), events = [], sockets = [];
  const frame = { url: pathToFileURL(path.resolve('dist/index.html')).href };
  const sender = Object.assign(new EventEmitter(), { mainFrame: frame, isDestroyed: () => false, send: (channel, value) => events.push({channel, value}) });
  let visible = true;
  const owner = { webContents: sender, isVisible: () => visible, isMinimized: () => false, isDestroyed: () => false };
  const dispose = registerIpControl({ handle: (name, fn) => handlers.set(name, fn) }, { getOwner: () => owner, appRoot: path.resolve('.'), isDev: false,
    history: { record: async () => ({ok:true}), flush() {} }, createService: options => {
      const service = createIpControlService({ ...options, createSocket: () => {
        const socket = Object.assign(new EventEmitter(), { connect() {}, destroy() {} }); sockets.push(socket); return socket;
      } });
      service.read = () => { throw Error('status must not touch the byte buffer'); }; return service;
    } });
  const invoke = (name, args, senderFrame = frame) => handlers.get('ip-control:' + name)({sender, senderFrame}, args);
  try {
    assert.equal((await invoke('connection-status-subscribe', {active:true}, {url:frame.url})).code, 'NOT_AUTHORIZED');
    assert.equal((await invoke('connection-status-subscribe', {active:true})).status.activeCount, 0); assert.equal(sockets.length, 0);
    const pending = invoke('connect', { host:'127.0.0.1', port:8192 }); sockets[0].emit('connect');
    const { sessionId } = await pending;
    sockets[0].emit('data', Buffer.from('PRIVATE'));
    assert.deepEqual(events.map(e=>e.value.phase), ['connecting', 'connected']);
    assert.ok(events.every(e=>e.channel === 'ip-control:connection-status' && !('entries' in e.value) && !('sessionId' in e.value)));
    visible = false; await invoke('disconnect', {sessionId}); assert.equal(events.length, 2);
    visible = true; assert.equal((await invoke('connection-status-subscribe', {active:true})).status.phase, 'idle');
    await invoke('connection-status-subscribe', {active:false});
    const again = invoke('connect', {host:'127.0.0.1',port:8192}); sockets[1].emit('connect'); await again;
    assert.equal(events.length, 2);
    assert.equal((await invoke('connection-status-subscribe',{active:true})).status.activeCount,1);
    sockets[1].emit('end'); assert.equal(events.at(-1).value.failedCount,1); assert.equal(events.at(-1).value.activeCount,0);
  } finally { await dispose(); }
});
