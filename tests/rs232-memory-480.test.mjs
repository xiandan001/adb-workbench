import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as memory from '../src/shared/rs232ProtocolMemory.js';
import { listProtocolCommands } from '../src/shared/rs232Protocol.js';

const require = createRequire(import.meta.url);
const policy = require('../electron/lib/rs232-memory-policy.cjs');
const scope = { workspace: 'rs232', schemeId: 'scheme-a' };
const commands = listProtocolCommands(), volume = commands.find(item => item.id === 'lango-042');
const store = raw => ({ raw, getItem() { return this.raw ?? null; }, setItem(_key, value) { this.raw = value; } });

test('memory policy agrees across main and renderer and scopes safe values without restoring a send', () => {
  assert.equal(memory.RS232_MEMORY_KEY, 'adb-workbench.rs232-memory.v1');
  assert.equal(memory.RS232_MEMORY_BYTES, 32768);
  assert.equal(policy.RS232_MEMORY_KEY, memory.RS232_MEMORY_KEY);
  const saved = memory.rememberProtocolSelection(memory.defaultRs232Memory(), scope, { selectedId: volume.id, category: volume.category, command: volume, values: { XX: '0x32' } });
  assert.deepEqual(policy.normalizeRs232Memory(saved), memory.normalizeRs232Memory(saved));
  const storage = store(); memory.writeRs232Memory(saved, storage);
  const restored = memory.restoreProtocolSelection(memory.readRs232Memory(storage), scope, commands);
  assert.equal(restored.selectedId, volume.id); assert.deepEqual(restored.values, { XX: 50 });
  assert.deepEqual(memory.restoreProtocolSelection(saved, { ...scope, schemeId: 'scheme-b' }, commands).values, {});
  assert.deepEqual(memory.restoreProtocolSelection(saved, { workspace: 'terminal', schemeId: 'scheme-a' }, commands).values, {});
  assert.equal(memory.getRs232MemoryScope(saved, scope).viewMode, 'raw');
  assert.ok(!JSON.stringify(saved).includes('send'));
});

test('ASCII, custom and changed templates do not persist parameters; invalid edits clear prior remembered values', () => {
  let value = memory.rememberProtocolSelection(memory.defaultRs232Memory(), scope, { selectedId: volume.id, category: volume.category, command: volume, values: { XX: '50' } });
  assert.deepEqual(memory.restoreProtocolSelection(value, scope, commands.map(command => command.id === volume.id ? { ...command, template: command.template.replace('FE', 'fe') } : command)).values, {});
  value = memory.rememberProtocolSelection(value, scope, { selectedId: volume.id, category: volume.category, command: volume, values: { XX: '0x' } });
  assert.deepEqual(memory.restoreProtocolSelection(value, scope, commands).values, {});
  const ascii = commands.find(item => item.id === 'lango-107');
  value = memory.rememberProtocolSelection(value, scope, { selectedId: ascii.id, category: ascii.category, command: ascii, values: { XX: 'PRIVATE_ASCII', YY: 'PRIVATE_ASCII' } });
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_ASCII/);
  const custom = { id: 'custom-00000000-0000-0000-0000-000000000001', category: 'custom', template: volume.template, parameters: volume.parameters };
  value = memory.rememberProtocolSelection(value, scope, { selectedId: custom.id, category: custom.category, command: custom, values: { XX: '55' } });
  assert.equal(memory.getRs232MemoryScope(value, scope).parameters.length, 0);
});

test('removed schemes use only workspace defaults; deleted commands and categories fall back without changing stored bytes', () => {
  assert.deepEqual(memory.effectiveProtocolMemoryScope('rs232', 'gone', []), { workspace: 'rs232', schemeId: '' });
  assert.deepEqual(memory.effectiveProtocolMemoryScope('rs232', 'scheme-a', [{ id: 'scheme-a', workspace: 'terminal' }]), { workspace: 'rs232', schemeId: '' });
  const saved = memory.rememberProtocolSelection(memory.defaultRs232Memory(), scope, { selectedId: volume.id, category: volume.category, command: volume, values: { XX: '12' } });
  const before = JSON.stringify(saved);
  const restored = memory.restoreProtocolSelection(saved, scope, commands.filter(item => item.id !== volume.id));
  assert.equal(restored.selectedId, 'lango-005'); assert.deepEqual(restored.values, {});
  assert.equal(JSON.stringify(saved), before);
});

test('strict bounded memory preserves corrupt/quota bytes and isolates resets', () => {
  for (const invalid of [{ version: 2, scopes: [] }, { version: 1, scopes: [], extra: true }, { version: 1, scopes: Array(21).fill({}) }]) {
    assert.throws(() => memory.normalizeRs232Memory(invalid)); assert.throws(() => policy.normalizeRs232Memory(invalid));
  }
  const corrupt = store('{broken'); assert.throws(() => memory.writeRs232Memory(memory.defaultRs232Memory(), corrupt)); assert.equal(corrupt.raw, '{broken');
  const denied = store(); denied.setItem = () => { throw Error('quota'); };
  assert.throws(() => memory.writeRs232Memory(memory.defaultRs232Memory(), denied)); assert.equal(denied.raw, undefined);
  let saved = memory.rememberProtocolSelection(memory.defaultRs232Memory(), scope, { selectedId: volume.id, category: volume.category, command: volume, values: { XX: '12' } });
  saved = memory.setRs232MemoryViewMode(saved, { ...scope, schemeId: 'b' }, 'transactions');
  saved = memory.clearRs232ScopeMemory(saved, scope);
  assert.equal(saved.scopes.length, 1); assert.equal(saved.scopes[0].schemeId, 'b');
});
