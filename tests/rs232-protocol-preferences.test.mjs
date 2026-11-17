import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const load = () => import('../src/shared/rs232ProtocolPreferences.js');
const backend = () => require('../electron/lib/rs232-protocol-preferences.cjs');
const customId = index => `custom-10000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
const command = (id = customId(1)) => ({ id, name: '设备开机', category: '常用操作', template: 'FE 08 58 42 48 43 4D 44 00 01 CF', note: '用户原文\n不修正 LL', reviewed: true });
const config = () => ({ version: 1, overrides: [], removed: [] });
function storage(initial = {}) {
  const values = new Map(Object.entries(initial)), writes = [];
  return { values, writes, getItem: key => values.get(key) ?? null, setItem: (key, value) => { writes.push([key, value]); values.set(key, value); }, removeItem: key => values.delete(key) };
}

test('frontend/backend expose the exact defaults, IDs and canonical projection without changing literal templates', async () => {
  const f = await load(), b = backend();
  assert.equal(f.RS232_PROTOCOL_PREFS_KEY, 'adb-workbench.rs232-protocol.v1'); assert.equal(f.RS232_PROTOCOL_PREFS_LIMIT, 512 * 1024);
  assert.deepEqual(f.defaultProtocolPreferences(), config()); assert.deepEqual(b.defaultProtocolPreferences(), config());
  const value = { ...config(), overrides: [command('lango-001'), { ...command('lango-report-4'), reviewed: false }, command()], removed: ['lango-001', 'lango-111', 'lango-report-1'] };
  const normalized = f.normalizeProtocolPreferences(value); assert.deepEqual(normalized, b.normalizeProtocolPreferences(value)); assert.deepEqual(normalized, value);
  normalized.overrides[0].note = 'changed return value'; assert.equal(value.overrides[0].note, '用户原文\n不修正 LL');
});
test('pure CRUD adds/edits/custom-deletes, soft-deletes builtins and restores the exact builtin default without mutating old preferences', async () => {
  const f = await load(), original = config(), frozen = structuredClone(original);
  const added = f.upsertProtocolCommand(original, command()); assert.deepEqual(original, frozen); assert.equal(added.overrides.length, 1);
  const edited = f.upsertProtocolCommand(added, { ...command(), name: '我的按钮', template: ' FE FF 00 CF\n', reviewed: false });
  assert.equal(edited.overrides[0].template, ' FE FF 00 CF\n'); assert.equal(added.overrides[0].name, '设备开机');
  assert.deepEqual(f.removeProtocolCommand(edited, customId(1)), config());
  const builtin = f.upsertProtocolCommand(original, command('lango-002')), deleted = f.removeProtocolCommand(builtin, 'lango-002');
  assert.equal(deleted.overrides.length, 1); assert.deepEqual(deleted.removed, ['lango-002']); assert.deepEqual(f.removeProtocolCommand(deleted, 'lango-002'), deleted);
  assert.deepEqual(f.restoreProtocolCommand(deleted, 'lango-002'), config());
  assert.deepEqual(f.upsertProtocolCommand(deleted, command('lango-002')).removed, []); assert.throws(() => f.restoreProtocolCommand(edited, customId(1)));
});
test('single-key save/read survives a restart, never persists port/session/history and leaves old raw bytes on quota failure', async () => {
  const f = await load(), key = f.RS232_PROTOCOL_PREFS_KEY, oldRaw = ' {"version":1,"overrides":[],"removed":[]} ';
  const local = storage({ [key]: oldRaw, 'serial-current-port': 'COM9', 'serial-history': 'PRIVATE RX', 'serial-draft': 'PRIVATE TX' });
  const next = f.upsertProtocolCommand(config(), command()); f.saveProtocolPreferences(next, local);
  const restarted = storage(Object.fromEntries(local.values)); assert.deepEqual(f.readProtocolPreferences(restarted), next);
  assert.deepEqual(local.writes.map(([written]) => written), [key]); assert.equal(local.getItem('serial-current-port'), 'COM9'); assert.equal(local.getItem('serial-history'), 'PRIVATE RX');
  const quota = storage({ [key]: oldRaw }); quota.setItem = () => { throw new DOMException('quota private detail', 'QuotaExceededError'); };
  assert.throws(() => f.saveProtocolPreferences(next, quota)); assert.equal(quota.getItem(key), oldRaw);
});
test('corrupt, oversized and unreadable storage never gets overwritten or silently reset', async () => {
  const f = await load(), key = f.RS232_PROTOCOL_PREFS_KEY;
  for (const raw of ['{broken PRIVATE', ' '.repeat(f.RS232_PROTOCOL_PREFS_LIMIT + 1), '{"version":2,"overrides":[],"removed":[]}']) {
    const local = storage({ [key]: raw }); assert.throws(() => f.readProtocolPreferences(local)); assert.throws(() => f.saveProtocolPreferences(config(), local));
    assert.equal(local.getItem(key), raw); assert.equal(local.writes.length, 0);
  }
  const local = storage(); local.getItem = () => { throw Error('PRIVATE permission path'); };
  assert.throws(() => f.readProtocolPreferences(local), error => !error.message.includes('PRIVATE'));
  assert.equal(local.writes.length, 0);
});
test('both strict normalizers reject unknown fields, duplicate/unsafe IDs, prototypes, getters, sparse arrays and invalid bounds', async () => {
  const f = await load(), b = backend(); let reads = 0;
  const accessor = command(); Object.defineProperty(accessor, 'name', { enumerable: true, get() { reads++; throw Error('PRIVATE getter'); } });
  const sparse = []; sparse.length = 1; const extraArray = []; extraArray.private = 'hidden';
  const invalid = [
    { ...config(), version: 2 }, { ...config(), path: 'COM7' }, { ...config(), history: [] }, Object.assign(Object.create({ inherited: true }), config()),
    { ...config(), overrides: [command(), command()] }, { ...config(), removed: ['lango-001', 'lango-001'] }, { ...config(), removed: [customId(1)] },
    ...['lango-000', 'lango-112', 'lango-01', 'lango-report-0', 'lango-report-5', 'lango-００１', 'custom-../unsafe'].map(id => ({ ...config(), overrides: [command(id)] })),
    { ...config(), overrides: [{ ...command(), sourceControl: 'PRIVATE' }] }, { ...config(), overrides: [{ ...command(), reviewed: 'true' }] },
    { ...config(), overrides: [accessor] }, { ...config(), overrides: sparse }, { ...config(), removed: extraArray },
    ...[['name', ''], ['category', '  '], ['template', ''], ['name', 'x'.repeat(81)], ['category', 'x'.repeat(41)], ['template', 'x'.repeat(8193)], ['note', 'x'.repeat(2001)], ['note', '\u0000']]
      .map(([field, value]) => ({ ...config(), overrides: [{ ...command(), [field]: value }] })),
  ];
  for (const value of invalid) { assert.throws(() => f.normalizeProtocolPreferences(value)); assert.throws(() => b.normalizeProtocolPreferences(value)); }
  assert.equal(reads, 0);
});
test('count and full UTF8 budgets reject rather than truncate, while all 115 builtin removal IDs remain valid', async () => {
  const f = await load(), b = backend(), overrides = Array.from({ length: 256 }, (_, i) => command(customId(i)));
  const removed = [...Array.from({ length: 111 }, (_, i) => `lango-${String(i + 1).padStart(3, '0')}`), ...Array.from({ length: 4 }, (_, i) => `lango-report-${i + 1}`)];
  const accepted = { version: 1, overrides, removed }; assert.deepEqual(f.normalizeProtocolPreferences(accepted), b.normalizeProtocolPreferences(accepted));
  const many = { ...config(), overrides: [...overrides, command(customId(256))] }; assert.throws(() => f.normalizeProtocolPreferences(many)); assert.throws(() => b.normalizeProtocolPreferences(many)); assert.equal(many.overrides.length, 257);
  const utf8 = { ...config(), overrides: Array.from({ length: 90 }, (_, i) => ({ ...command(customId(i)), note: '界'.repeat(2000) })) };
  assert.ok(JSON.stringify(utf8).length < f.RS232_PROTOCOL_PREFS_LIMIT); assert.ok(new TextEncoder().encode(JSON.stringify(utf8)).byteLength > f.RS232_PROTOCOL_PREFS_LIMIT);
  assert.throws(() => f.normalizeProtocolPreferences(utf8)); assert.throws(() => b.normalizeProtocolPreferences(utf8)); assert.equal(utf8.overrides.length, 90);
});
