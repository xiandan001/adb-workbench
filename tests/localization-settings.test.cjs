const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function harness(t, io = fs) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-language-'));
  t.after(() => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }); });
  const file = path.resolve(__dirname, '../electron/lib/settings.cjs'); const load = () => {
    const module = { exports: {} }; const requireFromFile = createRequire(file);
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, console: { error() {} }, require(name) {
      if (name === 'electron') return { app: { getPath: () => directory } };
      if (name === 'fs') return io;
      return requireFromFile(name);
    } }, { filename: file });
    return module.exports;
  };
  return { directory, load };
}

test('durable language updates share the settings queue and retain unrelated settings after restart', async t => {
  const h = harness(t); const file = path.join(h.directory, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ screenshotPath: 'fixture-output', externalSetting: '用户数据' }));
  const settings = h.load();
  await Promise.all([settings.writeSettingsPatch({ locale: 'en-US' }), settings.writeSettingsPatch({ pushRemotePathHistory: ['/sdcard/测试'] })]);
  const restored = await h.load().readSettings();
  assert.equal(restored.locale, 'en-US'); assert.equal(restored.screenshotPath, 'fixture-output'); assert.equal(restored.externalSetting, '用户数据');
  assert.deepEqual(Array.from(restored.pushRemotePathHistory), ['/sdcard/测试']);
  assert.deepEqual(fs.readdirSync(h.directory), ['settings.json']);
  await assert.rejects(settings.writeSettingsPatch({ locale: 'fr' }));
  assert.equal((await h.load().readSettings()).locale, 'en-US');
});

test('failed atomic replace leaves the previous complete settings file and cleans only its owned temporary', async t => {
  const io = { ...fs, promises: { ...fs.promises, rename: async () => { throw new Error('fixture rename denied'); } } };
  const h = harness(t, io); const file = path.join(h.directory, 'settings.json');
  const before = '{"locale":"zh-CN","other":"原始值"}\n'; fs.writeFileSync(file, before);
  await assert.rejects(h.load().writeSettingsPatch({ locale: 'en-US' }), /fixture rename denied/);
  assert.equal(fs.readFileSync(file, 'utf8'), before); assert.deepEqual(fs.readdirSync(h.directory), ['settings.json']);
});

test('generic settings IPC cannot bypass authoritative language persistence and broadcast', async t => {
  const h = harness(t); const settings = h.load(); const handlers = new Map();
  settings.register({ handle: (name, handler) => handlers.set(name, handler) });
  assert.equal((await handlers.get('settings:savePatch')({}, { locale: 'en-US' })).success, false);
  assert.equal(fs.existsSync(path.join(h.directory, 'settings.json')), false);
});
