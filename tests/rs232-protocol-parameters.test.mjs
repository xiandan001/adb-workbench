import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildProtocolCommand, getProtocolParameters, listProtocolCommands } from '../src/shared/rs232Protocol.js';
import {
  defaultProtocolPreferences, normalizeProtocolPreferences, readProtocolPreferences, restoreProtocolCommand, RS232_PROTOCOL_PREFS_KEY,
  saveProtocolPreferences, upsertProtocolCommand,
} from '../src/shared/rs232ProtocolPreferences.js';
import { applyMigrationPreferences, collectMigrationPreferences } from '../src/shared/dataMigrationStorage.js';
import { completeManualTclHex } from '../src/shared/tclFactoryProtocol.js';

const require = createRequire(import.meta.url);
const main = require('../electron/lib/rs232-protocol-preferences.cjs');
const baseline = id => listProtocolCommands().find(command => command.id === id);
const entry = (base, parameterOverrides, reviewed = true) => {
  const { id, name, category, template, note } = base;
  return { id, name, category, template, note, reviewed, parameterOverrides };
};
const custom = { id: 'custom-10000000-0000-4000-8000-000000000006', name: '测试',
  category: '工厂', template: 'AA LL 31 {MODE} {MODE} CRC1 CRC2', note: '' };
const wrap = command => ({ ...defaultProtocolPreferences(), overrides: [command] });
const color = () => baseline('tcl-032');
const colorOverride = [{ key: 'XX', label: ' 白平衡 ', options: [{ label: ' 暖光 ', value: 0xA5 }] }];

test('a custom command stores named bytes, preserves option order, and generates CRC for a repeated placeholder', () => {
  const command = entry(custom, [{ key: 'MODE', label: '模式', options: [{ label: '关闭', value: 0 }, { label: '打开', value: 16 }] }]);
  const normalized = normalizeProtocolPreferences(wrap(command));
  assert.deepEqual(normalized, main.normalizeProtocolPreferences(wrap(command)));
  let stored = null;
  const store = { getItem: () => stored, setItem: (_key, value) => { stored = value; } };
  saveProtocolPreferences(normalized, store);
  const reloaded = listProtocolCommands(readProtocolPreferences(store)).find(item => item.id === custom.id);
  assert.deepEqual(getProtocolParameters(reloaded), [{ key: 'MODE', label: '模式', type: 'byte', min: 0, max: 255,
    options: [{ label: '关闭', value: 0 }, { label: '打开', value: 16 }] }]);
  assert.equal(buildProtocolCommand(reloaded, { MODE: '16' }).hex, completeManualTclHex('AA 07 31 10 10').hex);
  assert.throws(() => buildProtocolCommand(reloaded, { MODE: 17 }), { code: 'RS232_PARAMETER_INVALID' });
});

test('editing built-in color options requires review, takes effect after reload, and can be restored', () => {
  const base = color(), prefs = upsertProtocolCommand(defaultProtocolPreferences(), entry(base, colorOverride, false));
  assert.deepEqual(prefs.overrides[0].parameterOverrides, [{ key: 'XX', label: '白平衡', options: [{ label: '暖光', value: 0xA5 }] }]);
  assert.deepEqual(main.normalizeProtocolPreferences(prefs), prefs);
  let edited = listProtocolCommands(prefs).find(item => item.id === base.id);
  assert.equal(edited.needsReview, true);
  assert.throws(() => buildProtocolCommand(edited, { XX: 0xA5 }), { code: 'RS232_REVIEW_REQUIRED' });
  edited = { ...edited, reviewed: true };
  assert.equal(getProtocolParameters(edited)[0].label, '白平衡');
  assert.equal(getProtocolParameters(edited)[0].labels, undefined);
  assert.equal(buildProtocolCommand(edited, { XX: 0xA5 }).hex, completeManualTclHex('AA 06 31 A5').hex);
  assert.throws(() => buildProtocolCommand(edited, { XX: 1 }), { code: 'RS232_PARAMETER_INVALID' });
  assert.deepEqual(restoreProtocolCommand(prefs, base.id), defaultProtocolPreferences());
  assert.deepEqual(getProtocolParameters(base)[0].options.map(option => option.value), [1, 2, 3]);
});

