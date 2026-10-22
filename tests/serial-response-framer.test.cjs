const test = require('node:test');
const assert = require('node:assert/strict');
const { splitSerialResponses } = require('../electron/lib/serial-response-framer.cjs');

const ACK = Buffer.from('ab050adf4e', 'hex');
const RESPONSE_ZERO = Buffer.from('ab07984400962a', 'hex');
const RESPONSE_ONE = Buffer.from('ab07984401860b', 'hex');
const XBH_SIGNATURE = Buffer.from('584248434d44', 'hex');
const XBH_REQUEST = Buffer.from('fe08584248434d4401f1cf', 'hex');
const XBH_RESPONSE = Buffer.from('fe09584248434d4401f101cf', 'hex');

function crc16(bytes) {
  let value = 0xffff;
  for (const byte of bytes) {
    value ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) value = ((value & 0x8000) ? (value << 1) ^ 0x1021 : value << 1) & 0xffff;
  }
  return value;
}

function frame(payload, command = 0x98) {
  const data = Buffer.from(payload);
  const result = Buffer.alloc(data.length + 5);
  result[0] = 0xab;
  result[1] = result.length;
  result[2] = command;
  data.copy(result, 3);
  result.writeUInt16BE(crc16(result.subarray(0, -2)), result.length - 2);
  return result;
}

function xbhFrame(payload) {
  const content = Buffer.from(payload);
  return Buffer.concat([Buffer.from([0xfe, XBH_SIGNATURE.length + content.length]), XBH_SIGNATURE, content, Buffer.from([0xcf])]);
}

function assertCoverage(input, segments, final = false) {
  assert.deepEqual(Buffer.concat(segments.map(segment => segment.bytes)), input);
  let pending = 0;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    assert.ok(Buffer.isBuffer(segment.bytes));
    assert.ok(segment.bytes.length > 0);
    assert.ok(['raw', 'frame', 'pending'].includes(segment.kind));
    if (segment.kind === 'frame') {
      if (segment.protocol === 'ab') {
        assert.equal(segment.bytes[0], 0xab);
        assert.equal(segment.bytes[1], segment.bytes.length);
        assert.ok(segment.bytes.length >= 5 && segment.bytes.length <= 255);
        assert.equal(crc16(segment.bytes.subarray(0, -2)), segment.bytes.readUInt16BE(segment.bytes.length - 2));
      } else {
        assert.equal(segment.protocol, 'xbh');
        assert.equal(segment.bytes[0], 0xfe);
        assert.equal(segment.bytes[1] + 3, segment.bytes.length);
        assert.ok(segment.bytes.length >= 11 && segment.bytes.length <= 258);
        assert.deepEqual(segment.bytes.subarray(2, 8), XBH_SIGNATURE);
        assert.equal(segment.bytes.at(-1), 0xcf);
      }
    }
    if (segment.kind === 'pending') {
      pending++;
      assert.equal(index, segments.length - 1);
      assert.ok(['ab', 'xbh'].includes(segment.protocol));
      assert.equal(segment.bytes[0], segment.protocol === 'ab' ? 0xab : 0xfe);
      assert.ok(segment.bytes.length <= (segment.protocol === 'ab' ? 254 : 257));
    }
    if (segment.kind === 'raw') assert.equal(segment.protocol, undefined);
    if (index) assert.ok(segment.kind !== 'raw' || segments[index - 1].kind !== 'raw', 'consecutive raw bytes must be one segment');
  }
  assert.ok(pending <= 1);
  if (final) assert.equal(pending, 0);
}

test('user ACK and both seven-byte responses are separate complete CRC-checked frames', () => {
  const input = Buffer.concat([ACK, RESPONSE_ZERO, RESPONSE_ONE]);
  const result = splitSerialResponses(input);
  assert.deepEqual(result.map(segment => segment.kind), ['frame', 'frame', 'frame']);
  assert.deepEqual(result.map(segment => segment.bytes.toString('hex')), [ACK, RESPONSE_ZERO, RESPONSE_ONE].map(bytes => bytes.toString('hex')));
  assertCoverage(input, result);
});

test('empty input emits no segments; arbitrary noise and AA requests remain raw', () => {
  assert.deepEqual(splitSerialResponses(Buffer.alloc(0)), []);
  const input = Buffer.from('000102aa061001a7efaa07974400104a7f', 'hex');
  const result = splitSerialResponses(input);
  assert.deepEqual(result.map(segment => segment.kind), ['raw']);
  assertCoverage(input, result);
});

