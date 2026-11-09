import test from 'node:test';
import assert from 'node:assert/strict';
import { h264Configuration, hasVideoSlice, normalizeH264, withConfiguration } from '../electron/harmony-media-codec.js';

const join = (...nals) => Uint8Array.from(nals.flatMap(nal => [0, 0, 0, 1, ...nal]));
const sps = [0x67, 0x42, 0xc0, 0x16], pps = [0x68, 0xce, 0x06], aud = [0x09, 0xf0], sei = [0x06, 0x80], idr = [0x65, 0x88];
const config = join(sps, pps);
test('complete AnnexB keyframes retain their original AUD/SPS/PPS/SEI/IDR byte sequence without duplicate configuration', () => {
  const frame = join(aud, sps, pps, sei, idr);
  assert.deepEqual(withConfiguration(config, frame), frame);
  assert.equal(hasVideoSlice(frame), true);
  assert.equal(h264Configuration(frame).codec, 'avc1.42c016');
});
test('missing parameter sets are inserted after AUD, preserving a single decodable access unit', () => {
  assert.deepEqual(withConfiguration(config, join(aud, sei, idr)), join(aud, sps, pps, sei, idr));
  assert.deepEqual(withConfiguration(config, join(aud, sps, sei, idr)), join(aud, sps, pps, sei, idr));
  assert.deepEqual(withConfiguration(config, join(aud, pps, sei, idr)), join(aud, sps, pps, sei, idr));
  assert.deepEqual(withConfiguration(config, join(sei, idr)), join(sps, pps, sei, idr));
});
test('avcC configuration and length-prefixed access units normalize to AnnexB without inventing slices', () => {
  const avcc = Uint8Array.from([1, 0x42, 0xc0, 0x16, 0xff, 0xe1, 0, sps.length, ...sps, 1, 0, pps.length, ...pps]);
  const parsed = h264Configuration(avcc);
  assert.equal(parsed.codec, 'avc1.42c016'); assert.equal(parsed.lengthSize, 4);
  assert.deepEqual(parsed.data, config); assert.equal(hasVideoSlice(config), false);
  assert.deepEqual(normalizeH264(Uint8Array.from([0, 0, 0, idr.length, ...idr])), join(idr));
  assert.throws(() => normalizeH264(Uint8Array.from([0, 0, 0, 99, 0x65])));
});
