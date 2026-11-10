const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDecoderDiagnostic, firstFrameFailure } = require('../electron/lib/harmony-media-diagnostics.cjs');
const diagnostics = require('../electron/lib/harmony-media-diagnostics.cjs');

const sample = { stage: 'submitted', received: 3, submitted: 1, keyframes: 1, sps: true, pps: true, codec: 'avc1.42c01e' };
test('first-frame diagnostics accept only bounded metadata, never frame payloads or raw errors', () => {
  assert.deepEqual(normalizeDecoderDiagnostic(sample), sample);
  for (const value of [null, [], { ...sample, payload: 'private-screen' }, { ...sample, error: 'raw-error' },
    { ...sample, received: Infinity }, { ...sample, submitted: -1 }, { ...sample, sps: 'true' },
    { ...sample, codec: 'private-location' }, { ...sample, stage: 'arbitrary-stage' }]) {
    assert.throws(() => normalizeDecoderDiagnostic(value));
  }
});
test('first-frame failure distinguishes missing parameters, keyframe and unsuccessful decoding', () => {
  assert.match(firstFrameFailure(), /首个视频帧/);
  assert.match(firstFrameFailure({ ...sample, received: 0, submitted: 0, keyframes: 0, sps: false, pps: false, codec: '' }), /尚未收到/);
  assert.match(firstFrameFailure({ ...sample, pps: false }), /初始化参数/);
  assert.match(firstFrameFailure({ ...sample, keyframes: 0, submitted: 0 }), /关键帧/);
  assert.match(firstFrameFailure({ ...sample, submitted: 0 }), /尚未提交/);
  assert.match(firstFrameFailure(sample), /送达解码器/);
});
test('decoder events accept only fixed classifications and bounded primitive metadata', () => {
  assert.equal(typeof diagnostics.normalizeDecoderEvent, 'function');
  const value = { event: 'fallback', mode: 'software', codec: 'avc1.640016', received: 1, submitted: 1, output: 0,
    keyframes: 1, width: 640, height: 360, errorName: 'TimeoutError', errorCode: 'DRAIN_TIMEOUT' };
  assert.deepEqual(diagnostics.normalizeDecoderEvent(value), value);
  for (const bad of [{ ...value, message: 'private URL' }, { ...value, payload: new Uint8Array([1]) },
    { ...value, deviceId: 'private' }, { ...value, errorName: 'raw-private-error' }, { ...value, errorCode: 'arbitrary' },
    { ...value, event: 'anything' }, { ...value, mode: 'native-url' }, { ...value, codec: 'private' },
    { ...value, output: -1 }, { ...value, height: 999999 }, { ...value, supported: 'true' }]) assert.throws(() => diagnostics.normalizeDecoderEvent(bad));
});
