import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'rolldown/utils';
import { canUseMembershipFeature } from '../src/shared/membershipEntitlements.js';

const source = fs.readFileSync(new URL('../src/components/MemberCenter.jsx', import.meta.url), 'utf8')
  .replace(/^import .+;\r?\n/gm, '')
  .replace('export default function', 'function');
const code = transformSync('MemberCenter.jsx', source, { jsx: { runtime: 'classic', pragma: 'jsx' } }).code;
const visible = node => !node || typeof node !== 'object' || node.props.hidden
  ? [] : [node, ...node.props.children.flat(Infinity).flatMap(visible)];
const label = node => typeof node === 'string' ? node : node && typeof node === 'object'
  ? node.props.children.flat(Infinity).map(label).join('') : '';
const free = { activated: false, reason: 'no_token', machineId: 'test-machine' };

function mount(api = {}, vipStatus = free, onReturn) {
  const hooks = [];
  const statuses = [];
  const copied = [];
  const toasts = [];
  const props = { theme: {}, vipStatus, onActivated: status => statuses.push(status), onReturn, showToast: value => toasts.push(value) };
  let cursor;
  const runtime = {
    canUseMembershipFeature,
    window: { electronAPI: api },
    navigator: { clipboard: { writeText: async value => { copied.push(value); } } },
    tr: (str, args = {}) => str.replace(/\{(\d+)\}/g, (all, key) => args[key] ?? all),
    useLocale: () => 'zh-CN',
    isDarkTheme: () => false,
    useId: () => `field-${cursor++}`,
    useRef(value) { return hooks[cursor++] ??= { current: value }; },
    useState(value) {
      const slot = hooks[cursor++] ??= { value };
      return [slot.value, update => { slot.value = typeof update === 'function' ? update(slot.value) : update; }];
    },
    jsx: (type, props, ...children) => ({ type, props: { ...props, children } }),
  };
  for (const name of ['ArrowLeft', 'ChevronDown', 'Copy', 'Crown', 'KeyRound', 'Loader2', 'Lock', 'RefreshCw', 'ActivationRecordsPanel', 'MembershipBenefits']) runtime[name] = name;
  const render = vm.runInNewContext(`(function(){${code};return MemberCenter;})()`, runtime);
  const tree = () => { cursor = 0; return render(props); };
  const get = (type, predicate = () => true) => visible(tree()).find(node => node.type === type && predicate(node));
  return { props, tree, get, statuses, copied, toasts,
    button: text => get('button', node => label(node) === text),
    submit: () => get('form').props.onSubmit({ preventDefault() {} }),
    change: value => get('textarea').props.onChange({ target: { value } }),
  };
}

test('activation is immediately available and only verified status triggers a return', async () => {
  const calls = [];
  let result = { success: false, error: 'bad_signature' };
  const ui = mount({ vipActivate: async token => { calls.push(token); return result; } }, free, () => {});
  assert.ok(ui.get('textarea'));
  assert.equal(ui.button('激活会员').props.disabled, true);
  ui.change('  candidate  ');
  await ui.submit();
  assert.deepEqual(calls, ['candidate']);
  assert.match(label(ui.get('p', node => node.props.role === 'alert')), /签名校验失败/);
  assert.equal(ui.get('textarea').props.value, '  candidate  ');
  result = { success: true, status: { activated: false } };
  await ui.submit();
  assert.deepEqual(ui.statuses, []);
  assert.deepEqual(ui.toasts, []);
  const verified = { activated: true, type: 'lifetime' };
  result = { success: true, status: verified };
  const pending = ui.submit();
  assert.equal(ui.button('返回原操作').props.disabled, true);
  await ui.submit();
  await pending;
  assert.equal(calls.length, 3);
  assert.deepEqual(ui.statuses, [verified]);
  assert.equal(ui.get('textarea').props.value, '');
});

test('manual opening and copying are separate from activation and advanced records load when expanded', async () => {
  const activity = [];
  const ui = mount({
    vipActivate: () => { activity.push('activation'); },
    vipAddCopyHistory: input => { activity.push([input.kind, input.value]); },
    vipOpenSupport: (...args) => { activity.push(['support', args.length]); },
  });
  assert.equal(ui.button('返回原操作'), undefined);
  assert.equal(ui.get('ol'), undefined);
  assert.equal(ui.get('ActivationRecordsPanel'), undefined);
  ui.button('开通方式').props.onClick();
  assert.equal(ui.get('ol').props.children.length, 3);
  await ui.button('复制机器码').props.onClick();
  assert.ok(ui.button('已复制'));
  await ui.button('打开项目反馈').props.onClick();
  assert.deepEqual(ui.copied, ['test-machine']);
  assert.deepEqual(activity, [['machineId', 'test-machine'], ['support', 0]]);
  assert.deepEqual(ui.statuses, []);
  ui.button('会员记录与重签').props.onClick();
  assert.ok(ui.get('ActivationRecordsPanel'));
});

test('a verified legacy license receives an accurate message when the feature still needs full VIP', async () => {
  const legacy = { activated: true, scope: 'free', type: 'lifetime' };
  const ui = mount({ vipActivate: async () => ({ success: true, status: legacy }) }, free, () => {});
  ui.props.capability = 'ai-analysis';
  ui.change('legacy-code');
  await ui.submit();
  assert.deepEqual(ui.statuses, [legacy]);
  assert.deepEqual(ui.toasts, []);
  assert.match(label(ui.get('p', node => node.props.role === 'alert')), /未解锁当前功能/);
  assert.ok(ui.get('textarea'));
});

test('loading, expired, read failure, active and contextual cancellation each present the corresponding actions', async () => {
  let cancels = 0;
  const ui = mount({}, { reason: 'loading' }, () => { cancels++; });
  assert.equal(label(ui.get('h3')), '正在加载会员信息…');
  assert.equal(ui.get('textarea'), undefined);
  ui.button('返回原操作').props.onClick();
  assert.equal(cancels, 1);
  ui.props.vipStatus = { reason: 'expired' };
  assert.equal(label(ui.get('h3')), '会员授权已到期');
  assert.ok(ui.button('续期方式'));
  ui.props.vipStatus = { reason: 'vip_status_failed' };
  assert.equal(label(ui.get('h3')), '会员状态暂不可用');
  let retries = 0;
  ui.props.onRetry = async () => { retries++; };
  await ui.button('重试').props.onClick();
  assert.equal(retries, 1);
  ui.props.vipStatus = { activated: true, type: 'lifetime' };
  assert.equal(label(ui.get('h3')), '会员版');
  assert.ok(ui.button('查看会员权益'));
  assert.equal(ui.get('textarea'), undefined);
  ui.props.vipStatus = { activated: true, type: 'lifetime', scope: 'free' };
  assert.equal(label(ui.get('h3')), '已验证基础授权');
  assert.ok(ui.get('textarea'));
});
