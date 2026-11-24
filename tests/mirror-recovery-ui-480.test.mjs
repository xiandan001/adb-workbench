import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'rolldown/utils';

const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : !node || typeof node !== 'object' ? '' : [node.props?.children].flat(Infinity).map(text).join(' ');
const theme = { text: '', textMuted: '', button: { secondary: '' } };
function component(name, translate) {
  const source = fs.readFileSync(new URL('../src/components/' + name + '.jsx', import.meta.url), 'utf8').replace(/^import .+;\r?\n/gm, '').replace('export default function', 'function');
  const code = transformSync(name + '.jsx', source, { jsx: { runtime: 'classic', pragma: 'jsx' } }).code;
  return vm.runInNewContext(code + '\n' + name, { useLocale() {}, Loader2: 'icon', RotateCcw: 'icon', FileText: 'icon', Check: 'icon', X: 'icon',
    tr: translate || ((value, args = {}) => value.replace(/\{(\d+)\}/g, (whole, key) => args[key] ?? whole)), jsx: (type, props, ...children) => ({ type, props: { ...props, children } }) });
}
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && text(node).trim() === label);

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

test('successful Android and Harmony exits are hidden, but early exits and renderer failures can be dismissed', () => {
  const View = component('DeviceMirrorStatus'), dismissed = [];
  const device = { id: 'A', generation: 1, status: 'device' };
  const base = { id: 'previous-session', deviceId: 'A', generation: 1, phase: 'exited' };
  const render = session => View({ session, device, theme, onDismiss: id => dismissed.push(id) });
  const collapse = tree => nodes(tree).find(node => node.type === 'button' && node.props['aria-label'] === '收起');

  assert.equal(render({ ...base, reason: 'CLEAN_EXIT', exitCode: 0 }), null);
  assert.equal(render({ ...base, reason: 'WINDOW_CLOSED' }), null);
  assert.equal(render({ ...base, reason: 'USER_STOP' }), null);
  const early = render({ ...base, reason: 'EARLY_EXIT', exitCode: 0 });
  assert.match(text(early), /异常结束/);
  collapse(early).props.onClick();
  const crashed = render({ ...base, id: 'new-session', phase: 'failed', reason: 'WINDOW_CLOSED' });
  assert.match(text(crashed), /异常结束/);
  collapse(crashed).props.onClick();
  assert.deepEqual(dismissed, ['previous-session', 'new-session']);
  assert.equal(collapse(render({ ...base, phase: 'running' })), undefined);
});
