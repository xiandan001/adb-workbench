import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { transformWithOxc } from 'vite';
import { tr, setLanguage } from '../src/shared/i18n.js';
import * as shortcuts from '../src/shared/deviceNavigationShortcuts.js';

const require = createRequire(import.meta.url), lucide = require('lucide-react');
const locales = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR'];
const element = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
const walk = (node, predicate) => !node || typeof node !== 'object' ? [] : [...(predicate(node) ? [node] : []), ...node.children.flatMap(child => walk(child, predicate))];
const text = node => node === false || node == null ? '' : typeof node === 'object' ? node.children.map(text).join('') : String(node);
const button = (tree, source) => { const found = walk(tree, node => node.type === 'button' && (text(node) === tr(source) || node.props['aria-label'] === tr(source)))[0]; assert.ok(found, source); return found; };
const config = label => { const value = shortcuts.defaultDeviceShortcuts(); value.slots[0].label = label; return value; };
const compiled = new Map();

async function compile(name) {
  if (!compiled.has(name)) {
    const source = readFileSync(new URL(`../src/components/${name}.jsx`, import.meta.url), 'utf8')
      .replace(/^import .*;\r?\n/gm, '').replace(`export default function ${name}`, `function ${name}`);
    const transformed = await transformWithOxc(`${source}\nglobalThis.component = ${name};`, `${name}.jsx`, { jsx: { runtime: 'classic' } });
    compiled.set(name, transformed.code);
  }
  return compiled.get(name);
}

function environment(initial = {}) {
  const entries = new Map(Object.entries(initial)), writes = [], listeners = new Map(), commands = [];
  const storage = {
    failSet: false, failRemove: false,
    getItem: key => entries.get(key) ?? null,
    setItem(key, value) { if (this.failSet) throw new Error('fixture quota exceeded'); entries.set(key, value); writes.push(['set', key]); },
    removeItem(key) { if (this.failRemove) throw new Error('fixture remove failed'); entries.delete(key); writes.push(['remove', key]); },
  };
  const browser = {
    electronAPI: new Proxy({}, { get() { assert.fail('No real device API access in UI scope tests'); } }),
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    dispatchEvent(event) { for (const callback of listeners.get(event.type) || []) callback(event); return true; },
  };
  const notify = () => browser.dispatchEvent({ type: shortcuts.SHORTCUTS_CHANGED });
  return { entries, writes, storage, browser, commands, notify };
}

async function harness(name, props, env = environment()) {
  const cells = [], pendingEffects = []; let cursor = 0;
  const sandbox = {
    ...shortcuts, ...lucide, tr, structuredClone, useLocale() {}, useId: () => 'scope-fixture', useMemo: callback => callback(),
    useState(initial) { const index = cursor++; if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial; return [cells[index], value => { cells[index] = typeof value === 'function' ? value(cells[index]) : value; }]; },
    useRef(initial) { const index = cursor++; if (!(index in cells)) cells[index] = { current: initial }; return cells[index]; },
    useEffect(callback, deps) {
      const index = cursor++, previous = cells[index];
      if (!previous || deps.some((item, i) => !Object.is(item, previous.deps[i]))) {
        const effect = { deps, cleanup: previous?.cleanup, callback }; cells[index] = effect; pendingEffects.push(effect);
      }
    },
    localStorage: env.storage, window: env.browser,
    React: { createElement: element, Fragment: Symbol('Fragment') }, isDarkTheme: () => false,
    createShortcutExecutor: () => async args => { env.commands.push(args); return env.executor ? env.executor(args) : { ok: true }; },
    normalizeDeviceShortcuts: value => shortcuts.normalizeDeviceShortcuts(structuredClone(value)),
    useDeviceShortcutCapabilities: () => [], DeviceShortcutEditor: () => null, DeviceShortcutConfirm: () => null, SelectMenu: () => null,
    saveDeviceShortcuts: (value, storage, notify, deviceId) => shortcuts.saveDeviceShortcuts(value, storage, notify || env.notify, deviceId),
    saveDeviceShortcutsForDevice: (value, storage, notify, deviceId) => shortcuts.saveDeviceShortcutsForDevice(value, storage, notify || env.notify, deviceId),
    restoreSharedDeviceShortcuts: (storage, notify, deviceId) => shortcuts.restoreSharedDeviceShortcuts(storage, notify || env.notify, deviceId),
  };
  runInNewContext(await compile(name), sandbox);
  return {
    props, sandbox, env,
    draw() { cursor = 0; return sandbox.component(props); },
    async effects() { for (const effect of pendingEffects.splice(0)) { effect.cleanup?.(); effect.cleanup = effect.callback(); } await Promise.resolve(); },
    unmount() { for (const cell of cells) cell?.cleanup?.(); },
  };
}

