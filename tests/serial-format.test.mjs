import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as frontend from '../src/shared/serialFormat.js';

const require = createRequire(import.meta.url);
const backend = require('../electron/lib/serial-format.cjs');
const formatters = [frontend, backend];
const hexFor = byte => byte.toString(16).padStart(2, '0');

test('HEX formatting uses uppercase byte pairs with one space and preserves empty input', () => {
  for (const formatter of formatters) {
    assert.equal(formatter.formatHex('ab050adf4e'), 'AB 05 0A DF 4E');
    assert.equal(formatter.formatHex('Aa061001a7Ef'), 'AA 06 10 01 A7 EF');
    assert.equal(formatter.formatHex('00'), '00');
    assert.equal(formatter.formatHex(''), '');
    assert.equal(formatter.formatAscii(''), '');
  }
});

test('ASCII presentation preserves printable bytes and visibly escapes controls, slash and high bits', () => {
  for (const formatter of formatters) {
    assert.equal(formatter.formatAscii('410d0aff'), 'A\\r\\n\\xFF');
    assert.equal(formatter.formatAscii('00090a0d1f207e7f8081ff'), '\\x00\\t\\n\\r\\x1F ~\\x7F\\x80\\x81\\xFF');
    assert.equal(formatter.formatAscii('5c725c6e5c743030'), '\\\\r\\\\n\\\\t00');
    assert.equal(formatter.formatAscii('4142c1c2'), 'AB\\xC1\\xC2', 'high bits must not be masked into printable ASCII');
  }
});

function decodeAsciiPresentation(text) {
  const bytes = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '\\') { bytes.push(text.charCodeAt(index)); continue; }
    const escaped = text[++index];
    if (escaped === 'x') {
      bytes.push(Number.parseInt(text.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      assert.ok(['\\', 't', 'n', 'r'].includes(escaped));
      bytes.push({ '\\': 92, t: 9, n: 10, r: 13 }[escaped]);
    }
  }
  return bytes;
}

test('backend and renderer agree on all 256 values with reversible ASCII and HEX representations', () => {
  const bytes = Array.from({ length: 256 }, (_, index) => index);
  const raw = bytes.map(hexFor).join('');
  const expectedHex = bytes.map(byte => hexFor(byte).toUpperCase()).join(' ');
  for (const byte of bytes) {
    const hex = hexFor(byte);
    assert.equal(frontend.formatHex(hex), hex.toUpperCase());
    assert.equal(frontend.formatHex(hex), backend.formatHex(hex));
    assert.equal(frontend.formatAscii(hex), backend.formatAscii(hex));
    assert.deepEqual(decodeAsciiPresentation(frontend.formatAscii(hex)), [byte]);
    if (byte >= 32 && byte <= 126 && byte !== 92) assert.equal(frontend.formatAscii(hex), String.fromCharCode(byte));
    if ((byte < 32 && ![9, 10, 13].includes(byte)) || byte > 126) {
      assert.equal(frontend.formatAscii(hex), '\\x' + hex.toUpperCase());
    }
  }
  for (const formatter of formatters) {
    assert.equal(formatter.formatHex(raw), expectedHex);
    assert.deepEqual(decodeAsciiPresentation(formatter.formatAscii(raw)), bytes);
  }
});

test('formatting refuses malformed internal bytes rather than silently losing characters', () => {
  for (const formatter of formatters) {
    for (const value of [undefined, null, 0, [], {}, '0', 'AAA', 'GG', '00 ff', '0xFF', 'FF\n', 'A\n', '00\r\n', '00\0ff']) {
      assert.throws(() => formatter.formatHex(value), /HEX/);
      assert.throws(() => formatter.formatAscii(value), /HEX/);
    }
  }
});
