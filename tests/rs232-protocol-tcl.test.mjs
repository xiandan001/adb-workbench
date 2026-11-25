import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildProtocolCommand, getProtocolParameters, getProtocolCategoryLabel, listProtocolCommands } from '../src/shared/rs232Protocol.js';
import { normalizeProtocolPreferences, defaultProtocolPreferences } from '../src/shared/rs232ProtocolPreferences.js';
import { defaultRs232Memory, rememberProtocolSelection, restoreProtocolSelection } from '../src/shared/rs232ProtocolMemory.js';

const require = createRequire(import.meta.url);
const main = require('../electron/lib/rs232-protocol-preferences.cjs');
const { normalizeRs232Memory } = require('../electron/lib/rs232-memory-policy.cjs');
const tcl = listProtocolCommands().filter(command => command.protocol === 'tcl');
const entry = n => tcl[n - 1];
const make = (n, values) => buildProtocolCommand(entry(n), values);

// The manufacturer's supplied two-nibble example, independent of the bitwise encoder.
const lookup = [0, 0x1021, 0x2042, 0x3063, 0x4084, 0x50a5, 0x60c6, 0x70e7,
  0x8108, 0x9129, 0xa14a, 0xb16b, 0xc18c, 0xd1ad, 0xe1ce, 0xf1ef];
function referenceCrc(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc = (crc << 4 & 0xffff) ^ lookup[(crc >>> 12) ^ (byte >>> 4)];
    crc = (crc << 4 & 0xffff) ^ lookup[(crc >>> 12) ^ (byte & 15)];
  }
  return crc;
}

test('all 48 Tcl rows build in an independent translated category except the unverified long write', () => {
  assert.equal(tcl.length, 48);
  assert.equal(tcl.filter(command => command.ack2).length, 13);
  for (const [index, command] of tcl.entries()) {
    assert.equal(command.id, `tcl-${String(index + 1).padStart(3, '0')}`);
    assert.equal(command.category, 'TCL 厂测协议');
    assert.equal(command.ack1, 'AB 05 0A DF 4E');
    for (const locale of ['zh-CN', 'en-US', 'zh-TW', 'ja-JP', 'ko-KR']) {
      assert.ok(command.labels[locale]);
      assert.ok(getProtocolCategoryLabel(command.category, locale, command));
    }
    const values = Object.fromEntries(getProtocolParameters(command).map(parameter => [parameter.key,
      parameter.type === 'ascii' ? 'TCL-01' : parameter.type === 'hex' ? '00'.repeat(parameter.minBytes)
        : parameter.options?.[0].value ?? parameter.min]));
    if (index === 43) assert.throws(() => buildProtocolCommand(command, values), { code: 'RS232_REVIEW_REQUIRED' });
    else {
      const { bytes } = buildProtocolCommand(command, values);
      assert.equal(bytes[0], 0xaa, command.id);
      assert.equal(referenceCrc(bytes.subarray(0, -2)), bytes.at(-2) << 8 | bytes.at(-1), command.id);
    }
  }
});

test('specified literal and computed short wire vectors match and bad parameters stay unsent', () => {
  assert.equal(make(1).hex, 'AA 06 10 01 A7 EF');
  assert.equal(make(21).hex, 'AA 07 97 44 00 10 4A');
  assert.equal(make(46).hex, 'AA 06 EA 02 6B 86');
  assert.equal(make(47).hex, 'AA 06 EC 02 C1 20');
  assert.equal(referenceCrc([0xab, 5, 0x0a]), 0xdf4e);
  assert.equal(referenceCrc([0xab, 5, 0x0b]), 0xcf6f);
  assert.equal(referenceCrc([0xab, 7, 0x7b, 0, 0]), 0xae43);
  assert.equal(referenceCrc([0xab, 7, 0x98, 0x02, 0x05]), 0x61e5);
  const serial = getProtocolParameters(entry(16))[0].key;
  const bytes = make(16, { [serial]: 'ABC' }).bytes;
  assert.deepEqual([...bytes.subarray(0, 6)], [0xaa, 8, 0x71, 0x41, 0x42, 0x43]);
  assert.throws(() => make(16, { [serial]: '非ASCII' }), { code: 'RS232_PARAMETER_INVALID' });
  assert.throws(() => make(15, { XX: 3 }), { code: 'RS232_PARAMETER_INVALID' });
  assert.throws(() => buildProtocolCommand({ ...entry(21), template: 'AA 07 97 44 00 10 4B', reviewed: true }), { code: 'RS232_TCL_FRAME_INVALID' });
  assert.match(entry(30).ack2, /^AA 07 /);
});

test('manually reviewed long data is bounded, counts bytes big-endian and resists odd HEX', () => {
  const reviewed = { ...entry(44), reviewed: true };
  const { key } = getProtocolParameters(reviewed)[0];
  const frame = buildProtocolCommand(reviewed, { [key]: '12 '.repeat(256) });
  assert.equal(frame.bytes.length, 264);
  assert.deepEqual([...frame.bytes.subarray(0, 7)], [0xaa, 0xfe, 1, 8, 0xe9, 2, 0x12]);
  assert.equal(buildProtocolCommand(reviewed, { [key]: '00'.repeat(65527) }).bytes.length, 65535);
  assert.throws(() => buildProtocolCommand(reviewed, { [key]: '0'.repeat(513) }), { code: 'RS232_PARAMETER_INVALID' });
  assert.throws(() => buildProtocolCommand(reviewed, { [key]: 'A B '.repeat(256) }), { code: 'RS232_PARAMETER_INVALID' });
  assert.throws(() => buildProtocolCommand(reviewed, { [key]: '00'.repeat(65528) }), { code: 'RS232_PARAMETER_INVALID' });
  assert.throws(() => buildProtocolCommand(reviewed, { [key]: '' }), { code: 'RS232_PARAMETER_INVALID' });
});

test('Tcl edits, removals and selection round-trip without remembering Tcl parameters', () => {
  const { id, name, category, template, note } = entry(16);
  const prefs = { ...defaultProtocolPreferences(), overrides: [{ id, name, category, template, note, reviewed: true }], removed: [entry(1).id] };
  assert.deepEqual(normalizeProtocolPreferences(prefs), main.normalizeProtocolPreferences(prefs));
  assert.equal(listProtocolCommands(prefs).some(command => command.id === entry(1).id), false);
  const scope = { workspace: 'rs232', schemeId: '' };
  const current = rememberProtocolSelection(defaultRs232Memory(), scope, { selectedId: id, category, command: entry(16), values: { SN: 'ABC' } });
  assert.deepEqual(normalizeRs232Memory(current), current);
  assert.deepEqual(restoreProtocolSelection(current, scope, tcl), { selectedId: id, category, values: {} });
});