async function controls(deviceId = 'USB-A', env = environment()) {
  const toasts = [], h = await harness('DeviceNavigationControls', { deviceId, isOnline: true, theme: {}, showToast: message => toasts.push(message) }, env);
  h.toasts = toasts; h.draw(); await h.effects(); return h;
}

function open(h) {
  button(h.draw(), '编辑快捷操作').props.onClick();
  const node = walk(h.draw(), item => item.type === h.sandbox.DeviceShortcutEditor)[0]; assert.ok(node); return node;
}

async function editor(node, env) {
  return harness('DeviceShortcutEditor', { ...node.props, isOnline: false }, env);
}

const firstLabel = h => walk(h.draw(), node => node.type === 'button' && node.props.className?.includes('device-navigation-button'))[0].props['aria-label'];
const override = (deviceId, label) => ({ deviceId, config: config(label) });
const overrideRaw = (...devices) => JSON.stringify({ version: 1, devices });

test('five locales expose two explicit saves, source precedence and conditional restore without redesigning the editor', async () => {
  try {
    for (const locale of locales) {
      await setLanguage(locale);
      for (const source of ['device', 'shared', 'default']) {
        const initial = source === 'device' ? { [shortcuts.DEVICE_SHORTCUTS_KEY]: overrideRaw(override('USB-A', 'Independent')) }
          : source === 'shared' ? { [shortcuts.SHORTCUTS_KEY]: JSON.stringify(config('Shared')) } : {};
        const h = await controls('USB-A', environment(initial)), node = open(h), e = await editor(node, h.env), tree = e.draw();
        const primary = button(tree, '保存到当前设备'), shared = button(tree, '保存为共用配置');
        assert.match(primary.props.className, /bg-emerald-600/); assert.doesNotMatch(shared.props.className, /bg-emerald-600/);
        assert.equal(primary.props.disabled, false); assert.equal(shared.props.disabled, false);
        assert.equal(walk(tree, item => item.type === 'button' && text(item) === tr('恢复共用配置')).length, source === 'device' ? 1 : 0);
        const sourceText = { device: '当前使用设备独立配置，优先于同平台共用配置。', shared: '当前使用同平台共用配置。', default: '当前使用出厂默认配置。' }[source];
        assert.ok(text(tree).includes(tr(sourceText)));
        const badges = walk(h.draw(), item => item.props.title === tr(sourceText));
        assert.equal(badges.length, source === 'device' ? 1 : 0);
        if (source === 'device') assert.equal(text(badges[0]), tr('独立配置'));
        assert.ok(text(tree).includes(tr('共用配置仅适用于同平台设备；保存不会执行操作。')));
        assert.ok(text(tree).includes('USB-A')); assert.ok(walk(tree, item => item.props.className?.includes('flex-wrap')).length);
        if (locale !== 'zh-CN') for (const key of ['保存到当前设备', '保存为共用配置', sourceText]) assert.notEqual(tr(key), key);
        assert.deepEqual(h.env.commands, []); assert.deepEqual(h.env.writes, []); h.unmount();
      }
    }
  } finally { await setLanguage('zh-CN'); }
});

