import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import { tr, setLanguage } from '../src/shared/i18n.js';
import * as shortcuts from '../src/shared/deviceNavigationShortcuts.js';

const require = createRequire(import.meta.url), lucide = require('lucide-react');
const locales = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR'];
const reason = '设备需支持音量组合键解锁；点击仅发送按键，请确认触摸是否恢复。';
const sent = '已发送童锁解锁按键，请确认触摸是否恢复。';
const element = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
const walk = (node, predicate) => !node || typeof node !== 'object' ? [] : [...(predicate(node) ? [node] : []), ...node.children.flatMap(child => walk(child, predicate))];
const text = node => node === false || node == null ? '' : typeof node === 'object' ? node.children.map(text).join('') : String(node);
const cssClass = (node, name) => String(node.props.className || '').split(/\s+/).includes(name);
const builtin = (action, index) => ({ id: `slot-${index + 1}`, type: 'builtin', action, label: shortcuts.BUILTIN_SHORTCUTS.find(item => item.id === action)?.label || action });
const choices = () => ({ version: 1, slots: ['childLockUnlock', 'volumeUp', 'volumeDown', 'whiteboard'].map(builtin) });
const compiled = new Map();

async function compile(name) {
  if (!compiled.has(name)) {
    const source = readFileSync(new URL(`../src/components/${name}.jsx`, import.meta.url), 'utf8')
      .replace(/^import .*;\r?\n/gm, '').replace(`export default function ${name}`, `function ${name}`);
    const result = await transformWithOxc(`${source}\nglobalThis.component = ${name};`, `${name}.jsx`, { jsx: { runtime: 'classic' } });
    compiled.set(name, result.code);
  }
  return compiled.get(name);
}

async function fixture(name = 'DeviceNavigationControls', { config, isOnline = true, execute = async () => ({ ok: true }) } = {}) {
  const cells = [], calls = [], toasts = []; let cursor = 0;
  const storage = { getItem: key => key === shortcuts.SHORTCUTS_KEY && config ? JSON.stringify(config) : null, setItem: () => assert.fail('Rendering must not rewrite shortcuts') };
  const sandbox = { ...shortcuts, ...lucide, tr, structuredClone, useLocale() {}, useEffect() {}, useId: () => 'fixture', useMemo: callback => callback(),
    useState(initial) { const index = cursor++; if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial; return [cells[index], value => { cells[index] = typeof value === 'function' ? value(cells[index]) : value; }]; },
    useRef(initial) { const index = cursor++; if (!(index in cells)) cells[index] = { current: initial }; return cells[index]; },
    localStorage: storage, window: { electronAPI: new Proxy({}, { get() { assert.fail('No device API access in renderer fixture'); } }) },
    React: { createElement: element, Fragment: Symbol('Fragment') }, isDarkTheme: () => false,
    createShortcutExecutor: () => async args => { calls.push(args); return execute(args); },
    useDeviceShortcutCapabilities: (_deviceId, _isOnline, value) => value.slots.filter(item => item.action === 'childLockUnlock').map(item => ({ id: item.id, status: 'unknown', reason })),
    DeviceShortcutEditor: () => null, DeviceShortcutConfirm: () => null, SelectMenu: () => null };
  runInNewContext(await compile(name), sandbox);
  const props = { deviceId: 'selected-card-B', isOnline, theme: {}, showToast: value => toasts.push(value),
    config: config || shortcuts.defaultDeviceShortcuts(), isDark: false, pending: '', onTest() {}, onSave() {}, onClose() {} };
  return { calls, toasts, sandbox, props, draw() { cursor = 0; return sandbox.component(props); } };
}

const buttons = tree => walk(tree, node => node.type === 'button' && cssClass(node, 'device-navigation-button'));
const buttonFor = (tree, label) => { const found = buttons(tree).find(node => node.props['aria-label'] === label); assert.ok(found, `Missing button: ${label}`); return found; };

test('five locales render the new Android factory child-lock button with an unknown-support hint and Unlock icon', async () => {
  try {
    for (const locale of locales) {
      await setLanguage(locale);
      const h = await fixture(), tree = h.draw(), rendered = buttons(tree);
      assert.deepEqual(rendered.map(node => node.props['aria-label']), ['回到桌面', '打开侧边栏', '打开系统设置', '童锁解锁'].map(label => tr(label)));
      const child = buttonFor(tree, tr('童锁解锁'));
      assert.equal(child.props.disabled, false);
      assert.ok(walk(child, node => node.type === lucide.Unlock).length);
      assert.ok(walk(child, node => node.type === lucide.CircleHelp).length);
      assert.ok(text(tree).includes(tr(reason)));
      assert.equal(rendered.some(node => node.props['aria-label'] === tr('打开白板')), false);
      if (locale !== 'zh-CN') { assert.notEqual(tr('童锁解锁'), '童锁解锁'); assert.notEqual(tr(reason), reason); assert.notEqual(tr(sent), sent); }
      assert.deepEqual(h.calls, []);
    }
  } finally { await setLanguage('zh-CN'); }
});

