import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { tr } from '../src/shared/i18n.js';
import { defaultDeviceShortcuts, normalizeDeviceShortcuts } from '../src/shared/deviceNavigationShortcuts.js';

const require = createRequire(import.meta.url);
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const backendShortcuts = require('../electron/lib/device-shortcuts-policy.cjs');
function source(name) {
  const text = fs.readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
  return { text, ast: parser.parse(text, { sourceType: 'module', plugins: ['jsx'] }) };
}
function initializer(file, name) {
  let node;
  traverse(file.ast, { VariableDeclarator({ node: item }) { if (item.id.name === name) node = item.init; } });
  assert.ok(node, name); return file.text.slice(node.start, node.end);
}
const card = source('components/DeviceCard.jsx');
function commonButtons() {
  let grid;
  traverse(card.ast, { JSXElement({ node }) {
    if (node.openingElement.attributes.some(attr => attr.name?.name === 'className' && attr.value?.value === 'device-tool-grid')) grid = node;
  } });
  assert.ok(grid);
  const buttons = [];
  traverse(card.ast, { JSXOpeningElement({ node }) {
    if (node.start > grid.start && node.end < grid.end && node.name.name === 'ControlButton') buttons.push(node);
  } });
  return buttons;
}
const attribute = (button, key) => button.attributes.find(item => item.name?.name === key)?.value?.expression;
const code = node => card.text.slice(node.start, node.end);
const logsButton = () => commonButtons().find(button => attribute(button, 'label') && code(attribute(button, 'label')).includes('设备日志'));

test('device common tools have eight controls, replacing fixed volume buttons with device logs', () => {
  assert.equal(commonButtons().length, 8);
  assert.ok(logsButton());
  for (const button of commonButtons()) {
    const label = attribute(button, 'label');
    if (label) assert.doesNotMatch(code(label), /音量[+-]/);
  }
  assert.doesNotMatch(card.text, /Volume2|VolumeX|onCommand|input keyevent (24|25)/);
});

test('log button forwards the clicked card identity and disables disconnected devices', () => {
  const button = logsButton(); assert.ok(button);
  const calls = [];
  for (const id of ['device-A', 'device-B']) {
    const click = new Function('device', 'onViewApplicationLogs', `return (${code(attribute(button, 'onClick'))});`)({ id }, value => calls.push(value));
    click();
  }
  assert.deepEqual(calls, [{ deviceId: 'device-A' }, { deviceId: 'device-B' }]);
  const disabled = new Function('isOnline', `return (${code(attribute(button, 'disabled'))});`);
  assert.equal(disabled(false), true); assert.equal(disabled(true), false);
});

test('existing App callback opens explicit device context and retains failure feedback without device operations', async () => {
  const app = source('App.jsx'), calls = [], selection = [], messages = [];
  let response = { ok: true };
  const open = new Function('window', 'setActiveDeviceId', 'activeDeviceId', 'tr', 'showToast', `return (${initializer(app, 'viewApplicationLogs')});`)(
    { electronAPI: { logAnalyzerOpen: async value => { calls.push(value); return response; } } },
    value => selection.push(value), 'global-device', tr, value => messages.push(value));
  await open({ deviceId: 'card-B' });
  await open({ deviceId: 'card-A', packageName: 'com.example.fixture' });
  await open();
  assert.deepEqual(selection, ['card-B', 'card-A']);
  assert.deepEqual(calls, [{ deviceId: 'card-B', packageName: undefined }, { deviceId: 'card-A', packageName: 'com.example.fixture' }, { deviceId: 'global-device', packageName: undefined }]);
  assert.deepEqual(messages, []);
  response = { ok: false, error: 'fixture open failed' }; await open({ deviceId: 'card-B' });
  assert.equal(messages.length, 1); assert.match(messages[0], /fixture open failed/);
});

test('log context navigation only selects idle device/filter and refuses active capture or AI', () => {
  const logs = source('components/LogAnalyzer.jsx');
  const compile = (running, analyzing) => {
    const events = [];
    const fn = new Function('runningRef', 'aiAnalyzingRef', 'setNote', 'clearTimeout', 'filterDebounceRef', 'setDeviceId', 'setFilter', 'setFilterTextInput', 'tr', `return (${initializer(logs, 'applyContext')});`)(
      { current: running }, { current: analyzing }, value => events.push(['note', value]), value => events.push(['clearTimer', value]), { current: 17 },
      value => events.push(['device', value]), value => events.push(['filter', value]), value => events.push(['textFilter', value]), tr);
    return { fn, events };
  };
  for (const [running, analyzing] of [[true, false], [false, true], [true, true]]) {
    const { fn, events } = compile(running, analyzing); fn({ deviceId: 'other-device', packageName: 'other.package' });
    assert.equal(events.length, 1); assert.equal(events[0][0], 'note');
    assert.match(events[0][1], /未切换设备或过滤条件/); assert.doesNotMatch(events[0][1], /应用详情/);
  }
  const { fn, events } = compile(false, false);
  fn(null); assert.deepEqual(events, []);
  fn({ deviceId: 'card-A', packageName: 'com.example.fixture' });
  assert.deepEqual(events.slice(0, 4), [['clearTimer', 17], ['device', 'card-A'], ['filter', { pkg: 'com.example.fixture' }], ['textFilter', '']]);
  events.length = 0; fn({ deviceId: 'card-B' });
  assert.deepEqual(events.slice(0, 4), [['clearTimer', 17], ['device', 'card-B'], ['filter', {}], ['textFilter', '']]);
  assert.match(events[4][1], /未自动抓取；现有日志保持不变/);
});

test('volume key commands remain supported by custom shortcuts without mutating defaults', () => {
  for (const keycode of [24, 25]) {
    const config = defaultDeviceShortcuts();
    config.slots[0] = { id: 'slot-1', label: keycode === 24 ? '音量+' : '音量-', type: 'shell', command: `input keyevent ${keycode}` };
    assert.deepEqual(normalizeDeviceShortcuts(config), config);
    assert.deepEqual(backendShortcuts.normalizeDeviceShortcuts(config), config);
  }
  assert.equal(defaultDeviceShortcuts().slots[0].action, 'home');
});