test('current-device save isolates exact identities and shared save refreshes inheritors but preserves every override', async () => {
  const env = environment(), a = await controls('USB-A', env), b = await controls('10.0.0.2:5555', env), harmony = await controls('hdc:USB-A', env);
  open(a).props.onSave(config('Only A'));
  assert.equal(firstLabel(a), 'Only A'); assert.equal(firstLabel(b), tr('回到桌面')); assert.equal(firstLabel(harmony), tr('回到桌面'));
  assert.equal(env.storage.getItem(shortcuts.SHORTCUTS_KEY), null); assert.equal(env.storage.getItem(shortcuts.HARMONY_SHORTCUTS_KEY), null);
  open(b).props.onSaveShared(config('Shared B'));
  assert.equal(firstLabel(a), 'Only A'); assert.equal(firstLabel(b), 'Shared B'); assert.equal(firstLabel(harmony), tr('回到桌面'));
  const raw = env.storage.getItem(shortcuts.DEVICE_SHORTCUTS_KEY);
  open(a).props.onSaveShared(config('Shared A'));
  assert.equal(env.storage.getItem(shortcuts.DEVICE_SHORTCUTS_KEY), raw);
  assert.equal(firstLabel(a), 'Only A'); assert.equal(firstLabel(b), 'Shared A');
  assert.equal(a.toasts.at(-1), tr('已保存共用配置，当前设备仍使用独立配置'));
  assert.equal(open(a).props.hasOverride, true); assert.deepEqual(env.commands, []);
  a.unmount(); b.unmount(); harmony.unmount();
});

test('reused card identity immediately reads its own config and never displays or saves the previous editor draft', async () => {
  const env = environment({ [shortcuts.DEVICE_SHORTCUTS_KEY]: overrideRaw(override('USB-A', 'Only A'), override('USB-B', 'Only B')) });
  const h = await controls('USB-A', env); open(h);
  h.props.deviceId = 'USB-B';
  assert.equal(firstLabel(h), 'Only B');
  assert.equal(walk(h.draw(), node => node.type === h.sandbox.DeviceShortcutEditor).length, 0);
  const node = open(h); assert.equal(node.props.key, 'USB-B'); assert.equal(node.props.config.slots[0].label, 'Only B');
  node.props.onSave(config('New B'));
  assert.equal(shortcuts.readDeviceShortcuts(env.storage, 'USB-A').config.slots[0].label, 'Only A');
  assert.equal(firstLabel(h), 'New B'); await h.effects(); h.unmount();
});

test('storage override changes, shared changes and same-window notifications refresh without writing on read', async () => {
  const env = environment(), h = await controls('USB-A', env);
  env.entries.set(shortcuts.DEVICE_SHORTCUTS_KEY, overrideRaw(override('USB-A', 'Remote A')));
  env.browser.dispatchEvent({ type: 'storage', key: 'unrelated' }); assert.equal(firstLabel(h), tr('回到桌面'));
  env.browser.dispatchEvent({ type: 'storage', key: shortcuts.DEVICE_SHORTCUTS_KEY }); assert.equal(firstLabel(h), 'Remote A');
  env.entries.delete(shortcuts.DEVICE_SHORTCUTS_KEY); env.entries.set(shortcuts.SHORTCUTS_KEY, JSON.stringify(config('New shared')));
  env.browser.dispatchEvent({ type: 'storage', key: shortcuts.SHORTCUTS_KEY }); assert.equal(firstLabel(h), 'New shared');
  env.entries.set(shortcuts.DEVICE_SHORTCUTS_KEY, overrideRaw(override('USB-A', 'Imported A'))); env.notify(); assert.equal(firstLabel(h), 'Imported A');
  env.entries.delete(shortcuts.DEVICE_SHORTCUTS_KEY); env.browser.dispatchEvent({ type: 'storage', key: null }); assert.equal(firstLabel(h), 'New shared');
  assert.deepEqual(env.writes, []); assert.deepEqual(env.commands, []); h.unmount();
});

test('invalid override map has no destructive card reset; shared recovery writes only the current platform shared key', async () => {
  const broken = environment({ [shortcuts.DEVICE_SHORTCUTS_KEY]: '{broken' }), h = await controls('USB-A', broken), tree = h.draw();
  assert.equal(walk(tree, node => node.type === 'button' && text(node) === tr('重置当前平台共用配置')).length, 0);
  assert.equal(button(tree, '编辑快捷操作').props.disabled, true); assert.deepEqual(broken.writes, []); assert.equal(broken.storage.getItem(shortcuts.DEVICE_SHORTCUTS_KEY), '{broken');
  h.unmount();
  const initial = overrideRaw(override('USB-other', 'Other device'));
  const env = environment({ [shortcuts.DEVICE_SHORTCUTS_KEY]: initial, [shortcuts.HARMONY_SHORTCUTS_KEY]: '{broken', [shortcuts.SHORTCUTS_KEY]: JSON.stringify(config('Android shared')) });
  const harmony = await controls('hdc:USB-A', env);
  button(harmony.draw(), '重置当前平台共用配置').props.onClick();
  assert.deepEqual(env.writes, [['set', shortcuts.HARMONY_SHORTCUTS_KEY]]);
  assert.equal(env.storage.getItem(shortcuts.DEVICE_SHORTCUTS_KEY), initial);
  assert.equal(JSON.parse(env.storage.getItem(shortcuts.SHORTCUTS_KEY)).slots[0].label, 'Android shared');
  assert.deepEqual(env.commands, []); harmony.unmount();
});

