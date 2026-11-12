import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { defaultSshConnectionMemory, defaultReproductionConfig, normalizeSshConnectionMemory, normalizeReproductionConfig, readSshConnectionMemory, saveSshConnectionMemory, readReproductionConfig, saveReproductionConfig, selectSshProfile, filterSshProfiles, revalidateReproductionConfig, SSH_CONNECTION_MEMORY_KEY, REPRODUCTION_CONFIG_KEY } from '../src/shared/connectionPreferences.js';
const backend = createRequire(import.meta.url)('../electron/lib/connection-preferences-policy.cjs');
const uuid = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const memoryStorage = () => { const values = new Map(); return { values, getItem: key => values.get(key) ?? null, setItem: (key, raw) => values.set(key, raw) }; };

test('SSH memory is bounded to ten IDs and restores only selection/search, without credentials or connections', () => {
  let memory = defaultSshConnectionMemory();
  for (let index = 0; index < 15; index++) memory = selectSshProfile(memory, uuid(index));
  assert.equal(memory.recentIds.length, 10);
  assert.equal(memory.profileId, uuid(14));
  memory = selectSshProfile(memory, uuid(10));
  assert.equal(memory.recentIds[0], uuid(10));
  const profiles = [{ id: uuid(6), name: 'First', host: 'server-a' }, { id: uuid(10), name: 'Next', host: 'server-b' }];
  assert.equal(filterSshProfiles(profiles, memory)[0].id, uuid(10));
  assert.deepEqual(filterSshProfiles(profiles, { ...memory, search: 'SERVER-A' }).map(item => item.id), [uuid(6)]);
  const storage = memoryStorage(); saveSshConnectionMemory(memory, storage);
  assert.deepEqual(readSshConnectionMemory(storage), memory);
  assert.deepEqual(backend.normalizeSshConnectionMemory(memory), memory);
  assert.deepEqual(Object.keys(memory), ['version', 'profileId', 'search', 'recentIds']);
});

test('portable policies reject unknown fields, versions, duplicates and excessive strings consistently', () => {
  const ssh = { ...defaultSshConnectionMemory(), profileId: uuid(1), recentIds: [uuid(1)] };
  const reproduction = defaultReproductionConfig();
  const invalidSsh = [{ ...ssh, connect: true }, { ...ssh, version: 2 }, { ...ssh, search: 'x'.repeat(201) }, { ...ssh, profileId: 'bad' }, { ...ssh, recentIds: [uuid(1), uuid(1)] }, { ...ssh, recentIds: Array(1) }];
  const invalidConfig = [{ ...reproduction, start: true }, { ...reproduction, durationMs: 1 }, { ...reproduction, title: '' }, { ...reproduction, title: 'a\nb' }, { ...reproduction, selection: { ...reproduction.selection, video: 'true' } }, { ...reproduction, selection: { ...reproduction.selection, ssh: [{ sessionId: 'a', terminalId: 'b', command: 'bad' }] } }];
  invalidConfig.push({ ...reproduction, selection: { ...reproduction.selection, serial: Array(1) } });
  for (const normalize of [normalizeSshConnectionMemory, backend.normalizeSshConnectionMemory]) for (const value of invalidSsh) assert.throws(() => normalize(value));
  for (const normalize of [normalizeReproductionConfig, backend.normalizeReproductionConfig]) for (const value of invalidConfig) assert.throws(() => normalize(value));
  assert.deepEqual(backend.normalizeReproductionConfig(reproduction), normalizeReproductionConfig(reproduction));
});

test('reproduction reuse requires exact current sessions and online device, never substitutes a source', () => {
  const config = { ...defaultReproductionConfig(), deviceId: 'old-device', selection: { video: true, logs: false, performance: true, serial: [{ workspace: 'terminal', sessionId: 'old-serial' }], ssh: [{ sessionId: 'ssh', terminalId: 'old-terminal' }] } };
  const sources = { serial: [{ workspace: 'terminal', sessionId: 'new-serial' }], ssh: [{ sessionId: 'ssh', terminalId: 'new-terminal' }] };
  const next = revalidateReproductionConfig(config, [{ id: 'other', status: 'device' }], sources);
  assert.equal(next.deviceId, ''); assert.deepEqual(next.selection.serial, []); assert.deepEqual(next.selection.ssh, []);
  assert.equal(next.selection.video, true); assert.equal(config.selection.serial.length, 1);
  const exact = revalidateReproductionConfig(config, [{ id: 'old-device', status: 'device' }], { serial: config.selection.serial, ssh: config.selection.ssh });
  assert.deepEqual(exact, config);
  const storage = memoryStorage(); saveReproductionConfig(config, storage); assert.deepEqual(readReproductionConfig(storage), config);
});

test('corrupt preferences and failed writes preserve prior bytes and do not silently reset storage', () => {
  for (const [key, read, save, fallback] of [[SSH_CONNECTION_MEMORY_KEY, readSshConnectionMemory, saveSshConnectionMemory, defaultSshConnectionMemory], [REPRODUCTION_CONFIG_KEY, readReproductionConfig, saveReproductionConfig, defaultReproductionConfig]]) {
    const storage = memoryStorage(); storage.values.set(key, '{broken');
    assert.throws(() => read(storage), /原内容已保留/); assert.throws(() => save(fallback(), storage)); assert.equal(storage.getItem(key), '{broken');
    storage.values.clear(); save(fallback(), storage); const previous = storage.getItem(key);
    assert.throws(() => save(fallback(), { ...storage, setItem: () => { throw new Error('quota'); } }), /quota/);
    assert.equal(storage.getItem(key), previous);
  }
});

test('portable reproduction policies preserve exact Unicode device IDs and reject whitespace or control aliases', () => {
  const config = { ...defaultReproductionConfig(), deviceId: 'hdc:板卡-设备😀' };
  assert.equal(normalizeReproductionConfig(config).deviceId, config.deviceId);
  assert.deepEqual(backend.normalizeReproductionConfig(config), normalizeReproductionConfig(config));
  assert.equal(revalidateReproductionConfig(config, [{ id: config.deviceId, status: 'device' }], { serial: [], ssh: [] }).deviceId, config.deviceId);
  const storage = memoryStorage(); saveReproductionConfig(config, storage); assert.deepEqual(readReproductionConfig(storage), config);
  for (const deviceId of ['', 'USB-序列号']) assert.equal(backend.normalizeReproductionConfig({ ...config, deviceId }).deviceId, deviceId);
  for (const deviceId of ['hdc:设备 1', 'hdc:设备\n1', 'hdc:设备\t1', 'hdc:设备\u00001', 'hdc:设备\u30001', 'x'.repeat(161)]) {
    for (const normalize of [normalizeReproductionConfig, backend.normalizeReproductionConfig]) assert.throws(() => normalize({ ...config, deviceId }));
  }
});

test('both connection preference saves enforce the UTF-8 budget before writing any bytes', () => {
  const OriginalEncoder = globalThis.TextEncoder;
  try {
    globalThis.TextEncoder = class { encode() { return { length: 16385 }; } };
    for (const [save, fallback] of [[saveSshConnectionMemory, defaultSshConnectionMemory], [saveReproductionConfig, defaultReproductionConfig]]) {
      const storage = memoryStorage(); assert.throws(() => save(fallback(), storage)); assert.equal(storage.values.size, 0);
    }
  } finally { globalThis.TextEncoder = OriginalEncoder; }
});