test('saved child-lock, volume and whiteboard choices retain their distinct available SVGs and labels', async () => {
  const h = await fixture('DeviceNavigationControls', { config: choices() }), tree = h.draw();
  const expected = [['童锁解锁', 'Unlock', 'lock-open'], ['音量+', 'Volume2', 'volume-2'], ['音量-', 'Volume1', 'volume-1'], ['打开白板', 'Presentation', 'presentation']];
  assert.equal(buttons(tree).length, 4);
  for (const [label, name, className] of expected) {
    const icon = walk(buttonFor(tree, tr(label)), node => node.type === lucide[name])[0];
    assert.ok(icon, name);
    const svg = renderToStaticMarkup(createElement(icon.type, icon.props));
    assert.match(svg, /^<svg\b/); assert.match(svg, /width="19"/); assert.match(svg, /height="19"/);
    assert.ok(svg.includes(`lucide-${className}`));
  }
  assert.deepEqual(h.calls, []);
});

test('five-language editor System Operations offers child-lock, both volume keys and retained whiteboard without executing them', async () => {
  try {
    for (const locale of locales) {
      await setLanguage(locale);
      const h = await fixture('DeviceShortcutEditor', { config: choices() }), tree = h.draw();
      const menu = walk(tree, node => node.type === h.sandbox.SelectMenu && node.props.id.endsWith('-action'))[0];
      assert.ok(menu); assert.equal(menu.props.disabled, false);
      for (const label of ['童锁解锁', '音量+', '音量-', '打开白板']) {
        const source = shortcuts.BUILTIN_SHORTCUTS.find(item => item.label === label);
        assert.ok(source, label);
        assert.ok(menu.props.options.some(option => option.value === source.id && option.label === tr(label)));
      }
      assert.ok(text(tree).includes(tr('系统操作')));
      assert.ok(text(tree).includes(tr('童锁解锁')));
      assert.deepEqual(h.calls, []);
    }
  } finally { await setLanguage('zh-CN'); }
});

test('successful child-lock dispatch uses honest localized key-sent feedback in all five locales', async () => {
  try {
    for (const locale of locales) {
      await setLanguage(locale);
      const h = await fixture('DeviceNavigationControls', { config: choices() });
      await buttonFor(h.draw(), tr('童锁解锁')).props.onClick();
      assert.deepEqual(h.toasts, [tr(sent)]);
      assert.equal(h.calls.length, 1); assert.equal(h.calls[0].deviceId, 'selected-card-B');
      assert.equal(h.calls[0].shortcut.action, 'childLockUnlock');
      assert.equal(buttonFor(h.draw(), tr('童锁解锁')).props['aria-busy'], false);
    }
  } finally { await setLanguage('zh-CN'); }
});

test('other built-ins retain generic sent-command feedback and customized labels stay verbatim', async () => {
  const config = choices(); config.slots[1].label = 'My volume +';
  const h = await fixture('DeviceNavigationControls', { config });
  await buttonFor(h.draw(), 'My volume +').props.onClick();
  await buttonFor(h.draw(), tr('打开白板')).props.onClick();
  assert.deepEqual(h.toasts, ['My volume +', tr('打开白板')].map(label => tr('已发送{0}指令（{1}）', { 0: label, 1: h.props.deviceId })));
});

test('failed, cancelled, skipped or local results never claim child-lock keys were sent', async () => {
  for (const result of [{ ok: false }, { cancelled: true }, { skipped: true }, { ok: true, local: true }]) {
    const h = await fixture('DeviceNavigationControls', { config: choices(), execute: async () => result });
    await buttonFor(h.draw(), tr('童锁解锁')).props.onClick();
    assert.deepEqual(h.toasts, []);
  }
  const failed = await fixture('DeviceNavigationControls', { config: choices(), execute: async () => { throw new Error('fixture failure'); } });
  await buttonFor(failed.draw(), tr('童锁解锁')).props.onClick();
  assert.deepEqual(failed.toasts, [tr('{0}失败：{1}', { 0: tr('童锁解锁'), 1: 'fixture failure' })]);
  assert.ok(text(failed.draw()).includes('fixture failure'));
  assert.equal(buttonFor(failed.draw(), tr('童锁解锁')).props.disabled, false);
});

test('offline and same-turn repeated clicks do not dispatch, and pending buttons retain existing busy guards', async () => {
  const offline = await fixture('DeviceNavigationControls', { config: choices(), isOnline: false });
  const blocked = buttonFor(offline.draw(), tr('童锁解锁'));
  assert.equal(blocked.props.disabled, true); await blocked.props.onClick(); assert.deepEqual(offline.calls, []);
  let release;
  const h = await fixture('DeviceNavigationControls', { config: choices(), execute: () => new Promise(resolve => { release = resolve; }) });
  const button = buttonFor(h.draw(), tr('童锁解锁')), pending = button.props.onClick();
  await button.props.onClick(); assert.equal(h.calls.length, 1); assert.deepEqual(h.toasts, []);
  const busy = buttons(h.draw()); assert.ok(busy.every(node => node.props.disabled)); assert.equal(busy[0].props['aria-busy'], true);
  release({ ok: true }); await pending;
  assert.deepEqual(h.toasts, [tr(sent)]); assert.ok(buttons(h.draw()).every(node => !node.props.disabled));
});
