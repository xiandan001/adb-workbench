import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const memory = new Map();
const writes = [];
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: key => memory.get(key) ?? null,
  setItem(key, value) { memory.set(key, value); writes.push([key, value]); },
  removeItem: key => memory.delete(key),
} });

// Import the real translator/store only after installing isolated in-memory
// storage. No Electron API or identity-translator stub participates in these tests.
const { getLocale, setLanguage, tr } = await import('../src/shared/i18n.js');
const { draftFingerprint } = await import('../src/shared/taskCenterWorkspace.js');
const { defaultSerialPreferences, normalizePreferences, encodeMessage } = await import('../src/shared/serialSettings.js');
const { defaultDeviceShortcuts, normalizeDeviceShortcuts } = await import('../src/shared/deviceNavigationShortcuts.js');
const originalLocale = getLocale();
after(async () => {
  await setLanguage(originalLocale);
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete globalThis.localStorage;
});

function sourceHook(file, name) {
  const source = fs.readFileSync(new URL(`../src/components/${file}`, import.meta.url), 'utf8');
  let selected;
  traverse(parse(source, { sourceType: 'module', plugins: ['jsx'] }), {
    VariableDeclarator({ node }) {
      if (node.id.name === name && node.init?.callee?.name === 'useMemo') selected = node.init;
    },
    CallExpression({ node }) {
      if (name === 'initialTargets' && node.callee.name === 'useEffect'
        && source.slice(node.arguments[1]?.start, node.arguments[1]?.end) === '[activeDeviceId, onlineDevices, loading]') selected = node;
    },
  });
  assert.ok(selected, `${file}: actual ${name} hook must exist`);
  assert.match(source, /useLocale\(\)/, `${file}: the component must still subscribe to language changes`);
  const [callback, dependencies] = selected.arguments;
  return { callback: source.slice(callback.start, callback.end), dependencies: source.slice(dependencies.start, dependencies.end),
    dependencyNames: dependencies.elements.map(node => node.name) };
}

// React compares dependency entries with Object.is. Evaluate the actual source
// callback and dependency expression; cache only when React would cache them.
function memoHarness(hook, scope) {
  const callback = runInNewContext(`(${hook.callback})`, scope);
  let previous; let value; let executions = 0;
  return {
    render() {
      const next = runInNewContext(hook.dependencies, scope);
      if (!previous || next.length !== previous.length || next.some((item, index) => !Object.is(item, previous[index]))) {
        previous = [...next]; value = callback(); executions++;
      }
      return value;
    },
    executions: () => executions,
  };
}

async function switchLanguage(locale) {
  await setLanguage(locale);
  assert.equal(getLocale(), locale);
  assert.equal(tr('取消'), locale === 'en-US' ? 'Cancel' : '取消', 'the real catalog must change visible copy');
}

test('changing language preserves the online-device memo and does not reselect intentionally empty task targets', async () => {
  await switchLanguage('zh-CN');
  const hook = sourceHook('TaskCenter.jsx', 'onlineDevices');
  assert.deepEqual(hook.dependencyNames, ['devices']);
  const scope = { devices: [{ id: 'A', status: 'device' }, { id: 'B', status: 'offline' }], locale: getLocale() };
  const online = memoHarness(hook, scope);
  const first = online.render();
  let selected = []; let selectionWrites = 0;
  const selectionScope = { activeDeviceId: 'A', loading: false, onlineDevices: first,
    setSelectedDeviceIds(update) { selected = update(selected); selectionWrites++; } };
  const selection = memoHarness(sourceHook('TaskCenter.jsx', 'initialTargets'), selectionScope);
  selection.render(); assert.deepEqual([...selected], ['A']);
  selected = []; // The user explicitly clears all run targets after initial selection.

  await switchLanguage('en-US'); scope.locale = getLocale();
  selectionScope.onlineDevices = online.render(); selection.render();
  assert.strictEqual(selectionScope.onlineDevices, first);
  assert.deepEqual(selected, []);
  assert.equal(selectionWrites, 1); assert.equal(online.executions(), 1);

  // A real device-prop change still invalidates the memo, unlike a locale change.
  scope.devices = [{ id: 'C', status: 'device' }];
  assert.notStrictEqual(online.render(), first);
  assert.deepEqual([...online.render()].map(device => device.id), ['C']);
  assert.equal(online.executions(), 2);
});

