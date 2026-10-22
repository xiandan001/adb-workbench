const test = require('node:test');
const assert = require('node:assert/strict');
const { createSerialTerminalBuffer } = require('../electron/lib/serial-terminal-buffer.cjs');

const hasCode = code => error => error.code === code && typeof error.message === 'string' && error.message.length > 0;

test('an explicit session starts at offset zero and empty reads never invent bytes', () => {
  const buffer = createSerialTerminalBuffer();
  assert.throws(() => buffer.append(Buffer.from([1])), hasCode('SERIAL_TERMINAL_NO_SESSION'));
  assert.throws(() => buffer.read({ sessionId: '', offset: 0 }), hasCode('SERIAL_TERMINAL_NO_SESSION'));
  assert.deepEqual(buffer.reset('session-A'), { sessionId: 'session-A', startOffset: 0, endOffset: 0 });
  assert.deepEqual(buffer.read({ sessionId: 'session-A', offset: 0 }), {
    sessionId: 'session-A', startOffset: 0, endOffset: 0, nextOffset: 0, hex: '', truncated: false
  });
  assert.equal(buffer.append(Buffer.alloc(0)), 0);
  assert.equal(buffer.read({ sessionId: 'session-A', offset: 0 }).nextOffset, 0);
});

test('all byte values and partial UTF-8 are retained raw without framing or decoding', () => {
  const buffer = createSerialTerminalBuffer();
  buffer.reset('session-A');
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  assert.equal(buffer.append(bytes), 256);
  assert.equal(buffer.append(Buffer.from('e4b8', 'hex')), 258);
  const result = buffer.read({ sessionId: 'session-A', offset: 0 });
  assert.equal(result.hex, bytes.toString('hex') + 'e4b8');
  assert.equal(result.nextOffset, 258);
  assert.equal(result.endOffset, 258);
  assert.equal(result.truncated, false);
});

test('wrapped reads return at most chunkBytes and flag only genuinely evicted offsets', () => {
  const buffer = createSerialTerminalBuffer({ maxBytes: 8, chunkBytes: 3 });
  buffer.reset('session-A');
  buffer.append(Buffer.from([0, 1, 2, 3, 4, 5]));
  assert.deepEqual(buffer.read({ sessionId: 'session-A', offset: 0 }), {
    sessionId: 'session-A', startOffset: 0, endOffset: 6, nextOffset: 3, hex: '000102', truncated: false
  });
  assert.equal(buffer.append(Buffer.from([6, 7, 8, 9, 10, 11])), 12);
  assert.deepEqual(buffer.read({ sessionId: 'session-A', offset: 2 }), {
    sessionId: 'session-A', startOffset: 4, endOffset: 12, nextOffset: 7, hex: '040506', truncated: true
  });
  assert.equal(buffer.read({ sessionId: 'session-A', offset: 7 }).hex, '070809');
  assert.equal(buffer.read({ sessionId: 'session-A', offset: 10 }).hex, '0a0b');
  assert.deepEqual(buffer.read({ sessionId: 'session-A', offset: 12 }), {
    sessionId: 'session-A', startOffset: 4, endOffset: 12, nextOffset: 12, hex: '', truncated: false
  });
  assert.equal(buffer.read({ sessionId: 'session-A', offset: 4 }).truncated, false);
});

test('oversized callback retains only its newest capacity bytes while counting every input byte', () => {
  const buffer = createSerialTerminalBuffer({ maxBytes: 8, chunkBytes: 8 });
  buffer.reset('session-A');
  buffer.append(Buffer.from([100, 101]));
  const incoming = Buffer.from(Array.from({ length: 100 }, (_, index) => index));
  assert.equal(buffer.append(incoming), 102);
  assert.deepEqual(buffer.read({ sessionId: 'session-A', offset: 0 }), {
    sessionId: 'session-A', startOffset: 94, endOffset: 102, nextOffset: 102,
    hex: incoming.subarray(-8).toString('hex'), truncated: true
  });
});

test('ordinary reads are repeatable and never consume retained terminal bytes', () => {
  const buffer = createSerialTerminalBuffer({ maxBytes: 16, chunkBytes: 4 });
  buffer.reset('session-A');
  buffer.append(Buffer.from('terminal'));
  const first = buffer.read({ sessionId: 'session-A', offset: 0 });
  buffer.read({ sessionId: 'session-A', offset: 4 });
  assert.deepEqual(buffer.read({ sessionId: 'session-A', offset: 0 }), first);
  buffer.append(Buffer.from('!'));
  const again = buffer.read({ sessionId: 'session-A', offset: 0 });
  assert.equal(again.hex, first.hex);
  assert.equal(again.nextOffset, first.nextOffset);
  assert.equal(again.endOffset, 9);
});

test('new sessions reset offsets and reject stale requests instead of silently replaying another device', () => {
  const buffer = createSerialTerminalBuffer();
  buffer.reset('session-A');
  buffer.append(Buffer.from('old'));
  buffer.reset('session-B');
  assert.throws(() => buffer.read({ sessionId: 'session-A', offset: 0 }), hasCode('SERIAL_TERMINAL_SESSION_CHANGED'));
  assert.throws(() => buffer.read({ sessionId: 'session-B', offset: 3 }), hasCode('SERIAL_TERMINAL_OFFSET_INVALID'));
  assert.equal(buffer.read({ sessionId: 'session-B', offset: 0 }).hex, '');
  assert.equal(buffer.append(Buffer.from('new')), 3);
  assert.equal(buffer.read({ sessionId: 'session-B', offset: 0 }).hex, Buffer.from('new').toString('hex'));
});

