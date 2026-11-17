import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'rolldown/utils';
import { createMessageTranslator } from '../src/shared/messageCatalog.js';

const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : !node || typeof node !== 'object' ? '' : [node.props?.children].flat(Infinity).map(text).join(' ');
const theme = { text: '', textMuted: '', button: { secondary: '' } };
function component(name, translate) {
  const source = fs.readFileSync(new URL('../src/components/' + name + '.jsx', import.meta.url), 'utf8').replace(/^import .+;\r?\n/gm, '').replace('export default function', 'function');
  const code = transformSync(name + '.jsx', source, { jsx: { runtime: 'classic', pragma: 'jsx' } }).code;
  return vm.runInNewContext(code + '\n' + name, { useLocale() {}, Loader2: 'icon', RotateCcw: 'icon', FileText: 'icon', Check: 'icon', X: 'icon', Play: 'icon', ShieldCheck: 'icon',
    tr: translate || ((value, args = {}) => value.replace(/\{(\d+)\}/g, (whole, key) => args[key] ?? whole)), jsx: (type, props, ...children) => ({ type, props: { ...props, children } }) });
}
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && text(node).trim() === label);

test('a new typed address has persistent local feedback and actions do not run until clicked', () => {
  const View = component('ConnectionAttemptNotice'), actions = [];
  const failure = View({ result: { status: 'error', address: '192.0.2.9', message: 'connection timeout' }, theme,
    onRetry: () => actions.push('retry'), onEnvironment: () => actions.push('check') });
  assert.match(text(failure), /192\.0\.2\.9/); assert.match(text(failure), /connection timeout/); assert.deepEqual(actions, []);
  button(failure, '重试连接').props.onClick(); assert.deepEqual(actions, ['retry']);
  const success = View({ result: { status: 'success', deviceId: 'TARGET', address: '192.0.2.9', message: 'connected' }, theme,
    onUse: id => actions.push('use:' + id), onCast: id => actions.push('cast:' + id) });
  assert.deepEqual(actions, ['retry']); button(success, '设为当前并投屏').props.onClick(); assert.deepEqual(actions, ['retry', 'cast:TARGET']);
});

test('texture readiness is not labelled a confirmed picture, remembering is explicit and stale device state cannot appear on another generation', () => {
  const View = component('DeviceMirrorStatus'), actions = [], device = { id: 'A', generation: 1, status: 'device' };
  const props = { session: { id: 'session', deviceId: 'A', generation: 1, transport: 'adb', phase: 'running', readiness: 'texture', pictureConfirmed: false, profileStatus: 'none' }, device, theme,
    onRemember: () => actions.push('remember'), onRetry: mode => actions.push(mode), onDiagnostics: () => actions.push('diagnostic') };
  const running = View(props); assert.match(text(running), /请核对画面/); assert.doesNotMatch(text(running), /画面已确认/); assert.deepEqual(actions, []);
  button(running, '画面正常，记住配置').props.onClick(); assert.deepEqual(actions, ['remember']);
  assert.equal(View({ ...props, device: { ...device, generation: 2 } }), null);
  const ended = View({ ...props, session: { ...props.session, phase: 'exited', exitCode: 1, profileStatus: 'saved' } });
  assert.match(text(ended), /异常结束/); button(ended, '使用全局设置重试').props.onClick(); assert.deepEqual(actions, ['remember', 'global']);
});

test('connection diagnostic body remains byte-identical across language changes while owned actions translate and retain their callbacks', () => {
  let locale = 'zh-CN'; const actions = [];
  const translate = createMessageTranslator([['名称 {0} / {1}', 'Name {0} / {1}'], ['重试连接', 'Retry connection'], ['查看连接自检', 'Check connection'],
    ['可重试连接或查看当前目标的环境自检。', 'Retry or check the current target.'], ['设为当前设备', 'Use device'], ['设为当前并投屏', 'Use and mirror']]);
  const View = component('ConnectionAttemptNotice', (source, params) => translate(source, params, locale));
  for (const raw of ['名称 A / B', '名称 A / A', '设备原文 192.0.2.240:5555\r\n[工具返回] 未知状态：名称 A / B']) {
    const props = { result: { status: 'error', address: '192.0.2.240:5555', message: raw }, theme,
      onRetry: () => actions.push('retry:' + raw), onEnvironment: () => actions.push('check:' + raw) };
    locale = 'zh-CN'; const chinese = View(props); locale = 'en-US'; const english = View(props);
    const body = tree => nodes(tree).find(node => node.type === 'p' && node.props.role === 'alert').props.children.find(node => node?.type === 'span').props.children[0];
    assert.equal(body(chinese), raw); assert.equal(body(english), raw);
    assert.deepEqual(Buffer.from(body(english), 'utf8'), Buffer.from(raw, 'utf8'));
    assert.ok(button(chinese, '重试连接')); button(english, 'Retry connection').props.onClick(); button(english, 'Check connection').props.onClick();
    assert.deepEqual(actions.slice(-2), ['retry:' + raw, 'check:' + raw]);
  }
  const result = { status: 'success', deviceId: 'EXACT-TARGET', address: '192.0.2.240:5555', message: '名称 A / B' };
  const success = View({ result, theme, onUse: id => actions.push('use:' + id), onCast: id => actions.push('cast:' + id) });
  button(success, 'Use device').props.onClick(); button(success, 'Use and mirror').props.onClick();
  assert.deepEqual(actions.slice(-2), ['use:EXACT-TARGET', 'cast:EXACT-TARGET']); assert.equal(result.message, '名称 A / B');
});