test('failed current/shared saves and failed restore retain the editor draft and do not announce success', async () => {
  for (const target of ['保存到当前设备', '保存为共用配置', '恢复共用配置']) {
    const env = environment({ [shortcuts.DEVICE_SHORTCUTS_KEY]: overrideRaw(override('USB-A', 'Saved A')) }), h = await controls('USB-A', env), e = await editor(open(h), env);
    const input = walk(e.draw(), node => node.type === 'input' && node.props.maxLength === 16)[0];
    input.props.onChange({ target: { value: 'Unsaved draft' } });
    if (target === '恢复共用配置') env.storage.failRemove = true; else env.storage.failSet = true;
    button(e.draw(), target).props.onClick();
    assert.ok(text(e.draw()).includes(target === '恢复共用配置' ? 'fixture remove' : 'fixture quota exceeded'), `${target}: ${text(e.draw())}`);
    assert.equal(walk(e.draw(), node => node.type === 'input' && node.props.maxLength === 16)[0].props.value, 'Unsaved draft');
    assert.equal(walk(h.draw(), node => node.type === h.sandbox.DeviceShortcutEditor).length, 1);
    assert.equal(firstLabel(h), 'Saved A'); assert.deepEqual(h.toasts, []); assert.deepEqual(env.writes, []); h.unmount();
  }
});

test('both rendered save buttons submit the edited draft to their explicit scope in all five locales', async () => {
  try {
    for (const locale of locales) {
      await setLanguage(locale);
      for (const target of ['保存到当前设备', '保存为共用配置']) {
        const env = environment(), h = await controls('USB-A', env), e = await editor(open(h), env);
        walk(e.draw(), node => node.type === 'input' && node.props.maxLength === 16)[0].props.onChange({ target: { value: 'New draft' } });
        button(e.draw(), target).props.onClick();
        assert.equal(firstLabel(h), 'New draft');
        assert.equal(walk(h.draw(), node => node.type === h.sandbox.DeviceShortcutEditor).length, 0);
        assert.deepEqual(env.writes.map(item => item[1]), [target === '保存到当前设备' ? shortcuts.DEVICE_SHORTCUTS_KEY : shortcuts.SHORTCUTS_KEY]);
        assert.equal(h.toasts.length, 1); assert.deepEqual(env.commands, []); h.unmount();
      }
    }
  } finally { await setLanguage('zh-CN'); }
});

test('reusing a device card cancels an old shell confirmation before any command reaches a different identity', async () => {
  const value = config('Custom shell'); value.slots[0] = { id: 'slot-1', type: 'shell', label: 'Custom shell', command: 'input keyevent KEYCODE_BACK' };
  const env = environment({ [shortcuts.DEVICE_SHORTCUTS_KEY]: JSON.stringify({ version: 1, devices: [{ deviceId: 'USB-A', config: value }] }) });
  env.executor = shortcuts.createShortcutExecutor();
  const h = await controls('USB-A', env);
  const pending = walk(h.draw(), node => node.type === 'button' && node.props['aria-label'] === 'Custom shell')[0].props.onClick();
  assert.equal(walk(h.draw(), node => node.type === h.sandbox.DeviceShortcutConfirm).length, 1);
  h.props.deviceId = 'USB-B';
  assert.equal(walk(h.draw(), node => node.type === h.sandbox.DeviceShortcutConfirm).length, 0);
  await h.effects(); await pending;
  assert.equal(env.commands.length, 1); assert.equal(env.commands[0].deviceId, 'USB-A');
  assert.deepEqual(h.toasts, []); assert.equal(firstLabel(h), tr('回到桌面')); h.unmount();
});