test('explicit reset clears bytes even when reusing the same session and disconnect requires no reset', () => {
  const buffer = createSerialTerminalBuffer();
  buffer.reset('session-A');
  buffer.append(Buffer.from([0, 0xff]));
  // A disconnected caller can continue reading; this helper does not own connection state.
  assert.equal(buffer.read({ sessionId: 'session-A', offset: 0 }).hex, '00ff');
  buffer.reset('session-A');
  assert.equal(buffer.read({ sessionId: 'session-A', offset: 0 }).hex, '');
  assert.throws(() => buffer.read({ sessionId: 'session-A', offset: 1 }), hasCode('SERIAL_TERMINAL_OFFSET_INVALID'));
});

test('invalid positions and unknown sessions never fall back to replay from zero', () => {
  const buffer = createSerialTerminalBuffer();
  buffer.reset('session-A');
  buffer.append(Buffer.from('abc'));
  for (const offset of [undefined, null, '0', -1, 0.5, NaN, Infinity, 4, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => buffer.read({ sessionId: 'session-A', offset }), hasCode('SERIAL_TERMINAL_OFFSET_INVALID'));
  }
  for (const sessionId of [undefined, null, '', 'session-B']) {
    assert.throws(() => buffer.read({ sessionId, offset: 0 }), hasCode('SERIAL_TERMINAL_SESSION_CHANGED'));
  }
  assert.equal(buffer.read({ sessionId: 'session-A', offset: 0 }).hex, '616263');
});

test('append copies caller storage and read metadata cannot mutate internal state', () => {
  const buffer = createSerialTerminalBuffer({ maxBytes: 7, chunkBytes: 7 });
  buffer.reset('session-A');
  const input = Buffer.from('abcdefghi');
  buffer.append(input);
  input.fill(0);
  const result = buffer.read({ sessionId: 'session-A', offset: 0 });
  assert.equal(result.hex, Buffer.from('cdefghi').toString('hex'));
  result.nextOffset = 0;
  result.sessionId = 'other';
  assert.equal(buffer.read({ sessionId: 'session-A', offset: 2 }).nextOffset, 9);
});

test('default reads are capped at 64 KiB while the ring retains 256 KiB', () => {
  const buffer = createSerialTerminalBuffer();
  buffer.reset('session-A');
  const bytes = Buffer.from(Array.from({ length: 256 * 1024 }, (_, index) => index % 251));
  buffer.append(bytes);
  let offset = 0;
  const chunks = [];
  for (let index = 0; index < 4; index++) {
    const result = buffer.read({ sessionId: 'session-A', offset });
    assert.equal(result.hex.length, 64 * 1024 * 2);
    assert.equal(result.startOffset, 0);
    assert.equal(result.endOffset, bytes.length);
    assert.equal(result.nextOffset, offset + 64 * 1024);
    chunks.push(Buffer.from(result.hex, 'hex'));
    offset = result.nextOffset;
  }
  assert.deepEqual(Buffer.concat(chunks), bytes);
});

test('configuration, session and binary input validation preserve existing data on errors', () => {
  for (const maxBytes of [0, -1, 1.5, '8', NaN, Infinity, 256 * 1024 + 1]) {
    assert.throws(() => createSerialTerminalBuffer({ maxBytes }), hasCode('SERIAL_TERMINAL_CONFIG_INVALID'));
  }
  for (const chunkBytes of [0, -1, 1.5, '8', NaN, Infinity, 64 * 1024 + 1]) {
    assert.throws(() => createSerialTerminalBuffer({ chunkBytes }), hasCode('SERIAL_TERMINAL_CONFIG_INVALID'));
  }
  const buffer = createSerialTerminalBuffer({ maxBytes: 1, chunkBytes: 1 });
  buffer.reset('session-A');
  buffer.append(Buffer.from([0xff]));
  for (const sessionId of [undefined, null, '', ' ', 123, 'bad\0id', 'a'.repeat(201)]) {
    assert.throws(() => buffer.reset(sessionId), hasCode('SERIAL_TERMINAL_SESSION_INVALID'));
  }
  for (const input of [undefined, null, 'abc', [], new Uint8Array([1])]) {
    assert.throws(() => buffer.append(input), hasCode('SERIAL_TERMINAL_DATA_INVALID'));
  }
  assert.equal(buffer.read({ sessionId: 'session-A', offset: 0 }).hex, 'ff');
});

test('large callbacks and sustained small writes keep a fixed-capacity exact suffix', { timeout: 10000 }, () => {
  const buffer = createSerialTerminalBuffer({ maxBytes: 1024, chunkBytes: 1024 });
  buffer.reset('session-A');
  const huge = Buffer.alloc(32 * 1024 * 1024, 0xaa);
  huge[huge.length - 1] = 0;
  assert.equal(buffer.append(huge), huge.length);
  assert.equal(buffer.read({ sessionId: 'session-A', offset: 0 }).hex, huge.subarray(-1024).toString('hex'));
  let expected = Buffer.from(huge.subarray(-1024));
  let endOffset = huge.length;
  for (let index = 0; index < 20000; index++) {
    const bytes = Buffer.from([index & 0xff, (index >>> 8) & 0xff, 0, 0xfe, 0xcf]);
    endOffset += bytes.length;
    buffer.append(bytes);
    expected = Buffer.concat([expected, bytes]).subarray(-1024);
    if (index % 101 === 0) {
      const result = buffer.read({ sessionId: 'session-A', offset: endOffset - 1024 });
      assert.equal(result.hex, expected.toString('hex'));
      assert.equal(result.nextOffset, endOffset);
      assert.equal(result.truncated, false);
    }
  }
  const result = buffer.read({ sessionId: 'session-A', offset: 0 });
  assert.equal(result.startOffset, endOffset - 1024);
  assert.equal(result.endOffset, endOffset);
  assert.equal(result.hex, expected.toString('hex'));
  assert.equal(result.truncated, true);
});