test('prefix and suffix noise retain exact order around complete frames', () => {
  const input = Buffer.concat([Buffer.from('00ff10', 'hex'), ACK, Buffer.from('deadbeef', 'hex'), RESPONSE_ONE, Buffer.from([0])]);
  const result = splitSerialResponses(input);
  assert.deepEqual(result.map(segment => segment.kind), ['raw', 'frame', 'raw', 'frame', 'raw']);
  assertCoverage(input, result);
});

test('valid outer frame wins over embedded AB and a nested independently valid frame', () => {
  const outer = frame(Buffer.concat([Buffer.from('00abff', 'hex'), ACK, RESPONSE_ONE, Buffer.from('ab04ff', 'hex')]));
  const result = splitSerialResponses(outer);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'frame');
  assert.deepEqual(result[0].bytes, outer);
  assertCoverage(outer, result);
});

test('CRC errors resynchronize byte by byte without losing malformed data', () => {
  const broken = Buffer.from(ACK);
  broken[broken.length - 1] ^= 1;
  const input = Buffer.concat([broken, RESPONSE_ZERO]);
  const result = splitSerialResponses(input);
  assert.deepEqual(result.map(segment => segment.kind), ['raw', 'frame']);
  assert.deepEqual(result[0].bytes, broken);
  assert.deepEqual(result[1].bytes, RESPONSE_ZERO);
  assertCoverage(input, result);
});

test('a CRC-invalid enclosing candidate does not hide a nested complete response', () => {
  const outer = frame(Buffer.concat([Buffer.from([0x22]), ACK, Buffer.from([0x33])]));
  outer[outer.length - 1] ^= 1;
  const result = splitSerialResponses(outer, { final: true });
  assert.deepEqual(result.map(segment => segment.kind), ['raw', 'frame', 'raw']);
  assert.deepEqual(result[1].bytes, ACK);
  assertCoverage(outer, result, true);
});

test('lengths zero through four are raw and never block a following complete frame', () => {
  const invalid = Buffer.concat(Array.from({ length: 5 }, (_, length) => Buffer.from([0xab, length, 0x22])));
  const input = Buffer.concat([invalid, ACK]);
  const result = splitSerialResponses(input);
  assert.deepEqual(result.map(segment => segment.kind), ['raw', 'frame']);
  assert.deepEqual(result[0].bytes, invalid);
  assertCoverage(input, result);
});

test('incomplete declared length remains one bounded trailing pending segment until final', () => {
  const prefix = Buffer.from('0102', 'hex');
  for (let size = 1; size < RESPONSE_ONE.length; size++) {
    const incomplete = RESPONSE_ONE.subarray(0, size);
    const input = Buffer.concat([prefix, incomplete]);
    const result = splitSerialResponses(input);
    assert.deepEqual(result.map(segment => segment.kind), ['raw', 'pending']);
    assert.deepEqual(result[1].bytes, incomplete);
    assertCoverage(input, result);
    assertCoverage(input, splitSerialResponses(input, { final: true }), true);
  }
});

test('final resynchronizes an impossible pending length and recovers later valid frames', () => {
  const prefix = Buffer.from('abff1122ab04', 'hex');
  const input = Buffer.concat([prefix, ACK, RESPONSE_ONE, Buffer.from([0xab])]);
  const waiting = splitSerialResponses(input);
  assert.deepEqual(waiting.map(segment => segment.kind), ['pending']);
  assertCoverage(input, waiting);
  const final = splitSerialResponses(input, { final: true });
  assert.deepEqual(final.map(segment => segment.kind), ['raw', 'frame', 'frame', 'raw']);
  assert.deepEqual(final[0].bytes, prefix);
  assert.deepEqual(final.at(-1).bytes, Buffer.from([0xab]));
  assertCoverage(input, final, true);
});

test('ordinary AB frames accept unsigned length 255 and pending never exceeds 254 bytes', () => {
  const longest = frame(Buffer.alloc(250, 0xab));
  assert.equal(longest.length, 255);
  assert.equal(longest[1], 255);
  const result = splitSerialResponses(longest);
  assert.deepEqual(result.map(segment => segment.kind), ['frame']);
  assertCoverage(longest, result);
  const incomplete = longest.subarray(0, 254);
  const pending = splitSerialResponses(incomplete);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, 'pending');
  assert.equal(pending[0].bytes.length, 254);
  assertCoverage(incomplete, pending);
  assertCoverage(incomplete, splitSerialResponses(incomplete, { final: true }), true);
});

