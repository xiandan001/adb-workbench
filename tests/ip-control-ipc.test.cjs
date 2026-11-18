const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerIpControl } = require('../electron/lib/ip-control-ipc.cjs');
const url = pathToFileURL(path.resolve('dist/index.html')).href;
function fixture() {
  const handlers = new Map(), services = [];
  const contents = Object.assign(new EventEmitter(), { mainFrame: { url }, isDestroyed: () => false });
  const owner = { webContents: contents, isDestroyed: () => false };
  const dispose = registerIpControl({ handle: (name, fn) => handlers.set(name, fn) }, {
    getOwner: () => owner, appRoot: path.resolve('.'), isDev: false, createService() {
      const calls = []; let close, opened = new Promise(resolve => { close = resolve; });
      const service = { calls, connect: () => opened, read: () => ({ ok: true }), send: args => { calls.push(args); return { ok: true }; },
        dispose() { calls.push('dispose'); close({ ok: false, code: 'CANCELLED' }); } };
      services.push(service); return service;
    }
  });
  return { contents, services, dispose, invoke(name, args, event = { sender: contents, senderFrame: contents.mainFrame }) { return handlers.get('ip-control:' + name)(event, args); } };
}
test('only the packaged main document has access: no socket for another window, subframe or unexpected document', async () => {
  const f = fixture();
  for (const event of [{ sender: {}, senderFrame: f.contents.mainFrame }, { sender: f.contents, senderFrame: { url } }]) {
    assert.equal((await f.invoke('connect', {}, event)).code, 'NOT_AUTHORIZED');
  }
  f.contents.mainFrame.url = 'https://example.invalid/'; assert.equal((await f.invoke('read')).code, 'NOT_AUTHORIZED');
  assert.equal(f.services.length, 0); f.dispose();
});
test('changing tabs does not reconnect; losing the document disposes the session and fences late replies', async () => {
  const f = fixture(), pending = f.invoke('connect', {});
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  await f.invoke('read'); assert.equal(f.services.length, 1);
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.equal((await pending).code, 'NOT_AUTHORIZED'); assert.deepEqual(f.services[0].calls, ['dispose']);
  f.contents.mainFrame = { url }; await f.invoke('read');
  f.contents.emit('render-process-gone'); assert.deepEqual(f.services[1].calls, ['dispose']);
  await f.invoke('read'); f.dispose(); assert.deepEqual(f.services[2].calls, ['dispose']); assert.equal((await f.invoke('read')).code, 'NOT_AUTHORIZED');
});
