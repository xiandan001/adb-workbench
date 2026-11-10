import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { tr, setLanguage } from '../src/shared/i18n.js';
import { displayDeviceId } from '../src/shared/devicePlatform.js';
const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser'), traverse = require('@babel/traverse').default;
const source = readFileSync(new URL('../src/components/DeviceCard.jsx', import.meta.url), 'utf8');
const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
const native = ['bm dump -a', 'param get const.ohos.fullname', 'hidumper -s 3302 -a -i', 'cat /proc/meminfo', 'ls -la /data/'];
const android = ['pm list packages', 'getprop ro.build.version', 'dumpsys battery', 'cat /proc/meminfo', 'ls -la /data/'];
const model = () => import('../src/shared/deviceTerminal.js');
function expression(name, context) {
  let target;
  traverse(ast, { VariableDeclarator({ node }) { if (node.id.name === name) target = node.init; } });
  assert.ok(target, name); return runInNewContext(`(${source.slice(target.start, target.end)})`, context);
}
function chipHandler(context) {
  let target;
  traverse(ast, { JSXAttribute(nodePath) {
    if (nodePath.node.name.name !== 'onClick') return;
    const map = nodePath.findParent(parent => parent.isCallExpression() && parent.node.callee.property?.name === 'map' && parent.node.arguments[0]?.params?.[0]?.name === 'cmd');
    if (map) target = nodePath.node.value.expression;
  } });
  assert.ok(target, 'real quick-command button'); return runInNewContext(`(${source.slice(target.start, target.end)})`, context);
}
async function fixture(deviceId = 'hdc:fixture') {
  const helpers = await model().catch(() => ({}));
  const state = { rows: [], calls: [], history: [], text: '' };
  const context = { ...helpers, tr, displayDeviceId, device: { id: deviceId }, harmony: deviceId.startsWith('hdc:'), isOnline: true,
    terminalCommand: '', isExecuting: false, suMode: false, suStrategy: 'none',
    setIsExecuting() {}, setShowHistory() {}, setHistoryIndex() {},
    setTerminalCommand: value => { state.text = value; context.terminalCommand = value; },
    setTerminalOutput: update => { state.rows = update(state.rows); },
    onSaveTerminalCommand: value => state.history.push(value),
    onExecuteCommand: async (deviceId, command) => { state.calls.push({ deviceId, command }); return 'synthetic output'; }
  };
  return { state, context, submit: () => expression('handleTerminalSubmit', context)({ preventDefault() {} }) };
}

test('native and Android terminal command models remain distinct and read-only defaults are exact', async () => {
  const { deviceTerminalCommands } = await model();
  assert.deepEqual(deviceTerminalCommands({ id: 'hdc:fixture' }), native);
  assert.deepEqual(deviceTerminalCommands({ id: 'android' }), android);
  assert.ok(Object.isFrozen(deviceTerminalCommands({ id: 'hdc:fixture' })));
});

test('real platform chip callbacks only prepare input, then the real submit handler sends the unchanged selected-device DTO', async () => {
  const { deviceTerminalCommands } = await model();
  for (const [deviceId, expected] of [['hdc:fixture', native], ['android', android]]) {
    const h = await fixture(deviceId);
    const commands = expression('terminalCommands', h.context);
    assert.deepEqual(commands, deviceTerminalCommands(h.context.device));
    for (const command of expected) {
      const before = h.state.calls.length;
      h.context.cmd = command; chipHandler(h.context)();
      assert.equal(h.state.text, command); assert.equal(h.state.calls.length, before, 'chip does not auto-run');
      await h.submit(); assert.deepEqual(h.state.calls.at(-1), { deviceId, command });
      assert.equal(h.state.history.at(-1), command);
    }
  }
});