test('explicitly removing dropdown options preserves the original numeric range, and an empty top-level array inherits', () => {
  const base = color(), cleared = entry(base, [{ key: 'XX', label: '色温', options: [] }]);
  const parameter = getProtocolParameters(cleared)[0];
  assert.equal(parameter.options, undefined);
  assert.equal(parameter.labels['en-US'], getProtocolParameters(base)[0].labels['en-US']);
  assert.deepEqual([parameter.min, parameter.max], [1, 3]);
  assert.equal(buildProtocolCommand(cleared, { XX: '2' }).hex, buildProtocolCommand(base, { XX: '2' }).hex);
  assert.throws(() => buildProtocolCommand(cleared, { XX: 4 }), { code: 'RS232_PARAMETER_INVALID' });
  const inherited = normalizeProtocolPreferences(wrap(entry(base, [])));
  assert.equal(Object.hasOwn(inherited.overrides[0], 'parameterOverrides'), false);
  assert.deepEqual(getProtocolParameters(inherited.overrides[0]), getProtocolParameters(base));
});

test('renderer/main and direct frame calls reject invalid option shapes without changing ASCII or HEX', () => {
  const command = entry(color(), colorOverride);
  const bad = [
    [colorOverride[0], colorOverride[0]],
    [{ ...colorOverride[0], key: 'MISSING' }],
    [{ ...colorOverride[0], label: '  ' }],
    [{ ...colorOverride[0], label: 'Bad\0' }],
    [{ ...colorOverride[0], options: [{ label: 'first', value: 1 }, { label: 'second', value: 1 }] }],
    [{ ...colorOverride[0], options: [{ label: 'Voice', value: 1 }, { label: 'voice', value: 2 }] }],
    ...[256, -1, 0.5, 'A5', null].map(value => [{ ...colorOverride[0], options: [{ label: 'option', value }] }]),
  ];
  for (const parameterOverrides of bad) {
    const invalid = { ...command, parameterOverrides };
    assert.throws(() => normalizeProtocolPreferences(wrap(invalid)));
    assert.throws(() => main.normalizeProtocolPreferences(wrap(invalid)));
    assert.throws(() => getProtocolParameters(invalid), { code: 'RS232_PARAMETER_INVALID' });
  }
  for (const [id, key, type] of [['tcl-016', 'SN', 'ascii'], ['tcl-044', 'DATA', 'hex'], ['lango-107', 'YY', 'ascii']]) {
    const base = baseline(id), invalid = entry(base, [{ ...colorOverride[0], key }]);
    assert.equal(getProtocolParameters(base).find(parameter => parameter.key === key).type, type);
    assert.throws(() => normalizeProtocolPreferences(wrap(invalid)));
    assert.throws(() => main.normalizeProtocolPreferences(wrap(invalid)));
    assert.throws(() => buildProtocolCommand(invalid, {}), { code: 'RS232_PARAMETER_INVALID' });
  }
});

test('configuration paths bound editable data, reject accessors, and round-trip through the existing migration policy', () => {
  const id = RS232_PROTOCOL_PREFS_KEY;
  const backend = require('../electron/lib/data-migration-policy.cjs');
  const normal = normalizeProtocolPreferences(wrap(entry(color(), colorOverride)));
  const raw = JSON.stringify(normal), source = { getItem: key => key === id ? raw : null };
  const transported = backend.normalizePreferences(collectMigrationPreferences(source));
  let migrated;
  const target = { getItem: () => null, setItem(key, value) { if (key === id) migrated = value; } };
  applyMigrationPreferences(transported, target);
  assert.equal(migrated, raw);

  const rows = Array.from({ length: 65 }, (_, value) => ({ label: String(value), value }));
  assert.throws(() => normalizeProtocolPreferences(wrap(entry(color(), [{ key: 'XX', label: '模式', options: rows }]))));
  const keys = Array.from({ length: 33 }, (_, index) => `P${index}`);
  const many = { ...custom, template: `AA LL 31 ${keys.map(key => `{${key}}`).join(' ')} CRC1 CRC2` };
  assert.throws(() => main.normalizeProtocolPreferences(wrap(entry(many, keys.map(key => ({ key, label: key, options: [] }))))));
  const accessor = { label: '不可读', value: 1 };
  let reads = 0;
  Object.defineProperty(accessor, 'value', { enumerable: true, get() { reads++; return 1; } });
  const unsafe = wrap(entry(color(), [{ key: 'XX', label: '模式', options: [accessor] }]));
  assert.throws(() => normalizeProtocolPreferences(unsafe));
  assert.throws(() => main.normalizeProtocolPreferences(unsafe));
  assert.equal(reads, 0);
});
