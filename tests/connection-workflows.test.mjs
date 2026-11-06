import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { defaultSerialPreferences, normalizePreferences, readSerialPreferences, saveSerialPreferences } from '../src/shared/serialSettings.js';
import { addSerialScheme, applySerialScheme, removeSerialScheme } from '../src/shared/serialSchemes.js';
import { resolveSshReconnectProfile } from '../src/shared/sshReconnect.js';
import { subscribeConnectionStatus } from '../src/shared/connectionStatus.js';
import { collectMigrationPreferences, applyMigrationPreferences } from '../src/shared/dataMigrationStorage.js';
const require = createRequire(import.meta.url);
const backend = require('../electron/lib/serial-policy.cjs');
const migration = require('../electron/lib/data-migration-policy.cjs');

function savedSchemes() {
  let preferences = { ...defaultSerialPreferences(), receiveMode: 'hex', sendMode: 'ascii', lineEnding: 'crlf' };
  preferences = addSerialScheme(preferences, { id: 'rs', name: '板卡 A', workspace: 'rs232', config: { ...preferences.config, baudRate: 115200 } });
  return addSerialScheme(preferences, { id: 'term', name: '调试台', workspace: 'terminal', config: { ...preferences.terminalConfig, baudRate: 921600 }, terminalEnter: 'lf' });
}
test('serial schemes migrate only on creation, round-trip with exact front/back schema and retain both workspaces', () => {
  assert.equal(normalizePreferences(defaultSerialPreferences()).version, 2);
  const value = savedSchemes();
  assert.equal(value.version, 3);
  assert.deepEqual(backend.normalizePreferences(value), normalizePreferences(value));
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, raw) => data.set(key, raw), removeItem: key => data.delete(key) };
  saveSerialPreferences(value, storage);
  assert.deepEqual(readSerialPreferences(storage), value);
  const portable = migration.normalizePreferences(collectMigrationPreferences(storage));
  const target = new Map([['serial-current-port', 'COM9']]);
  const destination = { getItem: key => target.get(key) ?? null, setItem: (key, raw) => target.set(key, raw), removeItem: key => target.delete(key) };
  applyMigrationPreferences(portable, destination);
  assert.deepEqual(readSerialPreferences(destination), value);
  assert.equal(destination.getItem('serial-current-port'), 'COM9');
});

test('serial scheme application changes only the selected workspace and never binds a port or sends content', () => {
  const preferences = { ...savedSchemes(), receiveMode: 'text', sendMode: 'hex', lineEnding: 'none' };
  const before = structuredClone(preferences);
  const rs = applySerialScheme(preferences, 'rs', 'rs232', { status: 'disconnected' });
  assert.equal(rs.preferences.config.baudRate, 115200);
  assert.equal(rs.preferences.sendMode, 'ascii');
  assert.equal(rs.preferences.lineEnding, 'crlf');
  assert.deepEqual(rs.preferences.terminalConfig, preferences.terminalConfig);
  const terminal = applySerialScheme(preferences, 'term', 'terminal', { status: 'disconnected' });
  assert.equal(terminal.preferences.terminalConfig.baudRate, 921600);
  assert.equal(terminal.terminalEnter, 'lf');
  assert.deepEqual(terminal.preferences.config, preferences.config);
  for (const key of ['sendMode', 'receiveMode', 'lineEnding']) assert.equal(terminal.preferences[key], preferences[key]);
  assert.deepEqual(preferences, before);
  assert.ok(!JSON.stringify(terminal).includes('COM'));
  assert.throws(() => applySerialScheme(preferences, 'rs', 'terminal', { status: 'disconnected' }), /另一工作区/);
  for (const status of ['connected', 'connecting', 'disconnecting', undefined]) assert.throws(() => applySerialScheme(preferences, 'rs', 'rs232', { status }), /先断开/);
  assert.throws(() => applySerialScheme(preferences, 'rs', 'rs232', { status: 'disconnected', pending: true }), /先断开/);
  assert.equal(removeSerialScheme(preferences, 'rs', 'rs232').schemes.length, 1);
  assert.deepEqual(removeSerialScheme(preferences, 'rs', 'terminal').schemes, preferences.schemes);
});

