import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PINNED_DEVICES_KEY, filterDeviceCards, normalizePinnedDevices, readPinnedDevices, togglePinnedDevice
} from '../src/shared/deviceDiscovery.js';

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

const devices = Object.freeze([
  Object.freeze({ id: 'USB-AbC', model: 'Clevertouch_Unify', status: 'device' }),
  Object.freeze({ id: '192.168.1.50:5555', model: 'Android', status: 'device' }),
  Object.freeze({ id: '设备-三', model: 'Panel', status: 'offline' }),
  Object.freeze({ id: 'USB-D', model: 'Panel', ip: '10.0.0.8', status: 'device' })
]);
const names = { 'USB-AbC': '一年级教室', '设备-三': '会议室' };

test('device search matches aliases, models, IDs and known IPs case-insensitively', () => {
  for (const [query, expected] of [[' 一年级 ', 'USB-AbC'], ['unify', 'USB-AbC'], ['usb-abc', 'USB-AbC'],
    ['192.168.1.50', '192.168.1.50:5555'], ['设备-三', '设备-三'], ['会议', '设备-三'], ['10.0.0.8', 'USB-D']]) {
    assert.deepEqual(filterDeviceCards(devices, { query, names }).map(item => item.id), [expected]);
  }
  assert.deepEqual(filterDeviceCards(devices, { query: 'missing', names }), []);
});

test('pins are first while original relative order and device objects remain unchanged', () => {
  const pinnedIds = Object.freeze(['USB-D', '192.168.1.50:5555', 'disconnected']);
  const result = filterDeviceCards(devices, { names, pinnedIds });
  assert.deepEqual(result.map(item => item.id), ['192.168.1.50:5555', 'USB-D', 'USB-AbC', '设备-三']);
  assert.equal(result[0], devices[1]);
  assert.deepEqual(devices.map(item => item.id), ['USB-AbC', '192.168.1.50:5555', '设备-三', 'USB-D']);
  assert.deepEqual(pinnedIds, ['USB-D', '192.168.1.50:5555', 'disconnected']);
});

test('filtering the existing free subset cannot reveal locked devices or select another device', () => {
  const saved = storage({ activeDeviceId: 'USB-AbC' });
  const eligible = devices.slice(0, 1);
  assert.deepEqual(filterDeviceCards(eligible, { query: '192.168', pinnedIds: [devices[1].id] }), []);
  assert.deepEqual(filterDeviceCards(eligible, { pinnedIds: [devices[1].id] }).map(item => item.id), ['USB-AbC']);
  assert.equal(saved.getItem('activeDeviceId'), 'USB-AbC');
});

test('pin toggle persists IDs, retains disconnected pins and never writes active selection', () => {
  const saved = storage({ [PINNED_DEVICES_KEY]: '["disconnected"]', activeDeviceId: 'USB-AbC' });
  assert.deepEqual(togglePinnedDevice('设备-三', saved), ['disconnected', '设备-三']);
  assert.deepEqual(readPinnedDevices(saved), ['disconnected', '设备-三']);
  assert.deepEqual(togglePinnedDevice('设备-三', saved), ['disconnected']);
  assert.equal(saved.getItem('activeDeviceId'), 'USB-AbC');
  assert.equal(filterDeviceCards([{ id: 'fresh' }, { id: 'disconnected' }], { pinnedIds: readPinnedDevices(saved) })[0].id, 'disconnected');
});

test('invalid storage safely reads empty but explicit writes do not destroy corrupt originals', () => {
  for (const raw of ['{bad', '{}', '[42]', '[""]', '["a\\u0000b"]']) {
    const saved = storage({ [PINNED_DEVICES_KEY]: raw });
    assert.deepEqual(readPinnedDevices(saved), []);
    assert.throws(() => togglePinnedDevice('USB-AbC', saved));
    assert.equal(saved.getItem(PINNED_DEVICES_KEY), raw);
  }
  assert.deepEqual(readPinnedDevices({ getItem() { throw new Error('blocked'); } }), []);
  const saved = storage({ [PINNED_DEVICES_KEY]: '["old"]' });
  saved.setItem = () => { throw new Error('quota'); };
  assert.throws(() => togglePinnedDevice('new', saved), /quota/);
  assert.deepEqual(readPinnedDevices(saved), ['old']);
});

test('pin IDs are bounded, validated and deduplicated without changing identity', () => {
  assert.deepEqual(normalizePinnedDevices(['设备-三', '192.168.1.2:5555', '设备-三']), ['设备-三', '192.168.1.2:5555']);
  for (const value of [{}, [null], [' '], ['x'.repeat(301)], Array.from({ length: 1001 }, (_, i) => String(i))]) {
    assert.throws(() => normalizePinnedDevices(value));
  }
});
