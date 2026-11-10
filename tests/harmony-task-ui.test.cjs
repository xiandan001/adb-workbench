const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseHarmonyLayout, captureHarmonyLayout, buildHarmonyInput, performHarmonyInput, normalizeHarmonyCoordinate, normalizeHarmonyDuration, MAX_LAYOUT_BYTES } = require('../electron/lib/harmony-task-ui.cjs');
const { findHarmonyNode, parseHarmonyUdid, preflightHarmonyInputs } = require('../electron/lib/harmony-task-execution.cjs');
const { assertTaskPlatform } = require('../electron/lib/task-platform.cjs');

const layout = () => JSON.stringify({ attributes: { bundleName: 'com.example.app', bounds: '[0,0][100,200]', type: 'Root' }, children: [
  { attributes: { id: 'submit', text: '提交', type: 'Button', bounds: { left: 10, top: 20, right: 60, bottom: 80 } } },
  { attributes: { id: 'password', text: 'must-not-leak', description: 'secret-description', password: true, type: 'TextInput', bounds: '[10,90][90,120]' } }
] });

test('Harmony JSON layout preserves bounds/IDs/bundle and masks sensitive values', () => {
  const nodes = parseHarmonyLayout(layout());
  assert.equal(nodes.length, 3);
  const button = nodes.find(node => node.attrs['resource-id'] === 'submit');
  assert.equal(button.attrs.package, 'com.example.app');
  assert.equal(button.attrs.text, '提交');
  assert.deepEqual(button.bounds, { left: 10, top: 20, right: 60, bottom: 80 });
  assert.doesNotMatch(JSON.stringify(nodes), /must-not-leak|secret-description/);
  assert.throws(() => parseHarmonyLayout('x'.repeat(MAX_LAYOUT_BYTES + 1)), /过大/);
  assert.throws(() => parseHarmonyLayout('not json'), /JSON/);
});

test('Harmony selectors reject duplicate matches instead of selecting the first or using old coordinates', async () => {
  const nodes = parseHarmonyLayout(layout());
  const step = { resourceId: 'submit', x: 999, y: 999 };
  assert.equal((await findHarmonyNode('hdc:A', step, {}, async () => ({ nodes }))).attrs.text, '提交');
  await assert.rejects(findHarmonyNode('hdc:A', step, {}, async () => ({ nodes: [...nodes, nodes[1]] })), /不唯一/);
  assert.equal(await findHarmonyNode('hdc:A', { resourceId: 'missing' }, {}, async () => ({ nodes })), null);
});

test('native input maps logical keys and converts milliseconds to speed without dropping unsupported duration/curves', () => {
  assert.deepEqual(buildHarmonyInput({ type: 'keyevent', keyCode: 'HOME' }, null, {}), ['shell', 'uitest', 'uiInput', 'keyEvent', 'Home']);
  assert.equal(buildHarmonyInput({ type: 'keyevent', keyCode: 'Back' }, null, {}).at(-1), 'Back');
  assert.equal(buildHarmonyInput({ type: 'keyevent', keyCode: 'Power' }, null, {}).at(-1), 'Power');
  assert.equal(buildHarmonyInput({ type: 'keyevent', keyCode: 'native:2072' }, null, {}).at(-1), '2072');
  assert.throws(() => buildHarmonyInput({ type: 'keyevent', keyCode: '3' }, null, {}), /Android/);
  assert.equal(buildHarmonyInput({ type: 'swipe', endX: 401, endY: 1, durationMs: 400 }, { x: 1, y: 1 }, {}).at(-1), '1000');
  assert.throws(() => buildHarmonyInput({ type: 'swipe', endX: 2, endY: 1, durationMs: 1000 }, { x: 1, y: 1 }, {}), /200/);
  assert.throws(() => buildHarmonyInput({ type: 'swipe', points: [{}, {}, {}] }, { x: 0, y: 0 }, {}), /曲线/);
  assert.throws(() => buildHarmonyInput({ type: 'longPress', durationMs: 800 }, { x: 1, y: 2 }, {}), /毫秒/);
  assert.equal(buildHarmonyInput({ type: 'longPress', longPressMode: 'native', durationMs: null }, { x: 1, y: 2 }, {})[3], 'longClick');
});

test('focus input requires positively known API18/text support while explicit coordinates work on older devices', async () => {
  const text = '中文 text $value; "quoted"';
  assert.throws(() => buildHarmonyInput({ type: 'input', text }, null, { apiVersion: 17, focusText: true }), /API 18/);
  assert.throws(() => buildHarmonyInput({ type: 'input', text }, null, { apiVersion: 18, focusText: false }), /API 18/);
  assert.deepEqual(buildHarmonyInput({ type: 'input', text }, { x: 10, y: 20 }, {}).slice(3), ['inputText', '10', '20', text]);
  const calls = [];
  const run = async (_id, args) => { calls.push(args); return { ok: true, stdout: args.at(-1) === 'help' ? 'click\ninputText\ntext\n' : '17' }; };
  await assert.rejects(performHarmonyInput('hdc:A', { type: 'input', text }, null, {}, run), /API 18/);
  assert.equal(calls.length, 2); assert.equal(calls.some(args => args[3] === 'text'), false);
  calls.length = 0;
  await assert.rejects(performHarmonyInput('hdc:A', { type: 'longPress', durationMs: 800 }, { x: 1, y: 1 }, {}, run), /毫秒/);
  assert.equal(calls.length, 0);
});

