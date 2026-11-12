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
let appExecuteExpression;
function actualAppExecute(api) {
  if (!appExecuteExpression) {
    const appSource = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8'); let target;
    traverse(parse(appSource, { sourceType: 'module', plugins: ['jsx'] }), {
      VariableDeclarator({ node }) { if (node.id.name === 'handleExecuteCommand') target = node.init; }
    });
    assert.ok(target, 'actual App terminal handler'); appExecuteExpression = appSource.slice(target.start, target.end);
  }
  return runInNewContext(`(${appExecuteExpression})`, { tr, window: { electronAPI: api } });
}
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
    setIsExecuting(value) { context.isExecuting = value; }, setShowHistory() {}, setHistoryIndex() {},
    working: { beginExecution() { if (context.isExecuting) return false; context.isExecuting = true; return true; } },
    setTerminalCommand: value => { state.text = typeof value === 'function' ? value(context.terminalCommand) : value; context.terminalCommand = state.text; },
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

test('failed terminal requests restore the failed draft without replaying or replacing a newer draft', async () => {
  for (const newerDraft of ['', 'a different unsent draft']) {
    const h = await fixture('android'); h.context.terminalCommand = 'echo failed fixture';
    h.context.onExecuteCommand = async () => { h.context.terminalCommand = newerDraft; throw new Error('fixture command failed'); };
    await h.submit(); assert.equal(h.state.text, newerDraft || 'echo failed fixture');
    assert.equal(h.context.isExecuting, false); assert.equal(h.state.rows.at(-1).type, 'error'); assert.match(h.state.rows.at(-1).text, /fixture command failed/);
    assert.equal(h.state.history.length, 1, 'the request is never automatically retried');
  }
});

test('actual App and Card handlers preserve failed, timed-out, rejected and cancelled requests without automatic replay', async () => {
  const scenarios = [
    { name: 'resolved failure', result: { success: false, error: 'fixture offline' }, error: 'fixture offline' },
    { name: 'timeout with partial output', result: { success: false, timedOut: true, error: 'fixture timeout', output: 'fixture timeout partial output' }, error: 'fixture timeout' },
    { name: 'IPC rejection', rejection: new Error('fixture transport rejected'), error: 'fixture transport rejected' },
    { name: 'cancel with partial output', result: { success: false, cancelled: true, output: 'fixture cancelled partial output' }, cancelled: true }
  ];
  for (const deviceId of ['android', 'hdc:fixture']) for (const scenario of scenarios) for (const newerDraft of ['', 'newer unsent fixture draft']) {
    const h = await fixture(deviceId), calls = []; let resolveShell, rejectShell;
    const shell = new Promise((resolve, reject) => { resolveShell = resolve; rejectShell = reject; });
    h.context.onExecuteCommand = actualAppExecute({ adbShell: (id, command) => { calls.push({ id, command }); return shell; } });
    const command = 'echo preserved fixture'; h.context.setTerminalCommand(command);
    const pending = h.submit();
    assert.equal(h.context.isExecuting, true, scenario.name); assert.equal(h.state.text, '');
    assert.deepEqual(calls, [{ id: deviceId, command }]);
    h.context.setTerminalCommand(newerDraft); await h.submit();
    assert.equal(calls.length, 1, 'a live request cannot be dispatched twice');
    if (scenario.rejection) rejectShell(scenario.rejection); else resolveShell(scenario.result);
    await pending; await Promise.resolve();
    assert.equal(h.state.text, newerDraft || command, `${deviceId}: ${scenario.name}`);
    assert.equal(h.context.isExecuting, false); assert.equal(calls.length, 1, 'failure does not automatically replay the command');
    assert.deepEqual(h.state.history, [command]); assert.equal(h.state.rows.filter(row => row.type === 'command').length, 1);
    if (scenario.result?.output) assert.ok(h.state.rows.some(row => row.type === 'output' && row.text === scenario.result.output), 'partial output remains visible');
    if (scenario.cancelled) {
      assert.equal(h.state.rows.filter(row => row.type === 'error').length, 0);
      assert.equal(h.state.rows.at(-1).text, tr('命令已中断'));
    } else {
      assert.equal(h.state.rows.at(-1).type, 'error');
      assert.equal(h.state.rows.at(-1).text, tr('命令执行失败: {0}', { 0: scenario.error }));
    }
  }
});