test('both serial schemas reject excessive, ambiguous, executable and malformed scheme data without truncation', () => {
  const value = savedSchemes();
  const scheme = value.schemes[0];
  const invalid = [
    { ...scheme, name: ' ' }, { ...scheme, name: 'a'.repeat(81) }, { ...scheme, name: 'A\nB' },
    { ...scheme, id: '__proto__' }, { ...scheme, workspace: 'other' }, { ...scheme, autoConnect: true },
    { ...scheme, config: { ...scheme.config, path: 'COM9' } }, { ...scheme, terminalEnter: 'none' },
    { ...scheme, sendMode: 'bad' }, { ...scheme, lineEnding: 'bad' }
  ];
  for (const policy of [normalizePreferences, backend.normalizePreferences]) {
    for (const item of invalid) assert.throws(() => policy({ ...value, schemes: [item] }));
    assert.throws(() => policy({ ...value, schemes: [scheme, { ...scheme, id: 'another', name: ' 板卡 A ' }] }), /不能重复/);
    assert.throws(() => policy({ ...value, schemes: Array.from({ length: 21 }, (_, index) => ({ ...scheme, id: String(index), name: String(index) })) }), /20/);
    assert.throws(() => policy({ ...value, schemes: [{ ...scheme, name: '中'.repeat(30000) }] }), /64 KiB/);
  }
});

test('SSH reconnect selection is bound to the old session profile and original host, never a globally selected profile', () => {
  const session = { id: 'old-a', profileId: 'a', status: 'disconnected', host: 'host-a', username: 'root', port: 22 };
  const profiles = [{ id: 'b', host: 'host-b', username: 'root', port: 22 }, { id: 'a', host: 'host-a', username: 'root', port: 22 }];
  assert.equal(resolveSshReconnectProfile(session, profiles).id, 'a');
  assert.throws(() => resolveSshReconnectProfile({ ...session, status: 'connected' }, profiles), /不能重复重连/);
  assert.throws(() => resolveSshReconnectProfile({ ...session, profileId: undefined }, profiles), /没有已保存/);
  assert.throws(() => resolveSshReconnectProfile(session, [{ ...profiles[1], host: 'host-b' }]), /不会重连/);
});

function eventTarget() {
  const listeners = new Map();
  return { hidden: false, addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); },
    emit: name => listeners.get(name)?.(), listeners };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const summary = activeCount => ({ activeCount, pendingCount: 0, unsavedCount: 0, failedCount: 0, transferCount: 0, labels: [] });
test('sidebar status keeps subscriptions separate, ignores stale snapshots and cleans up without changing sessions', async () => {
  const document = eventTarget(); const window = eventTarget();
  const events = {}; const calls = []; const values = []; let initialResolve;
  const api = {};
  for (const kind of ['serial', 'ssh']) {
    api[kind + 'ConnectionStatusSubscribe'] = args => {
      calls.push([kind, args.active]);
      if (kind === 'serial' && args.active && !initialResolve) return new Promise(resolve => { initialResolve = resolve; });
      return Promise.resolve({ success: true, status: summary(1) });
    };
    api[kind === 'serial' ? 'onSerialConnectionStatus' : 'onSshConnectionStatus'] = callback => { events[kind] = callback; return () => { delete events[kind]; }; };
  }
  const stop = subscribeConnectionStatus({ api, document, window, onStatus: (kind, status) => values.push([kind, status.activeCount]), onError: () => {} });
  await tick();
  events.serial(summary(2));
  initialResolve({ success: true, status: summary(0) });
  await tick();
  assert.deepEqual(values.filter(([kind]) => kind === 'serial'), [['serial', 2]]);
  document.hidden = true; document.emit('visibilitychange'); await tick();
  assert.ok(calls.some(([kind, active]) => kind === 'serial' && !active));
  document.hidden = false; document.emit('visibilitychange'); await tick();
  stop(); await tick();
  assert.deepEqual(Object.keys(events), []);
  assert.equal(document.listeners.size, 0);
  assert.equal(window.listeners.size, 0);
  assert.deepEqual(calls.slice(-2), [['serial', false], ['ssh', false]]);
});
