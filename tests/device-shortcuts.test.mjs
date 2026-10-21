import test from 'node:test';
import assert from 'node:assert/strict';
import { addRecentApk, filterPackages, readFavoritePackages, readRecentApks, RECENT_APKS_KEY, FAVORITE_PACKAGES_KEY, saveShortcutList } from '../src/shared/deviceShortcuts.js';
import { connectWirelessDevice, historyConnectionAddress } from '../src/shared/wirelessConnection.js';

const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
};

test('recent APKs keep five most recent unique Windows paths without installing', () => {
  let paths = [];
  for (let index = 0; index < 7; index++) paths = addRecentApk(paths, `C:\\apks\\${index}.apk`);
  assert.equal(paths.length, 5);
  paths = addRecentApk(paths, 'c:/apks/4.APK');
  assert.equal(paths.length, 5);
  assert.equal(paths[0], 'c:/apks/4.APK');
  assert.equal(paths.filter(item => /4\.apk$/i.test(item)).length, 1);
  assert.deepEqual(addRecentApk(paths, 'C:/other.zip'), paths);
  const saved = storage();
  assert.equal(saveShortcutList(RECENT_APKS_KEY, paths, saved), true);
  assert.deepEqual(readRecentApks(saved), paths);
});

test('invalid local shortcut data is ignored and persistence failure is visible to caller', () => {
  assert.deepEqual(readRecentApks({ getItem: () => '{bad' }), []);
  assert.deepEqual(readFavoritePackages({ getItem: () => '{"not":"an array"}' }), []);
  assert.deepEqual(readRecentApks({ getItem: () => '[null, 2, "C:/app.apk", "x.txt"]' }), ['C:/app.apk']);
  assert.equal(saveShortcutList(RECENT_APKS_KEY, [], { setItem() { throw new Error('quota'); } }), false);
});

test('favorite apps are persisted, prioritized and searchable, including system favorites', () => {
  const saved = storage();
  saveShortcutList(FAVORITE_PACKAGES_KEY, ['app.second', 'android'], saved);
  const favorites = readFavoritePackages(saved);
  const packages = [
    { packageName: 'app.first', apkName: 'first.apk' },
    { packageName: 'app.second', apkName: 'second.apk' },
    { packageName: 'android', system: true }
  ];
  assert.deepEqual(filterPackages(packages, { favorites }).map(item => item.packageName), ['app.second', 'app.first']);
  assert.deepEqual(filterPackages(packages, { favorites, onlyFavorites: true }).map(item => item.packageName), ['app.second', 'android']);
  assert.deepEqual(filterPackages(packages, { favorites, onlyFavorites: true, query: 'ANDROID' }).map(item => item.packageName), ['android']);
  assert.equal(packages[0].packageName, 'app.first');
});

test('history reconnect uses Wi-Fi addresses and never treats USB serials as addresses', () => {
  assert.equal(historyConnectionAddress({ type: 'usb', deviceId: 'ABC123' }), '');
  assert.equal(historyConnectionAddress({ type: 'wifi', deviceId: '192.168.1.1:5555' }), '192.168.1.1:5555');
});

test('history reconnect connects immediately, preserves name and refreshes history', async () => {
  const calls = [];
  const result = await connectWirelessDevice(' 192.168.1.1:5555 ', {
    api: {
      adbConnect: async address => { calls.push(address); return { success: true }; },
      saveConnectionHistory: async entry => { calls.push(entry); return { success: true }; },
      loadConnectionHistory: async () => ({ success: true, data: [{ id: 'new-id' }] })
    },
    refreshDevices: async () => { calls.push('refresh'); },
    historyEntry: { deviceName: '教室屏' }
  });
  assert.equal(result.success, true);
  assert.equal(calls[0], '192.168.1.1:5555');
  assert.equal(calls[1], 'refresh');
  assert.equal(calls[2].deviceName, '教室屏');
  assert.deepEqual(result.history, [{ id: 'new-id' }]);
});

test('connection failure does not save history and a failed history save does not undo connection success', async () => {
  let saved = false;
  const failure = await connectWirelessDevice('host:5555', {
    api: { adbConnect: async () => ({ success: false, error: 'refused' }), saveConnectionHistory: async () => { saved = true; } },
    refreshDevices: async () => {}
  });
  assert.equal(failure.success, false);
  assert.equal(failure.message, 'refused');
  assert.equal(saved, false);
  const connected = await connectWirelessDevice('host:5555', {
    api: { adbConnect: async () => ({ success: true }), saveConnectionHistory: async () => ({ success: false }) },
    refreshDevices: async () => {}
  });
  assert.equal(connected.success, true);
  assert.match(connected.message, /连接历史未保存/);
});
