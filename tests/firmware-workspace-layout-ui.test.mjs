import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'rolldown/utils';
import { button, nodes, text } from './helpers/firmware-direct-ui-harness.mjs';

const source = readFileSync(new URL('../src/components/FirmwareWorkspace.jsx', import.meta.url), 'utf8')
  .replace(/^import .+;\n/gm, '').replace('export default function', 'function');
const code = transformSync('FirmwareWorkspace.jsx', source, { jsx: { runtime: 'classic', pragma: 'jsx' } }).code;
const jsx = (type, props, ...children) => typeof type === 'function'
  ? type({ ...props, children }) : { type, props: { ...props, children } };
const theme = { input: '', card: '', text: '', textMuted: '', button: { primary: '', secondary: '' } };
const icons = Object.fromEntries('CheckCircle2 ChevronDown Copy Download ExternalLink FileSearch Loader2 Plug RefreshCw Usb'.split(' ').map(name => [name, 'icon']));

function renderWorkspace(view, direct) {
  const render = runInNewContext(`(function(){${code};return FirmwareWorkspace;})()`, {
    ...icons, jsx, createElement: jsx, tr: label => label, useLocale() {}, isDarkTheme: () => false, formatBytes: String,
    useFirmwareWorkspace: () => ({ platform: 'rk', status: { state: 'installed' }, ...view }),
    useFirmwareDirect: () => direct,
    firmwareDriverAction: () => view.driverAction ?? null,
    FirmwareDirectPanel: 'direct-panel',
    DangerConfirmModal: 'confirm-modal',
  });
  return render({ theme });
}

test('firmware and the direct workflow precede collapsed tools while startup restoration stays interruptible', () => {
  const actions = [];
  const tree = renderWorkspace({ restoringFile: true, act: action => actions.push(action) }, { enabled: true });
  const order = nodes(tree);
  const preflight = order.findIndex(node => node.props['aria-labelledby'] === 'firmware-preflight-title');
  const direct = order.findIndex(node => node.type === 'direct-panel');
  const tools = order.findIndex(node => node.type === 'details' && /工具、驱动与厂商工具/.test(text(node)));
  assert.ok(preflight >= 0 && preflight < direct && direct < tools);
  assert.equal(order[tools].props.open, false);
  assert.match(text(tree), /正在恢复上次固件…/);
  const choose = button(tree, '选择固件');
  assert.equal(choose.props.disabled, false);
  choose.props.onClick();
  assert.deepEqual(actions, ['file']);
});

test('restored firmware is ready to replace and vendor fallback is expanded if direct flashing is unavailable', () => {
  const file = { ok: true, fileName: 'update.img', firmwareId: 'fresh-receipt' };
  const tree = renderWorkspace({ file }, { enabled: false });
  const order = nodes(tree);
  assert.equal(order.find(node => node.type === 'direct-panel').props.file.firmwareId, 'fresh-receipt');
  assert.ok(button(tree, '更换固件'));
  assert.equal(order.find(node => node.type === 'details').props.open, true);
  assert.ok(button(tree, '打开厂商工具'));
});

test('a passed structural check is described separately from direct content admission', () => {
  const tree = renderWorkspace({ file: { ok: true, fileName: 'flash.xml', firmwareId: 'receipt' } }, { enabled: true });
  const preflight = nodes(tree).find(node => node.props['aria-labelledby'] === 'firmware-preflight-title');
  assert.match(text(preflight), /固件结构检查通过/);
  assert.match(text(preflight), /应用内直刷还需校验整包内容/);

  const invalid = renderWorkspace({ file: { ok: false, fileName: 'flash.xml', code: 'missing-files' } }, { enabled: true });
  assert.match(text(invalid), /部分依赖文件缺失或不可用/);
  assert.doesNotMatch(text(invalid), /应用内直刷还需校验整包内容/);
});

test('manual tools visibility overrides the automatic fallback and the summary uses one controlled toggle', () => {
  for (const [expanded, direct] of [[true, { enabled: true }], [false, { enabled: false, unavailable: true }]]) {
    const calls = [];
    const tree = renderWorkspace({ supportExpanded: expanded, setSupportExpanded: value => calls.push(value) }, direct);
    const tools = nodes(tree).find(node => node.type === 'details' && /工具、驱动与厂商工具/.test(text(node)));
    assert.equal(tools.props.open, expanded);
    const summary = nodes(tools).find(node => node.type === 'summary');
    let prevented = false;
    summary.props.onClick({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.deepEqual(calls, [!expanded]);
  }
});

test('the active flash can use its own entry action while other workspace operations are locked', () => {
  const own = renderWorkspace({}, { enabled: true, globalBusy: true, running: true });
  assert.equal(nodes(own).find(node => node.type === 'direct-panel').props.blocked, false);
  assert.equal(button(own, '选择固件').props.disabled, true);
  const other = renderWorkspace({}, { enabled: true, globalBusy: true, running: false });
  assert.equal(nodes(other).find(node => node.type === 'direct-panel').props.blocked, true);
});

test('driver confirmation hands off to a locked inline installation state', () => {
  const actions = [];
  const view = { platform: 'mtk', driverAction: 'reinstall', confirm: true, supportExpanded: true, act: action => actions.push(action) };
  const initial = renderWorkspace(view, { enabled: true });
  const modal = nodes(initial).find(node => node.type === 'confirm-modal');
  assert.equal(modal.props.open, true);
  assert.equal(modal.props.confirmLabel, '重新安装驱动');
  assert.equal(nodes(initial).find(node => node.type === 'direct-panel').props.blocked, true);
  modal.props.onConfirm();
  assert.deepEqual(actions, ['install']);

  const installing = renderWorkspace({ ...view, confirm: false, busy: 'install' }, { enabled: true });
  assert.equal(nodes(installing).find(node => node.type === 'confirm-modal').props.open, false);
  assert.equal(button(installing, '正在安装驱动…').props.disabled, true);
  assert.equal(nodes(installing).find(node => node.type === 'direct-panel').props.blocked, true);
  assert.equal(button(installing, '打开厂商工具').props.disabled, true);
});