test('caller-owned pending supports every split point without state or duplicate bytes', () => {
  const input = Buffer.concat([Buffer.from([0, 1]), ACK, RESPONSE_ZERO, RESPONSE_ONE, Buffer.from([0xff])]);
  for (let split = 1; split < input.length; split++) {
    const first = splitSerialResponses(input.subarray(0, split));
    const emitted = first.filter(segment => segment.kind !== 'pending');
    const pending = first.find(segment => segment.kind === 'pending')?.bytes || Buffer.alloc(0);
    const next = splitSerialResponses(Buffer.concat([pending, input.subarray(split)]), { final: true });
    assert.deepEqual(Buffer.concat([...emitted, ...next].map(segment => segment.bytes)), input);
    assert.deepEqual([...emitted, ...next].filter(segment => segment.kind === 'frame').map(segment => segment.bytes), [ACK, RESPONSE_ZERO, RESPONSE_ONE]);
  }
});

test('binary inputs are never mutated and returned segments do not alias caller storage', () => {
  const input = Buffer.from(ACK);
  const before = Buffer.from(input);
  const result = splitSerialResponses(input);
  result[0].bytes.fill(0);
  assert.deepEqual(input, before);
  const backing = Uint8Array.from([0, ...ACK, 0]);
  const view = backing.subarray(1, backing.length - 1);
  assert.deepEqual(splitSerialResponses(view)[0].bytes, ACK);
  for (const invalid of [null, undefined, 'AB050ADF4E', [], {}]) assert.throws(() => splitSerialResponses(invalid), /Buffer|Uint8Array/);
});

test('deterministic mixed noise, malformed candidates and valid frames preserve every byte', () => {
  let seed = 512;
  const random = limit => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
  for (let run = 0; run < 200; run++) {
    const noise = Buffer.from(Array.from({ length: random(400) }, () => random(256)));
    const input = Buffer.concat([noise, ACK, Buffer.from([0xab, random(256)]), RESPONSE_ONE, noise]);
    const original = Buffer.from(input);
    assertCoverage(input, splitSerialResponses(input));
    assertCoverage(input, splitSerialResponses(input, { final: true }), true);
    assert.deepEqual(input, original);
  }
});

test('XBHCMD user request and fragmented twelve-byte response follow declared length plus three', () => {
  const first = XBH_RESPONSE.subarray(0, 10);
  const waiting = splitSerialResponses(first);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].kind, 'pending');
  assert.equal(waiting[0].protocol, 'xbh');
  const completed = splitSerialResponses(Buffer.concat([waiting[0].bytes, XBH_RESPONSE.subarray(10)]));
  assert.equal(completed.length, 1);
  assert.equal(completed[0].kind, 'frame');
  assert.equal(completed[0].protocol, 'xbh');
  assert.equal(completed[0].bytes.toString('hex'), 'fe09584248434d4401f101cf');
  const input = Buffer.concat([XBH_REQUEST, XBH_RESPONSE]);
  const result = splitSerialResponses(input);
  assert.deepEqual(result.map(segment => segment.protocol), ['xbh', 'xbh']);
  assertCoverage(input, result);
});

test('mixed AB and XBHCMD responses retain their protocol and original byte order', () => {
  const input = Buffer.concat([Buffer.from([0]), ACK, XBH_REQUEST, RESPONSE_ZERO, XBH_RESPONSE, Buffer.from([0])]);
  const result = splitSerialResponses(input);
  assert.deepEqual(result.map(segment => segment.kind), ['raw', 'frame', 'frame', 'frame', 'frame', 'raw']);
  assert.deepEqual(result.filter(segment => segment.kind === 'frame').map(segment => segment.protocol), ['ab', 'xbh', 'ab', 'xbh']);
  assertCoverage(input, result);
});

