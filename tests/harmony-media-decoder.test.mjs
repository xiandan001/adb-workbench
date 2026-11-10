import test from 'node:test';
import assert from 'node:assert/strict';
import { createH264Decoder } from '../electron/harmony-media-decoder.js';

const join = (...nals) => Uint8Array.from(nals.flatMap(nal => [0, 0, 0, 1, ...nal]));
const sps = [0x67, 0x42, 0xc0, 0x16, 0x80], pps = [0x68, 0xc0], idr = [0x65, 0x88], delta = [0x41, 0x88];
function fixture({ unsupportedHardware = false, failHardware = false, failSoftware = false } = {}) {
  const decoders = [], acks = [], errors = [], outputs = [], supported = [];
  class Decoder {
    static async isConfigSupported(config) { supported.push(config.hardwareAcceleration); return { supported: !(unsupportedHardware && config.hardwareAcceleration === 'prefer-hardware') }; }
    constructor(callbacks) { this.callbacks = callbacks; this.state = 'unconfigured'; this.decodeQueueSize = 0; this.chunks = []; decoders.push(this); }
    configure(config) { this.config = config; this.state = 'configured'; }
    decode(chunk) { this.chunks.push(chunk); if (this.config.hardwareAcceleration === 'prefer-hardware' ? failHardware : failSoftware) throw Error('synthetic decoder failure'); }
    close() { this.state = 'closed'; }
    output() { const chunk = this.chunks.at(-1); const frame = { timestamp: chunk.timestamp, close() { this.closed = true; } }; this.callbacks.output(frame); return frame; }
  }
  const controller = createH264Decoder({ Decoder, Chunk: class { constructor(value) { Object.assign(this, value); } },
    acknowledge: value => acks.push(value), onFrame: (frame, packet) => outputs.push(packet.sequence), onError: () => errors.push('failed') });
  let sequence = 0;
  const push = (data, flags = 0) => controller.push({ sessionId: 'fixture', sequence: sequence++, flags, timestamp: sequence * 50000, data, width: 640, height: 360 });
  return { controller, push, decoders, acks, errors, outputs, supported };
}
test('an actual IDR without a wire key flag reaches the decoder and only output gets decoded ACK', async () => {
  const h = fixture(); await h.push(join(sps, pps, idr), 0);
  assert.equal(h.decoders[0].chunks[0].type, 'key');
  assert.equal(h.acks[0].diagnostic.stage, 'submitted'); assert.equal(h.acks.some(value => value.decoded), false);
  const frame = h.decoders[0].output(); assert.equal(frame.closed, true);
  assert.deepEqual(h.outputs, [0]); assert.equal(h.acks.at(-1).decoded, true); h.controller.dispose();
});
test('split parameters wait visibly then a keyframe contains both SPS and PPS; wire flags never promote delta', async () => {
  const h = fixture(); await h.push(join(sps), 2); await h.push(join(pps), 2); await h.push(join(delta), 1);
  assert.deepEqual(h.acks.map(value => value.diagnostic.stage), ['waiting-configuration', 'waiting-keyframe', 'waiting-keyframe']);
  assert.equal(h.decoders.length, 0); await h.push(join(idr), 0);
  assert.deepEqual(h.decoders[0].chunks[0].data, join(sps, pps, idr));
  assert.deepEqual(Object.keys(h.acks.at(-1).diagnostic).sort(), ['codec', 'keyframes', 'pps', 'received', 'sps', 'stage', 'submitted']); h.controller.dispose();
});
test('unsupported hardware or synchronous decode failure retries the current key once in software', async () => {
  for (const options of [{ unsupportedHardware: true }, { failHardware: true }]) {
    const h = fixture(options); await h.push(join(sps, pps, idr));
    assert.deepEqual(h.supported, ['prefer-hardware', 'prefer-software']);
    const software = h.decoders.at(-1); assert.equal(software.config.hardwareAcceleration, 'prefer-software'); assert.equal(software.chunks.length, 1);
    software.output(); assert.equal(h.acks.at(-1).decoded, true); assert.deepEqual(h.errors, []); h.controller.dispose();
  }
});
test('asynchronous hardware failure before first output replays only the retained keyframe', async () => {
  const h = fixture(); await h.push(join(sps, pps, idr));
  h.decoders[0].callbacks.error(Error('async hardware failure')); await h.controller.idle();
  assert.equal(h.decoders.length, 2); assert.equal(h.decoders[1].chunks[0].type, 'key');
  h.decoders[1].output(); assert.equal(h.acks.at(-1).decoded, true); h.controller.dispose();
});
test('software failure is terminal and no retry is allowed after a successfully painted frame', async () => {
  const h = fixture({ failHardware: true, failSoftware: true }); await h.push(join(sps, pps, idr)); await h.push(join(idr));
  assert.equal(h.decoders.length, 2); assert.deepEqual(h.errors, ['failed']); assert.equal(h.acks.at(-1).diagnostic.stage, 'decoder-error');
  const painted = fixture(); await painted.push(join(sps, pps, idr)); painted.decoders[0].output();
  painted.decoders[0].callbacks.error(Error('after output')); await painted.controller.idle();
  assert.equal(painted.decoders.length, 1); assert.deepEqual(painted.errors, ['failed']); h.controller.dispose(); painted.controller.dispose();
});
test('disposing during hardware capability check cannot resurrect a decoder or ACK a new stream', async () => {
  let release; const acks = [], instances = [];
  class Decoder { static isConfigSupported() { return new Promise(resolve => { release = resolve; }); } constructor() { instances.push(this); } }
  const controller = createH264Decoder({ Decoder, Chunk: class {}, acknowledge: value => acks.push(value), onFrame() {}, onError() {} });
  const pending = controller.push({ sessionId: 'old', sequence: 0, timestamp: 1, width: 640, height: 360, data: join(sps, pps, idr) });
  await new Promise(resolve => setImmediate(resolve)); controller.dispose(); release({ supported: true }); await pending;
  assert.deepEqual(instances, []); assert.deepEqual(acks, []);
});
test('late output/error from the replaced hardware decoder cannot ACK or stop the software stream', async () => {
  const h = fixture(); await h.push(join(sps, pps, idr));
  const hardware = h.decoders[0]; hardware.callbacks.error(Error('first failure')); await h.controller.idle();
  hardware.output(); hardware.callbacks.error(Error('stale failure'));
  assert.deepEqual(h.outputs, []); assert.deepEqual(h.errors, []);
  h.decoders[1].output(); assert.deepEqual(h.outputs, [0]); h.controller.dispose();
});
test('malformed packets fail with metadata only and never enter the native decoder', async () => {
  const h = fixture(); await h.push(Uint8Array.from([0, 0, 0, 99, 0x65]));
  assert.equal(h.decoders.length, 0); assert.deepEqual(h.errors, ['failed']);
  const ack = h.acks[0]; assert.equal(ack.diagnostic.stage, 'decoder-error');
  assert.equal(ack.data, undefined); assert.equal(ack.diagnostic.error, undefined); h.controller.dispose();
});
