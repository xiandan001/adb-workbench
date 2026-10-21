import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as frontend from '../src/shared/serialSettings.js';

const require = createRequire(import.meta.url);
const backend = require('../electron/lib/serial-policy.cjs');
const policies = [frontend, backend];
const config = { baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' };
const message = (content, mode = 'text', lineEnding = 'none') => ({ mode, content, lineEnding });
const favorite = { id: 'power', name: '开机', ...message('00 ff', 'hex', 'crlf') };
const preferences = () => ({ version: 1, config: { ...config }, receiveMode: 'text', sendMode: 'text', lineEnding: 'none', favorites: [] });

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test('renderer and backend defaults match and returned defaults are independent', () => {
  assert.deepEqual(frontend.DEFAULT_CONFIG, config);
  assert.deepEqual(backend.DEFAULT_CONFIG, config);
  assert.deepEqual(frontend.defaultSerialPreferences(), preferences());
  for (const policy of policies) {
    const result = policy.normalizeConfig();
    assert.deepEqual(result, config);
    result.baudRate = 115200;
    assert.equal(policy.DEFAULT_CONFIG.baudRate, 9600);
  }
  const first = frontend.defaultSerialPreferences();
  first.favorites.push(favorite);
  first.config.baudRate = 115200;
  assert.deepEqual(frontend.defaultSerialPreferences(), preferences());
});

test('framing validation accepts explicit supported values and rejects incomplete or unsafe configurations', () => {
  for (const policy of policies) {
    for (const baudRate of [1, 9600, 115200, 4000000]) assert.equal(policy.normalizeConfig({ ...config, baudRate }).baudRate, baudRate);
    for (const dataBits of [5, 6, 7, 8]) assert.equal(policy.normalizeConfig({ ...config, dataBits }).dataBits, dataBits);
    for (const stopBits of [1, 1.5, 2]) assert.equal(policy.normalizeConfig({ ...config, stopBits }).stopBits, stopBits);
    for (const parity of ['none', 'even', 'odd', 'mark', 'space']) assert.equal(policy.normalizeConfig({ ...config, parity }).parity, parity);
    for (const flowControl of ['none', 'rtscts', 'xonxoff']) assert.equal(policy.normalizeConfig({ ...config, flowControl }).flowControl, flowControl);
    for (const value of [null, [], {}, { baudRate: 9600 }, { ...config, path: 'COM3' },
      { ...config, baudRate: '9600' }, { ...config, baudRate: 0 }, { ...config, baudRate: NaN },
      { ...config, baudRate: Infinity }, { ...config, baudRate: 1.5 }, { ...config, baudRate: 4000001 },
      { ...config, dataBits: 9 }, { ...config, stopBits: 0 }, { ...config, parity: 'NONE' },
      { ...config, flowControl: 'auto' }, Object.create(config)]) assert.throws(() => policy.normalizeConfig(value));
  }
});

test('text encoding preserves content and appends exactly the selected ending', () => {
  for (const policy of policies) {
    for (const [ending, bytes] of [['none', []], ['lf', [10]], ['cr', [13]], ['crlf', [13, 10]]]) {
      assert.deepEqual([...policy.encodeMessage(message('A\r\n', 'text', ending))], [65, 13, 10, ...bytes]);
    }
    assert.deepEqual([...policy.encodeMessage(message('中\0😀'))], [...Buffer.from('中\0😀')]);
    assert.deepEqual([...policy.encodeMessage(message(' '))], [32]);
    assert.deepEqual([...policy.encodeMessage(message('\ud800'))], [...Buffer.from('\ud800')]);
  }
  assert.ok(frontend.encodeMessage(message('A')) instanceof Uint8Array);
  assert.ok(Buffer.isBuffer(backend.encodeMessage(message('A'))));
});

test('HEX encoding preserves all bytes and never appends a text ending', () => {
  for (const policy of policies) {
    for (const content of ['00 ff 80', '00FF80', '  00\tFF\r\n80  ']) {
      for (const ending of ['none', 'lf', 'cr', 'crlf']) {
        assert.deepEqual([...policy.encodeMessage(message(content, 'hex', ending))], [0, 255, 128]);
      }
    }
    assert.deepEqual([...policy.encodeMessage({ sessionId: 'current', ...message('0d0a', 'hex') })], [13, 10]);
  }
});

test('invalid or empty sends are rejected with contextual reasons', () => {
  for (const policy of policies) {
    for (const content of ['', ' ', '0', '0 0', '0xFF', 'FF,00', 'GG', 'FF:00', '00\0ff']) {
      assert.throws(() => policy.encodeMessage(message(content, 'hex')), /HEX|内容/);
    }
    for (const value of [null, {}, [], message('', 'text'), message(123), message('A', 'binary'), message('A', 'text', 'auto')]) {
      assert.throws(() => policy.encodeMessage(value));
    }
  }
});

test('64 KiB limit is based on final encoded bytes, including newline, before allocating HEX output', () => {
  for (const policy of policies) {
    assert.equal(policy.encodeMessage(message('a'.repeat(65536))).length, 65536);
    assert.equal(policy.encodeMessage(message('a'.repeat(65534), 'text', 'crlf')).length, 65536);
    assert.equal(policy.encodeMessage(message('ff'.repeat(65536), 'hex', 'crlf')).length, 65536);
    assert.throws(() => policy.encodeMessage(message('a'.repeat(65536), 'text', 'lf')), /64/);
    assert.throws(() => policy.encodeMessage(message('中'.repeat(21846))), /64/);
    assert.throws(() => policy.encodeMessage(message('ff'.repeat(65537), 'hex')), /64/);
  }
});

test('portable preferences and favorites normalize without mutation and keep exact bytes', () => {
  const input = { ...preferences(), sendMode: 'hex', lineEnding: 'crlf', favorites: [favorite] };
  for (const policy of policies) {
    const next = policy.normalizePreferences(input);
    assert.deepEqual(next, input);
    assert.notEqual(next, input);
    assert.notEqual(next.config, input.config);
    assert.notEqual(next.favorites[0], input.favorites[0]);
    assert.equal(next.favorites[0].content, '00 ff');
  }
  assert.deepEqual(frontend.normalizePreferences(input), backend.normalizePreferences(input));
});

test('portable preferences reject extra state, missing keys, unsafe objects and invalid favorites', () => {
  const invalid = [null, {}, { ...preferences(), version: 2 }, { ...preferences(), path: 'COM4' },
    { ...preferences(), sessionId: 'running' }, { ...preferences(), autoConnect: true },
    { ...preferences(), receiveMode: 'binary' }, { ...preferences(), lineEnding: 'auto' },
    { ...preferences(), favorites: [{ ...favorite, autoSend: true }] },
    { ...preferences(), favorites: [{ ...favorite, name: ' ' }] },
    { ...preferences(), favorites: [{ ...favorite, name: 'a'.repeat(81) }] },
    { ...preferences(), favorites: [{ ...favorite, id: '__proto__' }] },
    { ...preferences(), favorites: [{ ...favorite, id: '' }] },
    { ...preferences(), favorites: [{ ...favorite, content: 'f' }] },
    { ...preferences(), favorites: [{ ...favorite, content: 'A'.repeat(8193), mode: 'text' }] },
    { ...preferences(), favorites: [favorite, favorite] },
    { ...preferences(), favorites: Array.from({ length: 31 }, (_, i) => ({ ...favorite, id: `${i}` })) },
    JSON.parse('{"version":1,"__proto__":{"autoSend":true}}')];
  for (const policy of policies) for (const value of invalid) assert.throws(() => policy.normalizePreferences(value));
});

test('preference storage restores defaults without writing and explicitly saves valid values', () => {
  const saved = storage({ unrelated: 'keep' });
  assert.deepEqual(frontend.readSerialPreferences(saved), preferences());
  assert.equal(saved.getItem(frontend.SERIAL_PREFS_KEY), null);
  const input = { ...preferences(), favorites: [favorite] };
  assert.deepEqual(frontend.saveSerialPreferences(input, saved), input);
  assert.deepEqual(frontend.readSerialPreferences(saved), input);
  assert.equal(saved.getItem('unrelated'), 'keep');
});

test('corrupt, inaccessible or full preference storage is not silently overwritten', () => {
  for (const raw of ['{bad', '{}', JSON.stringify({ ...preferences(), path: 'COM4' })]) {
    const saved = storage({ [frontend.SERIAL_PREFS_KEY]: raw });
    assert.throws(() => frontend.readSerialPreferences(saved), /异常|损坏/);
    assert.throws(() => frontend.saveSerialPreferences(preferences(), saved), /异常|损坏/);
    assert.equal(saved.getItem(frontend.SERIAL_PREFS_KEY), raw);
  }
  const saved = storage({ [frontend.SERIAL_PREFS_KEY]: JSON.stringify(preferences()) });
  saved.setItem = () => { throw new Error('quota'); };
  assert.throws(() => frontend.saveSerialPreferences({ ...preferences(), sendMode: 'hex' }, saved), /quota/);
  assert.deepEqual(frontend.readSerialPreferences(saved), preferences());
  assert.throws(() => frontend.readSerialPreferences({ getItem() { throw new Error('blocked'); } }), /blocked/);
});

test('successful-send history stores only message and timestamp, newest first, and caps at 50', () => {
  const saved = storage();
  assert.deepEqual(frontend.readSerialHistory(saved), []);
  for (let i = 0; i < 55; i++) {
    frontend.appendSerialHistory({ sessionId: 'not-persisted', path: 'COM4', ...message(`${i}`) }, saved);
  }
  const history = frontend.readSerialHistory(saved);
  assert.equal(history.length, 50);
  assert.equal(history[0].content, '54');
  assert.equal(history.at(-1).content, '5');
  assert.deepEqual(Object.keys(history[0]).sort(), ['mode', 'content', 'lineEnding', 'time'].sort());
  assert.ok(Number.isSafeInteger(history[0].time));
  assert.equal(saved.getItem(frontend.SERIAL_PREFS_KEY), null);
});

test('history has a byte budget, preserves full retained messages and never silently replaces corrupt data', () => {
  const saved = storage();
  const content = 'a'.repeat(65536);
  for (let i = 0; i < 20; i++) frontend.appendSerialHistory(message(content), saved);
  const history = frontend.readSerialHistory(saved);
  assert.ok(history.length > 0 && history.length < 20);
  assert.ok(Buffer.byteLength(saved.getItem(frontend.SERIAL_HISTORY_KEY)) <= 1024 * 1024);
  assert.ok(history.every(item => item.content === content));
  for (const raw of ['{bad', '{}', '[{}]', JSON.stringify([{ ...message('A'), time: -1 }]),
    JSON.stringify([{ ...message('A'), time: 123, path: 'COM4' }])]) {
    const corrupt = storage({ [frontend.SERIAL_HISTORY_KEY]: raw });
    assert.throws(() => frontend.readSerialHistory(corrupt), /异常|损坏/);
    assert.throws(() => frontend.appendSerialHistory(message('A'), corrupt), /异常|损坏/);
    assert.equal(corrupt.getItem(frontend.SERIAL_HISTORY_KEY), raw);
  }
  const before = saved.getItem(frontend.SERIAL_HISTORY_KEY);
  saved.setItem = () => { throw new Error('quota'); };
  assert.throws(() => frontend.appendSerialHistory(message('A'), saved), /quota/);
  assert.equal(saved.getItem(frontend.SERIAL_HISTORY_KEY), before);
});