test('declared XBHCMD boundary preserves payload AB, FE, CF and nested valid frames', () => {
  const payload = Buffer.concat([Buffer.from('01f1cffefeab00', 'hex'), ACK, XBH_RESPONSE, Buffer.from('cffefe', 'hex')]);
  const outer = xbhFrame(payload);
  const result = splitSerialResponses(outer);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'frame');
  assert.equal(result[0].protocol, 'xbh');
  assert.deepEqual(result[0].bytes, outer);
  assertCoverage(outer, result);
});

test('incorrect complete or partial XBHCMD signature becomes raw immediately', () => {
  for (let index = 0; index < XBH_SIGNATURE.length; index++) {
    const invalid = Buffer.from(XBH_REQUEST);
    invalid[index + 2] = 0;
    const input = Buffer.concat([invalid, ACK]);
    const result = splitSerialResponses(input);
    assert.deepEqual(result.map(segment => segment.kind), ['raw', 'frame']);
    assert.deepEqual(result[0].bytes, invalid);
    assertCoverage(input, result);
    const partial = invalid.subarray(0, index + 3);
    assert.deepEqual(splitSerialResponses(partial).map(segment => segment.kind), ['raw']);
  }
  for (let size = 1; size < XBH_REQUEST.length; size++) {
    const partial = XBH_REQUEST.subarray(0, size);
    const result = splitSerialResponses(partial);
    assert.equal(result[0].kind, 'pending');
    assert.equal(result[0].protocol, 'xbh');
    assertCoverage(partial, result);
  }
});

test('XBHCMD length less than eight and wrong declared tail do not consume a following response', () => {
  for (let length = 0; length < 8; length++) {
    const input = Buffer.concat([Buffer.from([0xfe, length, 0x22]), ACK]);
    const result = splitSerialResponses(input);
    assert.deepEqual(result.map(segment => segment.kind), ['raw', 'frame']);
    assertCoverage(input, result);
  }
  const invalid = Buffer.from(XBH_REQUEST);
  invalid[invalid.length - 1] = 0;
  const input = Buffer.concat([invalid, XBH_RESPONSE]);
  const result = splitSerialResponses(input);
  assert.deepEqual(result.map(segment => segment.kind), ['raw', 'frame']);
  assert.deepEqual(result[0].bytes, invalid);
  assertCoverage(input, result);
});

test('final unwraps a false XBHCMD length and resynchronizes later AB and XBHCMD frames', () => {
  const prefix = Buffer.concat([Buffer.from([0xfe, 255]), XBH_SIGNATURE, Buffer.from([0x01, 0xf1])]);
  const input = Buffer.concat([prefix, ACK, XBH_RESPONSE, Buffer.from([0xfe])]);
  const pending = splitSerialResponses(input);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, 'pending');
  assert.equal(pending[0].protocol, 'xbh');
  assertCoverage(input, pending);
  const result = splitSerialResponses(input, { final: true });
  assert.deepEqual(result.map(segment => segment.kind), ['raw', 'frame', 'frame', 'raw']);
  assert.deepEqual(result[0].bytes, prefix);
  assertCoverage(input, result, true);
});

test('XBHCMD accepts unsigned length 255 as 258 bytes and at most 257 pending bytes', () => {
  const input = xbhFrame(Buffer.alloc(249, 0xfe));
  assert.equal(input.length, 258);
  const result = splitSerialResponses(input);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'frame');
  assert.equal(result[0].protocol, 'xbh');
  assertCoverage(input, result);
  const partial = input.subarray(0, -1);
  const pending = splitSerialResponses(partial);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].bytes.length, 257);
  assertCoverage(partial, pending);
  assertCoverage(partial, splitSerialResponses(partial, { final: true }), true);
});

test('every mixed-protocol split point can resume only the returned pending bytes', () => {
  const expected = [XBH_REQUEST, ACK, XBH_RESPONSE, RESPONSE_ONE];
  const input = Buffer.concat(expected);
  for (let split = 1; split < input.length; split++) {
    const initial = splitSerialResponses(input.subarray(0, split));
    const emitted = initial.filter(segment => segment.kind !== 'pending');
    const pending = initial.find(segment => segment.kind === 'pending')?.bytes || Buffer.alloc(0);
    const next = splitSerialResponses(Buffer.concat([pending, input.subarray(split)]), { final: true });
    assert.deepEqual(Buffer.concat([...emitted, ...next].map(segment => segment.bytes)), input);
    assert.deepEqual([...emitted, ...next].filter(segment => segment.kind === 'frame').map(segment => segment.bytes), expected);
  }
});
