import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

async function fixture() {
  const callbacks = {}, decoders = [], acks = [], elements = new Map(), lifecycle = {};
  const element = id => {
    if (!elements.has(id)) elements.set(id, { dataset: {}, style: {}, parentElement: { clientWidth: 640, clientHeight: 360 }, width: 640, height: 360,
      addEventListener() {}, setAttribute() {}, getContext: () => ({ drawImage() {} }) });
    return elements.get(id);
  };
  const api = { init: async () => ({ success: true, labels: {}, session: { id: 'A', deviceId: 'hdc:A', status: 'streaming' } }),
    ready: async () => ({ success: true }), ack: async value => { acks.push(value); } };
  for (const name of ['onFrame', 'onState', 'onRecordCommand', 'onLocale', 'onRecordingState']) api[name] = callback => { callbacks[name] = callback; return () => {}; };
  const context = vm.createContext({ document: { getElementById: element, documentElement: {}, querySelectorAll: () => [] },
    window: { harmonyMedia: api, addEventListener: (name, fn) => { lifecycle[name] = fn; } }, ResizeObserver: class { observe() {} disconnect() {} },
    setCodecMessages() {}, createMediaRecorderController: () => ({ command() {}, dispose() {} }),
    createH264Decoder: options => { const item = { options, packets: [], disposed: false, push(packet) { this.packets.push(packet); }, dispose() { this.disposed = true; } }; decoders.push(item); return item; } });
  const source = fs.readFileSync(new URL('../electron/harmony-media-renderer.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
  vm.runInContext(source, context); await new Promise(resolve => setImmediate(resolve));
  return { callbacks, decoders, acks, lifecycle };
}
test('locale and same-session updates retain decoder lifetime and its first-frame progress', async () => {
  const h = await fixture(); h.callbacks.onFrame({ sessionId: 'A', sequence: 0 });
  h.callbacks.onLocale({ locale: 'ja-JP' }); h.callbacks.onState({ id: 'A', deviceId: 'hdc:A', status: 'streaming' });
  h.callbacks.onLocale({ locale: 'en-US' }); h.callbacks.onFrame({ sessionId: 'A', sequence: 1 });
  assert.equal(h.decoders.length, 1); assert.equal(h.decoders[0].packets.length, 2); assert.equal(h.decoders[0].disposed, false);
  h.lifecycle.beforeunload(); assert.equal(h.decoders[0].disposed, true);
});
test('new session disposes old decoding state and rejects packets from the old session', async () => {
  const h = await fixture(); h.callbacks.onState({ id: 'B', deviceId: 'hdc:B', status: 'streaming' });
  h.callbacks.onFrame({ sessionId: 'A', sequence: 1 }); h.callbacks.onFrame({ sessionId: 'B', sequence: 0 });
  assert.equal(h.decoders[0].disposed, true); assert.equal(h.decoders[1].packets.length, 1); assert.equal(h.decoders[1].packets[0].sessionId, 'B');
  const ack = { sessionId: 'B', sequence: 0, diagnostic: { stage: 'submitted' } };
  h.decoders[1].options.acknowledge(ack); assert.equal(h.acks[0], ack); h.lifecycle.beforeunload();
});