test('changing language preserves the normalized shortcut config reference used by the capability subscription', async () => {
  await switchLanguage('zh-CN');
  const hook = sourceHook('DeviceShortcutEditor.jsx', 'validDraft');
  assert.deepEqual(hook.dependencyNames, ['draft']);
  const scope = { draft: defaultDeviceShortcuts(), locale: getLocale(), normalizeDeviceShortcuts };
  const memo = memoHarness(hook, scope); const first = memo.render(); const serialized = JSON.stringify(first);
  const capabilityHook = fs.readFileSync(new URL('../src/shared/useDeviceShortcutCapabilities.js', import.meta.url), 'utf8');
  assert.match(capabilityHook, /\[deviceId, isOnline, config, key\]/, 'config identity is an actual effect dependency');

  await switchLanguage('en-US'); scope.locale = getLocale();
  assert.strictEqual(memo.render(), first);
  assert.equal(JSON.stringify(memo.render()), serialized);
  assert.equal(memo.executions(), 1);

  scope.draft = structuredClone(scope.draft); scope.draft.slots[0].label = '我的快捷操作';
  const edited = memo.render();
  assert.notStrictEqual(edited, first); assert.equal(edited.slots[0].label, '我的快捷操作');
  assert.equal(memo.executions(), 2);
});

test('both real locales preserve task fingerprints, serial preferences, raw send bytes and built-in commands', async () => {
  const draft = { id: 'user-script', name: '用户草稿', description: '原文不得翻译', steps: [
    { id: 'step-1', type: 'shell', name: '用户步骤', command: 'echo "原始输入"' },
    { id: 'step-2', type: 'input', name: '输入文本', text: '保存 / Cancel / 我的数据' },
  ] };
  const preferences = defaultSerialPreferences();
  preferences.favorites = [{ id: 'saved-command', name: '用户命令', mode: 'text', content: '中文原文\r\n', lineEnding: 'lf' }];
  const userShortcuts = defaultDeviceShortcuts(); userShortcuts.slots[0].label = '我自己的名称';
  const originalDraft = JSON.stringify(draft); const originalPreferences = JSON.stringify(preferences);
  const snapshots = [];
  for (const locale of ['zh-CN', 'en-US']) {
    await switchLanguage(locale);
    snapshots.push({ fingerprint: draftFingerprint(draft), preferences: normalizePreferences(preferences),
      utf8: [...encodeMessage({ mode: 'text', content: '原文\x03\r\n', lineEnding: 'cr' })],
      hex: [...encodeMessage({ mode: 'hex', content: 'AB 05 0A DF 4E', lineEnding: 'none' })],
      ascii: [...encodeMessage({ mode: 'ascii', content: 'status\x03', lineEnding: 'crlf' })],
      builtins: defaultDeviceShortcuts(), userShortcuts: normalizeDeviceShortcuts(userShortcuts) });
  }
  assert.deepEqual(snapshots[1], snapshots[0]);
  assert.equal(JSON.stringify(draft), originalDraft);
  assert.equal(JSON.stringify(preferences), originalPreferences);
  assert.equal(snapshots[0].fingerprint, originalDraft);
  assert.deepEqual(snapshots[0].utf8, [...Buffer.from('原文\x03\r\n\r', 'utf8')]);
  assert.deepEqual(snapshots[0].hex, [0xab, 0x05, 0x0a, 0xdf, 0x4e]);
  assert.deepEqual(snapshots[0].ascii, [...Buffer.from('status\x03\r\n', 'ascii')]);
  assert.ok(writes.length > 0);
  assert.ok(writes.every(([key]) => key === 'adb-workbench.language.v1'), 'only the isolated language cache may be written');
});