test('real submit echo has a single stored prompt and retains arbitrary user text without Android alias rewriting', async () => {
  for (const deviceId of ['hdc:fixture', 'android']) {
    const h = await fixture(deviceId);
    const command = "pm list packages; printf '%s' '$raw'; echo \"中文\"";
    h.context.terminalCommand = command;
    await h.submit();
    assert.deepEqual(h.state.calls, [{ deviceId, command }]); assert.deepEqual(h.state.history, [command]);
    assert.equal(h.state.rows[0].prompt, '$');
    assert.match(h.state.rows[0].text, deviceId.startsWith('hdc:') ? /^hdc -t fixture shell / : /^adb -s android shell /);
    assert.doesNotMatch(h.state.rows[0].text, /^[#$]\s|hdc:fixture/);
  }
});

test('offline or busy real submit handlers cannot dispatch a terminal command', async () => {
  for (const flag of ['offline', 'busy']) {
    const h = await fixture(); h.context.terminalCommand = native[0];
    h.context.isOnline = flag !== 'offline'; h.context.isExecuting = flag === 'busy';
    await h.submit(); assert.deepEqual(h.state.calls, []); assert.deepEqual(h.state.history, []); assert.deepEqual(h.state.rows, []);
  }
});

test('real rendered command marker uses its captured prompt even after ROOT mode changes', () => {
  let marker;
  traverse(ast, { JSXExpressionContainer({ node }) {
    if (node.expression.type === 'ConditionalExpression' && node.expression.test.name === 'isCmd') {
      const text = source.slice(node.expression.start, node.expression.end);
      if (text.includes('line.prompt')) marker = text;
    }
  } });
  assert.ok(marker, 'rendered prompt comes from the original command row');
  for (const prompt of ['$', '#']) assert.equal(runInNewContext(`(${marker})`, { isCmd: true, isErr: false, line: { prompt }, suMode: false }), prompt);
});

test('native ROOT inspection only reads identity and never invokes Android su or elevation', async () => {
  const h = await fixture(); const calls = [];
  h.context.window = { electronAPI: { adbShell: async (id, command) => { calls.push({ id, command }); return { success: true, output: 'uid=2000(shell)' }; } } };
  const check = expression('checkSuSupported', h.context);
  assert.equal((await check()).supported, false); assert.deepEqual(calls, [{ id: 'hdc:fixture', command: 'id' }]);
  const { createDeviceTerminalRequest } = await model();
  const nativeRequest = createDeviceTerminalRequest(h.context.device, "echo 'safe'", { root: true, strategy: 'su-c' });
  assert.equal(nativeRequest.command, "echo 'safe'", 'stale Android strategy cannot wrap a native command');
  assert.equal(nativeRequest.prompt, '#');
  const legacy = createDeviceTerminalRequest({ id: 'android' }, "echo 'safe'", { root: true, strategy: 'su-c' });
  assert.equal(legacy.command, "su -c 'echo '\\''safe'\\'''", 'existing Android explicit SU behavior remains');
});

test('all five locales change terminal copy without changing commands or hiding the HDC identity', async () => {
  const { deviceTerminalPresentation, deviceTerminalCommands } = await model();
  const seen = [];
  try {
    for (const locale of ['zh-CN', 'en-US', 'zh-TW', 'ja-JP', 'ko-KR']) {
      await setLanguage(locale);
      const value = deviceTerminalPresentation({ id: 'hdc:fixture' }, false);
      assert.match(value.title, /HDC/); assert.match(value.title, /fixture/); assert.doesNotMatch(value.title, /hdc:/);
      assert.match(value.placeholder, /HDC/); assert.doesNotMatch(value.placeholder, /ADB/);
      assert.doesNotMatch(value.rootWarning.title + value.rootWarning.message + value.rootWarning.detail, /Magisk|ADB/);
      assert.deepEqual(deviceTerminalCommands({ id: 'hdc:fixture' }), native);
      assert.deepEqual(deviceTerminalCommands({ id: 'android' }), android);
      seen.push(value.placeholder);
    }
    assert.equal(new Set(seen).size, 5);
  } finally { await setLanguage('zh-CN'); }
});
