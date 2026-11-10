import test from 'node:test';
import assert from 'node:assert/strict';
import { createH264Decoder } from '../electron/harmony-media-decoder.js';
import diagnostics from '../electron/lib/harmony-media-diagnostics.cjs';

const join = (...nals) => Uint8Array.from(nals.flatMap(nal => [0, 0, 0, 1, ...nal]));
const key = join([0x67, 0x64, 0, 0x16, 0x80], [0x68, 0xc0], [0x65, 0x88]), delta = join([0x41, 0x88]);
function fixture({ hardware = 'output', software = 'output', paintThrows = false, timeoutMs = 20, liveOutput = false, rejectHardwareSupportLater = false } = {}) {
  const instances = [], acks = [], events = [], painted = [], closed = [], failures = [];
  class Decoder {
    static async isConfigSupported(config) {
      if (rejectHardwareSupportLater && config.hardwareAcceleration === 'prefer-hardware') return new Promise((_, reject) => setTimeout(() => reject(Error('late private rejection')), 30));
      return { supported: true };
    }
    constructor(callbacks) { this.callbacks = callbacks; this.state = 'unconfigured'; this.decodeQueueSize = 0; this.chunks = []; this.pending = []; this.flushes = 0; instances.push(this); }
    configure(config) { this.mode = config.hardwareAcceleration; this.state = 'configured'; this.needsKey = true; }
    decode(chunk) {
      if (this.needsKey && chunk.type !== 'key') throw Object.assign(Error('private device URL'), { name: 'DataError' });
      this.needsKey = false; this.chunks.push(chunk); this.pending.push(chunk);
      if (liveOutput && this.flushes && this.mode === 'prefer-software') queueMicrotask(() => this.output());
    }
    output(chunk = this.pending.shift()) {
      if (!chunk) return;
      this.callbacks.output({ timestamp: chunk.timestamp, close() { closed.push(chunk.timestamp); } });
    }
    flush() {
      this.flushes++; this.needsKey = true;
      const mode = this.mode === 'prefer-hardware' ? hardware : software;
      if (mode === 'pending') return new Promise(resolve => { this.release = () => { this.output(); resolve(); }; });
      if (mode === 'empty') return Promise.resolve();
      if (mode === 'reject') return Promise.reject(new DOMException('secret raw error', 'NotSupportedError'));
      return Promise.resolve().then(() => { if (this.state !== 'closed') this.output(); });
    }
    close() { this.state = 'closed'; }
  }
  const controller = createH264Decoder({ Decoder, Chunk: class { constructor(value) { Object.assign(this, value); } }, timeoutMs,
    acknowledge: value => acks.push(value), onDiagnostic: value => events.push(value),
    onFrame: (_frame, packet) => { if (paintThrows) throw Object.assign(Error('private paint contents'), { name: 'OperationError' }); painted.push(packet.sequence); },
    onError: () => failures.push(true) });
  let sequence = 0;
  const push = (data = key) => controller.push({ sessionId: 'private-device', sequence: sequence++, timestamp: sequence * 50000, width: 640, height: 360, data });
  return { controller, push, instances, acks, events, painted, closed, failures };
}
test('one reordered startup key is drained once, then replayed before queued deltas without a second paint or ACK', async () => {
  const h = fixture({ hardware: 'pending', timeoutMs: 1000 });
  const first = h.push(); await new Promise(resolve => setImmediate(resolve)); const next = h.push(delta);
  assert.equal(h.instances[0].flushes, 1); h.instances[0].release(); await first; await next;
  const decoder = h.instances[0]; assert.deepEqual(decoder.chunks.map(chunk => chunk.type), ['key', 'key', 'delta']);
  decoder.output(); decoder.output();
  assert.deepEqual(h.painted, [0, 1]); assert.equal(h.closed.length, 3);
  assert.equal(h.acks.filter(ack => ack.decoded).length, 1); assert.equal(decoder.flushes, 1);
  h.controller.dispose();
});
test('silent hardware flush deadline or no-output completion falls back only once and software paints the real retained key', async () => {
  for (const hardware of ['pending', 'empty', 'reject']) {
    const h = fixture({ hardware }); await h.push();
    assert.deepEqual(h.instances.map(item => item.mode), ['prefer-hardware', 'prefer-software']);
    assert.deepEqual(h.painted, [0]); assert.equal(h.instances[1].flushes, 1);
    assert.equal(h.acks.filter(ack => ack.decoded).length, 1); assert.deepEqual(h.failures, []); h.controller.dispose();
  }
});
test('both no-output modes terminate truthfully and structured events never contain exception contents', async () => {
  const h = fixture({ hardware: 'empty', software: 'reject' }); await h.push();
  assert.deepEqual(h.failures, [true]); assert.equal(h.instances.length, 2); assert.equal(h.acks.filter(ack => ack.decoded).length, 0);
  assert.ok(h.events.some(event => event.event === 'fallback')); assert.ok(h.events.some(event => event.errorCode === 'DRAIN_FAILED'));
  for (const event of h.events) assert.deepEqual(diagnostics.normalizeDecoderEvent(event), event);
  assert.doesNotMatch(JSON.stringify(h.events), /private|secret|message|stack|payload/); h.controller.dispose();
});
test('dispose cancels a pending drain promptly and its late completion cannot paint, emit or ACK', async () => {
  const h = fixture({ hardware: 'pending', timeoutMs: 1000 }); const running = h.push();
  await new Promise(resolve => setImmediate(resolve)); h.controller.dispose();
  await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(Error('dispose did not cancel drain')), 100))]);
  const counts = [h.acks.length, h.events.length]; h.instances[0].release(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.painted, []); assert.deepEqual([h.acks.length, h.events.length], counts); assert.equal(h.closed.length, 1);
});
test('paint failures are classified without falsely acknowledging first-frame success', async () => {
  const h = fixture({ paintThrows: true }); await h.push();
  assert.deepEqual(h.failures, [true]); assert.equal(h.acks.filter(ack => ack.decoded).length, 0);
  assert.ok(h.events.some(event => event.errorCode === 'PAINT_FAILED' && event.errorName === 'OperationError')); h.controller.dispose();
});
test('continuous fast packets trigger one early software fallback before a hanging hardware drain exhausts ingress slots', async () => {
  const h = fixture({ hardware: 'pending', timeoutMs: 1000, liveOutput: true });
  const pending = [h.push()];
  for (let index = 0; index < 30; index++) {
    await new Promise(resolve => setTimeout(resolve, 2)); pending.push(h.push(delta));
  }
  await Promise.all(pending); await h.controller.idle();
  assert.deepEqual(h.instances.map(decoder => decoder.mode), ['prefer-hardware', 'prefer-software']);
  assert.deepEqual(h.failures, []); assert.equal(h.painted.length, 31);
  assert.equal(h.acks.filter(ack => ack.decoded).length, 1);
  assert.ok(h.events.some(event => event.event === 'fallback' && event.errorCode === 'QUEUE_LIMIT'));
  h.controller.dispose();
});
test('same-turn admitted burst triggers pressure when the hardware wait is registered and consumes late native rejection', async () => {
  const h = fixture({ hardware: 'pending', timeoutMs: 1000, liveOutput: true, rejectHardwareSupportLater: true });
  const pending = [h.push()];
  for (let index = 0; index < 7; index++) pending.push(h.push(delta));
  await new Promise(resolve => setTimeout(resolve, 10)); pending.push(h.push(delta));
  await Promise.all(pending); await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(h.failures, []); assert.equal(h.instances.at(-1).mode, 'prefer-software');
  assert.equal(h.painted.length, 9); assert.equal(h.acks.filter(ack => ack.decoded).length, 1);
  assert.equal(h.events.filter(event => event.event === 'fallback').length, 1);
  assert.ok(h.events.some(event => event.event === 'fallback' && event.errorCode === 'QUEUE_LIMIT')); h.controller.dispose();
});