test('layout capture uses a unique owned path and preserves fixed device options through cleanup', async () => {
  const calls = [], ref = { id: 'hdc:QA', transport: 'hdc', targetKey: 'QA' };
  const result = await captureHarmonyLayout(ref.id, { deviceRef: ref, command: '/fixture/hdc' }, async (id, args, options) => {
    calls.push({ id, args, options }); return { ok: true, stdout: args[1] === 'cat' ? layout() : '' };
  });
  const remote = calls[0].args.at(-1);
  assert.match(remote, /^\/data\/local\/tmp\/awb-layout-[a-f\d-]+\.json$/);
  assert.equal(calls[1].args.at(-1), remote); assert.ok(calls[2].args[1].includes(remote));
  assert.ok(calls.every(call => call.id === ref.id && call.options.deviceRef === ref && call.options.command === '/fixture/hdc'));
  assert.equal(result.nodes.length, 3);
});

test('legacy Android scripts stay Android and unsupported Harmony parameters fail before mutation', () => {
  assert.doesNotThrow(() => assertTaskPlatform({ steps: [] }, ['android-A']));
  assert.throws(() => assertTaskPlatform({ steps: [] }, ['hdc:A']), /平台/);
  assert.throws(() => assertTaskPlatform({ targetPlatform: 'harmony', steps: [] }, ['android-A', 'hdc:A']), /平台/);
  assert.throws(() => assertTaskPlatform({ targetPlatform: 'harmony', steps: [{ type: 'installApk', localPath: '/fixture/app.apk' }] }, ['hdc:A']), /HAP/);
  assert.throws(() => assertTaskPlatform({ targetPlatform: 'harmony', steps: [{ type: 'externalScript', adapter: 'custom', args: '{adb} -s {deviceId}' }] }, ['hdc:A']), /外部脚本/);
  assert.equal(parseHarmonyUdid('udid of current device is:\n23CADE0C'), '23cade0c');
  assert.equal(parseHarmonyUdid('192.168.1.5:8710'), '');
  assert.equal(parseHarmonyUdid('0000000000000000'), '');
});

test('Harmony coordinates and durations retain explicit values rather than silently clamping or losing them', () => {
  assert.equal(normalizeHarmonyDuration({ durationMs: 80 }), 80);
  assert.equal(normalizeHarmonyDuration({ longPressMode: 'native', durationMs: null }), null);
  assert.throws(() => normalizeHarmonyDuration({ durationMs: -1 }), /时长/);
  assert.throws(() => normalizeHarmonyCoordinate('invalid'), /坐标/);
  assert.throws(() => normalizeHarmonyCoordinate(1.2), /坐标/);
  assert.throws(() => normalizeHarmonyCoordinate(0), /大于 0/);
  assert.equal(normalizeHarmonyCoordinate(''), null);
});

test('unavailable native metrics never become zero or a passing configured threshold', () => {
  const { harmonyMetricValues, evaluateHarmonyThresholds } = require('../electron/lib/harmony-quality-data.cjs');
  const snapshot = { cpu: { usage: null }, memory: { usage: 25 }, battery: { temperature: null }, thermal: { hottest: null }, disk: [{ mount: '/data', usage: 90 }] };
  assert.deepEqual(harmonyMetricValues(snapshot), { cpu: null, memory: 25, batteryTemp: null, dataUsed: 90 });
  const warnings = evaluateHarmonyThresholds(snapshot, { cpu: 80, memory: 80, batteryTemp: 45, dataUsed: 85 });
  assert.equal(warnings.length, 3); assert.equal(warnings.filter(item => item.unavailable).length, 2);
  assert.ok(warnings.every(item => item.fail));
});

test('a later unsupported focus-input step is preflighted before any install or action step', async () => {
  const task = { hdcPath: path.resolve('fixture-hdc.exe'), deviceRefs: { 'hdc:QA': { id: 'hdc:QA', transport: 'hdc', targetKey: 'QA', status: 'device' } },
    script: { targetPlatform: 'harmony', steps: [{ type: 'installApk', localPath: 'fixture.hap' }, { type: 'input', text: 'explicit text', x: null, y: null }] } };
  const calls = [], read = async (id, args, options) => { calls.push({ id, args, options }); return { ok: true, stdout: args.at(-1) === 'help' ? 'click\ninputText\ntext\nkeyEvent' : '17' }; };
  await assert.rejects(preflightHarmonyInputs(task, 'hdc:QA', undefined, read), /API 18/);
  assert.equal(calls.length, 2); assert.ok(calls.every(call => call.args.at(-1) === 'help' || call.args.at(-1) === 'const.ohos.apiversion'));
  assert.ok(calls.every(call => call.options.deviceRef.id === 'hdc:QA'));
  task.cancelled = true; calls.length = 0;
  await assert.rejects(preflightHarmonyInputs(task, 'hdc:QA', undefined, read), { code: 'CANCELLED' });
  assert.equal(calls.length, 0);
});

test('explicit input target preflight requires advertised inputText but never reads the focus-text API version', async () => {
  const task = { hdcPath: path.resolve('fixture-hdc.exe'), deviceRefs: { 'hdc:QA': { id: 'hdc:QA', transport: 'hdc', targetKey: 'QA', status: 'device' } },
    script: { targetPlatform: 'harmony', steps: [{ type: 'input', text: 'fixture', selector: { resourceId: 'field' } }] } };
  const calls = [];
  await preflightHarmonyInputs(task, 'hdc:QA', undefined, async (_id, args) => { calls.push(args); return { ok: true, stdout: 'uiInput\n  inputText <x> <y> <text>\n' }; });
  assert.deepEqual(calls, [['shell', 'uitest', 'help']]); assert.equal(task.uitestCapabilities['hdc:QA'].apiVersion, null);
});
