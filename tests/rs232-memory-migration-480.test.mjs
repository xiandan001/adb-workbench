import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as memory from '../src/shared/rs232ProtocolMemory.js';
import { listProtocolCommands } from '../src/shared/rs232Protocol.js';
import { PORTABLE_PREF_KEYS, collectMigrationPreferences, applyMigrationPreferences } from '../src/shared/dataMigrationStorage.js';
import { restoreStartupData } from '../src/shared/dataMigrationBootstrap.js';

const require = createRequire(import.meta.url), policy = require('../electron/lib/data-migration-policy.cjs');
const backend = require('../electron/lib/rs232-memory-policy.cjs'), archive = require('../electron/lib/data-migration-archive.cjs');
const commands = listProtocolCommands(), volume = commands.find(item => item.id === 'lango-042');
const scope = { workspace: 'rs232', schemeId: '' }, terminal = { workspace: 'terminal', schemeId: '' };
function storage(initial = {}) {
  const values = new Map(Object.entries(initial)), writes = [];
  return { values, writes, getItem: key => values.get(key) ?? null,
    setItem(key, value) { writes.push(['set', key, value]); values.set(key, value); },
    removeItem(key) { writes.push(['remove', key]); values.delete(key); } };
}
function remembered(value = 50) {
  return memory.rememberProtocolSelection(memory.defaultRs232Memory(), scope,
    { selectedId: volume.id, category: volume.category, command: volume, values: { XX: String(value) } });
}
const preferences = value => ({ [memory.RS232_MEMORY_KEY]: JSON.stringify(value) });

test('real portable archive and startup restore retain separate default scopes and view mode before acknowledgement, without live state or sends', async () => {
  assert.deepEqual(PORTABLE_PREF_KEYS, policy.PORTABLE_PREF_KEYS);
  assert.ok(PORTABLE_PREF_KEYS.includes(memory.RS232_MEMORY_KEY));
  assert.equal(backend.RS232_MEMORY_BYTES, memory.RS232_MEMORY_BYTES);
  let value = memory.setRs232MemoryViewMode(remembered(), scope, 'transactions');
  value = memory.rememberProtocolSelection(value, terminal,
    { selectedId: volume.id, category: volume.category, command: volume, values: { XX: '7' } });
  const original = JSON.stringify(value, null, 2) + '\n';
  const source = storage({ [memory.RS232_MEMORY_KEY]: original, 'serial-current-port': 'COM-PRIVATE',
    'serial-active-session': 'PRIVATE SESSION', 'serial-rx': 'PRIVATE RX', 'serial-history': 'PRIVATE HISTORY' });
  const collected = collectMigrationPreferences(source);
  assert.deepEqual(collected, { [memory.RS232_MEMORY_KEY]: original });
  const normalized = policy.normalizePreferences(collected);
  assert.deepEqual(JSON.parse(normalized[memory.RS232_MEMORY_KEY]), backend.normalizeRs232Memory(value));
  assert.deepEqual(backend.normalizeRs232Memory(value), memory.normalizeRs232Memory(value));
  const encoded = archive.encodeArchive({ schemaVersion: 1, appVersion: '4.8.0', createdAt: '2026-11-17T00:00:00.000Z', files: [], preferences: collected });
  const decoded = archive.readArchive(encoded);
  assert.equal(decoded.summary.preferenceCount, 1);
  assert.deepEqual(decoded.payload.preferences, normalized);
  const retained = { 'serial-current-port': 'COM-KEEP', 'serial-rx': 'KEEP RX', 'serial-history': 'KEEP HISTORY', activeDeviceId: 'KEEP DEVICE' };
  const target = storage(retained); applyMigrationPreferences(decoded.payload.preferences, target);
  assert.deepEqual(memory.restoreProtocolSelection(memory.readRs232Memory(target), scope, commands).values, { XX: 50 });
  assert.deepEqual(memory.restoreProtocolSelection(memory.readRs232Memory(target), terminal, commands).values, { XX: 7 });
  assert.equal(memory.getRs232MemoryScope(memory.readRs232Memory(target), scope).viewMode, 'transactions');
  assert.equal(memory.getRs232MemoryScope(memory.readRs232Memory(target), terminal).viewMode, 'raw');
  const startup = storage(retained), calls = [];
  await restoreStartupData({
    migrationBootstrap: async () => { calls.push('bootstrap'); return { ok: true, id: 'fixture', preferences: decoded.payload.preferences }; },
    migrationAcknowledge: async ({ id }) => {
      assert.equal(id, 'fixture');
      assert.deepEqual(memory.restoreProtocolSelection(memory.readRs232Memory(startup), scope, commands).values, { XX: 50 });
      assert.equal(memory.getRs232MemoryScope(memory.readRs232Memory(startup), scope).viewMode, 'transactions');
      calls.push('ack'); return { ok: true };
    }
  }, startup);
  assert.deepEqual(calls, ['bootstrap', 'ack']);
  for (const [key, raw] of Object.entries(retained)) { assert.equal(target.getItem(key), raw); assert.equal(startup.getItem(key), raw); }
  assert.equal(source.getItem(memory.RS232_MEMORY_KEY), original); assert.deepEqual(source.writes, []);
});

