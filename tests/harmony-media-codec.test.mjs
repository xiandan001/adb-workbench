import test from 'node:test';
import assert from 'node:assert/strict';
import { h264Configuration, hasVideoSlice, normalizeH264, withConfiguration } from '../electron/harmony-media-codec.js';
import * as codec from '../electron/harmony-media-codec.js';

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

const prefixed = (...nals) => Uint8Array.from(nals.flatMap(nal => [0, 0, nal.length >>> 8, nal.length & 255, ...nal]));
const streamSps = [...sps, 0x80], streamPps = [0x68, 0xc0];
const avccRecord = () => Uint8Array.from([1, 0x42, 0xc0, 0x16, 0xff, 0xe1, 0, streamSps.length, ...streamSps, 1, 0, streamPps.length, ...streamPps]);
test('length prefixes of 256 and 300 bytes cannot masquerade as AnnexB start codes', () => {
  for (const size of [256, 300]) {
    const nal = Array(size).fill(0x88); nal[0] = 0x65;
    assert.deepEqual(normalizeH264(prefixed(nal)), join(nal));
  }
});
test('stream retains separately delivered SPS/PPS and recognizes IDR from bytes', () => {
  const stream = codec.createH264StreamState();
  assert.equal(stream.push(join(streamSps)).configuration, null);
  const configured = stream.push(join(streamPps));
  assert.deepEqual(configured.configuration.data, join(streamSps, streamPps));
  const frame = stream.push(join(idr));
  assert.equal(frame.key, true); assert.equal(frame.hasVideo, true);
  assert.deepEqual(withConfiguration(frame.configuration.data, frame.data), join(streamSps, streamPps, idr));
});
test('length-prefixed parameters can initialize a stream without an avcC record', () => {
  const stream = codec.createH264StreamState();
  stream.push(prefixed(streamSps)); stream.push(prefixed(streamPps));
  const frame = stream.push(prefixed(idr));
  assert.equal(frame.configuration.codec, 'avc1.42c016'); assert.equal(frame.key, true);
});
test('explicit avcC framing wins over incidental start-code bytes and rejects truncated lengths', () => {
  const stream = codec.createH264StreamState();
  stream.push(avccRecord());
  const nal = Array(300).fill(0x88); nal[0] = 0x65;
  assert.deepEqual(stream.push(prefixed(nal)).data, join(nal));
  assert.throws(() => stream.push(Uint8Array.from([0, 0, 1, 44, 0x65])));
  assert.throws(() => stream.push(join(idr)));
});
test('malformed framing and extra avcC bytes are rejected without truncation', () => {
  assert.equal(typeof codec.createH264StreamState, 'function');
  for (const data of [Uint8Array.from([99, 0, 0, 1, 0x65]), join([]), join([0xe5, 0x80]), Uint8Array.from([...avccRecord(), 0x66])]) {
    assert.throws(() => codec.createH264StreamState().push(data));
  }
  assert.throws(() => codec.createH264StreamState().push(new Uint8Array(8 * 1024 * 1024 + 1)));
});
test('same-ID parameter updates replace old bytes without accumulating stale sets', () => {
  const stream = codec.createH264StreamState();
  const initial = stream.push(join(streamSps, streamPps));
  const nextPps = [...streamPps, 0x80];
  const updated = stream.push(join(nextPps));
  assert.equal(updated.configuration.revision, initial.configuration.revision + 1);
  assert.deepEqual(updated.configuration.data, join(streamSps, nextPps));
  assert.equal(stream.push(join(nextPps)).configuration.revision, updated.configuration.revision);
});
test('avcC one- and two-byte length formats are preserved across packets', () => {
  for (const lengthSize of [1, 2]) {
    const record = avccRecord(); record[4] = 0xfc | (lengthSize - 1);
    const stream = codec.createH264StreamState(); stream.push(record);
    const data = Uint8Array.from([...(lengthSize === 1 ? [idr.length] : [0, idr.length]), ...idr]);
    assert.deepEqual(stream.push(data).data, join(idr));
  }
});
test('multiple parameter-set IDs are retained even when an access unit includes only one of them', () => {
  const otherSps = [...sps, 0x40], otherPps = [0x68, 0x40];
  const stream = codec.createH264StreamState(); stream.push(join(streamSps, streamPps));
  const frame = stream.push(join(otherSps, otherPps, idr));
  const bytes = withConfiguration(frame.configuration.data, frame.data);
  assert.deepEqual(bytes, join(streamSps, streamPps, otherSps, otherPps, idr));
  const oversized = new Uint8Array(64 * 1024 + 1); oversized.set(streamSps);
  assert.throws(() => stream.push(join(Array.from(oversized))), /H264_SIZE/);
});
test('total parameter budget is enforced before copying another large set into stream state', () => {
  const first = new Uint8Array(40000).fill(0x55), second = first.slice(); first.set(streamSps); second.set([...sps, 0x40]);
  const stream = codec.createH264StreamState(); stream.push(join(Array.from(first)));
  assert.throws(() => stream.push(join(Array.from(second))), /H264_SIZE/);
  const next = stream.push(join(streamPps));
  assert.deepEqual(next.configuration.data, join(Array.from(first), streamPps));
});