test('restore default changes the draft only; restoring shared removes current only and exposes inherited corruption honestly', async () => {
  const original = overrideRaw(override('USB-A', 'Saved A'), override('USB-B', 'Saved B'));
  const env = environment({ [shortcuts.DEVICE_SHORTCUTS_KEY]: original, [shortcuts.SHORTCUTS_KEY]: JSON.stringify(config('Shared')) }), h = await controls('USB-A', env), e = await editor(open(h), env);
  button(e.draw(), '恢复默认').props.onClick(); assert.equal(env.storage.getItem(shortcuts.DEVICE_SHORTCUTS_KEY), original); assert.deepEqual(env.writes, []);
  assert.equal(walk(e.draw(), node => node.type === 'input' && node.props.maxLength === 16)[0].props.value, '回到桌面');
  button(e.draw(), '取消').props.onClick(); assert.equal(firstLabel(h), 'Saved A');
  open(h).props.onRestoreShared(); assert.equal(firstLabel(h), 'Shared'); assert.equal(shortcuts.readDeviceShortcuts(env.storage, 'USB-B').config.slots[0].label, 'Saved B');
  assert.equal(h.toasts.at(-1), tr('已恢复当前设备的共用配置'));
  h.unmount();
  const corrupt = environment({ [shortcuts.DEVICE_SHORTCUTS_KEY]: overrideRaw(override('USB-A', 'Still valid')), [shortcuts.SHORTCUTS_KEY]: '{broken' });
  const c = await controls('USB-A', corrupt); assert.equal(firstLabel(c), 'Still valid'); open(c).props.onRestoreShared();
  assert.equal(corrupt.storage.getItem(shortcuts.DEVICE_SHORTCUTS_KEY), null);
  assert.equal(walk(c.draw(), node => node.type === c.sandbox.DeviceShortcutEditor).length, 0);
  assert.ok(walk(c.draw(), node => node.props.role === 'alert').length); assert.deepEqual(c.toasts, []); assert.deepEqual(corrupt.commands, []); c.unmount();
});

test('installed-app loading retries inline and preserves the shortcut draft, selected slot and application query', async () => {
  const env = environment(); let calls = 0;
  env.browser.electronAPI = { packageList: async ({ deviceId }) => {
    assert.equal(deviceId, 'USB-A'); calls++;
    return calls === 1 ? { ok: false, error: 'fixture app list unavailable' }
      : { ok: true, packages: [{ packageName: 'fixture.camera', label: 'Camera fixture' }] };
  } };
  const h = await controls('USB-A', env), e = await harness('DeviceShortcutEditor', { ...open(h).props, isOnline: true }, env);
  let tree = e.draw(); walk(tree, node => node.type === 'dialog')[0].props.ref.current = { showModal() {}, close() {} };
  walk(tree, node => node.type === e.sandbox.SelectMenu && node.props.id.endsWith('-type'))[0].props.onChange('app');
  tree = e.draw();
  walk(tree, node => node.type === 'input' && node.props.maxLength === 16)[0].props.onChange({ target: { value: 'Keep app draft' } });
  walk(tree, node => node.type === 'input' && node.props.placeholder === tr('输入应用名称或包名'))[0].props.onChange({ target: { value: 'Camera' } });
  await e.effects(); for (let index = 0; index < 5; index++) await Promise.resolve();
  tree = e.draw(); assert.match(text(tree), /fixture app list unavailable/); assert.equal(calls, 1);
  const retry = button(tree, '重试读取应用'); assert.equal(retry.props.disabled, false); retry.props.onClick();
  e.draw(); await e.effects(); for (let index = 0; index < 5; index++) await Promise.resolve();
  tree = e.draw(); assert.equal(calls, 2); assert.doesNotMatch(text(tree), /fixture app list unavailable/);
  assert.equal(walk(tree, node => node.type === 'input' && node.props.maxLength === 16)[0].props.value, 'Keep app draft');
  assert.equal(walk(tree, node => node.type === 'input' && node.props.placeholder === tr('输入应用名称或包名'))[0].props.value, 'Camera');
  assert.equal(walk(tree, node => node.type === e.sandbox.SelectMenu && node.props.id.endsWith('-app'))[0].props.options[0].value, 'fixture.camera');
  assert.equal(walk(tree, node => node.type === 'button' && node.props['aria-pressed'] === true).length, 1);
  assert.deepEqual(env.writes, []); assert.deepEqual(env.commands, []); e.unmount(); h.unmount();
});