test('portable memory uses the exact UTF-8 byte budget and rejects corrupt or unsafe data before any destination write', () => {
  const value = remembered(), raw = JSON.stringify(value), exact = raw + ' '.repeat(memory.RS232_MEMORY_BYTES - Buffer.byteLength(raw, 'utf8'));
  assert.equal(Buffer.byteLength(exact, 'utf8'), 32768);
  assert.deepEqual(collectMigrationPreferences(storage({ [memory.RS232_MEMORY_KEY]: exact })), { [memory.RS232_MEMORY_KEY]: exact });
  assert.deepEqual(policy.normalizePreferences({ [memory.RS232_MEMORY_KEY]: exact }), policy.normalizePreferences(preferences(value)));
  const changed = change => { const next = structuredClone(value); change(next); return JSON.stringify(next); };
  const invalid = ['{broken PRIVATE', exact + ' ', changed(next => { next.raw = 'PRIVATE'; }),
    changed(next => { next.scopes[0].path = 'COM4'; }), changed(next => { next.scopes[0].autoSend = true; }),
    changed(next => { next.scopes[0].parameters[0].commandId = 'lango-107'; next.scopes[0].parameters[0].values.XX = 'PRIVATE ASCII'; }),
    changed(next => { next.scopes[0].parameters[0].commandId = 'custom-10000000-0000-4000-8000-000000000001'; })];
  for (const bad of invalid) {
    const source = storage({ [memory.RS232_MEMORY_KEY]: bad });
    const target = storage({ currentTheme: 'graphite', [memory.RS232_MEMORY_KEY]: '{EXACT CORRUPT ORIGINAL', unrelated: 'keep' });
    const before = Object.fromEntries(target.values);
    assert.throws(() => collectMigrationPreferences(source));
    assert.throws(() => policy.normalizePreferences({ [memory.RS232_MEMORY_KEY]: bad }));
    assert.throws(() => applyMigrationPreferences({ currentTheme: 'default', [memory.RS232_MEMORY_KEY]: bad }, target));
    assert.deepEqual(Object.fromEntries(target.values), before); assert.deepEqual(target.writes, []);
    assert.equal(source.getItem(memory.RS232_MEMORY_KEY), bad); assert.deepEqual(source.writes, []);
  }
});

test('a quota failure after writing imported memory rolls back exact valid, corrupt and absent originals with earlier keys', () => {
  const incoming = policy.normalizePreferences(preferences(remembered())), imported = incoming[memory.RS232_MEMORY_KEY];
  for (const previous of [JSON.stringify(remembered(7), null, 2) + '\n', '{EXACT CORRUPT ORIGINAL\n', null]) {
    const target = storage({ currentTheme: 'graphite', ...(previous === null ? {} : { [memory.RS232_MEMORY_KEY]: previous }), unrelated: 'keep' });
    const before = Object.fromEntries(target.values), write = target.setItem;
    target.setItem = (key, content) => { write(key, content); if (key === memory.RS232_MEMORY_KEY && content === imported) throw Error('quota after write'); };
    assert.throws(() => applyMigrationPreferences({ currentTheme: 'default', ...incoming }, target), /quota after write/);
    assert.deepEqual(Object.fromEntries(target.values), before);
    assert.equal(target.getItem(memory.RS232_MEMORY_KEY), previous);
  }
});

test('startup quota recovery restores memory or removes only its formerly absent key before acknowledging rollback', async () => {
  const incoming = policy.normalizePreferences(preferences(remembered())), imported = incoming[memory.RS232_MEMORY_KEY];
  for (const previous of [JSON.stringify(remembered(7), null, 2) + '\n', null]) {
    const target = storage({ currentTheme: 'graphite', ...(previous === null ? {} : { [memory.RS232_MEMORY_KEY]: previous }), unrelated: 'keep' });
    const before = Object.fromEntries(target.values), write = target.setItem, calls = [];
    target.setItem = (key, content) => { write(key, content); if (key === memory.RS232_MEMORY_KEY && content === imported) throw Error('quota after write'); };
    await restoreStartupData({
      migrationBootstrap: async () => { calls.push('bootstrap'); return { ok: true, id: 'fixture', preferences: { currentTheme: 'default', ...incoming } }; },
      migrationRollback: async ({ id }) => {
        assert.equal(id, 'fixture'); assert.deepEqual(Object.fromEntries(target.values), before); calls.push('rollback');
        return { ok: true, preferences: { currentTheme: 'graphite', ...(previous === null ? {} : { [memory.RS232_MEMORY_KEY]: previous }) },
          removePreferenceKeys: previous === null ? [memory.RS232_MEMORY_KEY] : [] };
      },
      migrationAcknowledge: async ({ id }) => {
        assert.equal(id, 'fixture'); assert.deepEqual(Object.fromEntries(target.values), before); calls.push('ack'); return { ok: true };
      }
    }, target);
    assert.deepEqual(calls, ['bootstrap', 'rollback', 'ack']); assert.deepEqual(Object.fromEntries(target.values), before);
  }
});
