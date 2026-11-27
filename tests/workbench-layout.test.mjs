import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser'), traverse = require('@babel/traverse').default, postcss = require('postcss');
const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
function declaration(selector, property, media = '', file = 'src/styles/workbenchLayout.css') {
  let result;
  postcss.parse(read(file)).walkRules(rule => {
    if (!rule.selectors.includes(selector)) return;
    if ((rule.parent.type === 'atrule' ? rule.parent.params : '') !== media) return;
    rule.walkDecls(property, node => { result = node.value; });
  });
  return result;
}
test('device grids use available content width and retain original maximum columns and shrinking boundaries', () => {
  const app = read('src/App.jsx');
  assert.match(app, /import '\.\/styles\/workbenchLayout\.css'/);
  assert.match(app, /className="workbench-device-list"/);
  assert.match(app, /className="workbench-history-grid"/);
  for (const selector of ['.workbench-device-list', '.workbench-history-grid']) {
    assert.equal(declaration(selector, 'grid-template-columns'), 'minmax(0, 1fr)');
  }
  assert.match(app, /className="workbench-device-grid"/);
  assert.equal(declaration('.workbench-device-grid', 'container'), 'device-grid / inline-size');
  assert.equal(declaration('.workbench-device-list', 'grid-template-columns', 'device-grid (min-width: 1150px)'), 'repeat(2, minmax(0, 1fr))');
  assert.equal(declaration('.workbench-device-list', 'grid-template-columns', '(min-width: 1280px)'), undefined);
  assert.equal(declaration('.workbench-history-grid', 'grid-template-columns', '(min-width: 640px)'), 'repeat(2, minmax(0, 1fr))');
  assert.equal(declaration('.workbench-history-grid', 'grid-template-columns', '(min-width: 1024px)'), 'repeat(3, minmax(0, 1fr))');
  assert.equal(declaration('.workbench-device-list', 'gap'), '1.5rem');
  assert.equal(declaration('.workbench-history-grid', 'gap'), '1rem');
  assert.equal(declaration('.workbench-device-list > *', 'min-width'), '0');
  assert.equal(declaration('.workbench-history-card', 'min-width'), '0');
});
test('sidebar uses compact and rail widths while full labels may wrap and navigation scrolls independently', () => {
  const app = read('src/App.jsx');
  const sidebar = read('src/components/WorkbenchSidebar.jsx');
  const sidebarDeclaration = (selector, property) => declaration(selector, property, '', 'src/styles/workbenchSidebar.css');
  assert.match(app, /<WorkbenchSidebar\b[^>]*\blocale=\{locale\}/);
  assert.match(sidebar, /className="workbench-sidebar" data-locale=\{locale\} data-mode=\{mode\}/);
  assert.equal(sidebarDeclaration('.workbench-sidebar', 'width'), '12rem');
  assert.equal(sidebarDeclaration('.workbench-sidebar[data-mode="rail"]', 'width'), '3.5rem');
  assert.equal(sidebarDeclaration('.workbench-sidebar-nav', 'overflow-y'), 'auto');
  assert.equal(sidebarDeclaration('.workbench-sidebar-item', 'align-items'), 'center');
  assert.equal(sidebarDeclaration('.workbench-sidebar-item', 'min-height'), '2.25rem');
  assert.equal(sidebarDeclaration('.workbench-sidebar-label', 'white-space'), 'normal');
  assert.equal(sidebarDeclaration('.workbench-sidebar-label', 'min-width'), '0');
  assert.equal(sidebarDeclaration('.workbench-sidebar-item > svg', 'flex-shrink'), '0');
  assert.equal(sidebarDeclaration('.workbench-sidebar[data-mode="rail"] .workbench-sidebar-label', 'display'), 'none');
  assert.equal(declaration('.workbench-sidebar', 'width', '(min-width: 1024px)'), undefined);
});
test('center layout retains the main landmark and scopes one panel to the selected tab', () => {
  const app = read('src/App.jsx');
  assert.match(app, /<WorkbenchCenterTabs center=\{activeCenter\} activeTab=\{activeTab\} onChange=\{selectCenterLeaf\}/);
  assert.match(app, /<main ref=\{mainRef\}/);
  assert.match(app, /id=\{activeCenter \? 'workbench-center-panel' : undefined\} role=\{activeCenter \? 'tabpanel' : undefined\}/);
  assert.match(app, /aria-labelledby=\{activeCenter \? `workbench-center-tab-\$\{activeTab\}` : undefined\}/);
});
test('header selector and wireless fields keep original content proportions with safe localized wrapping', () => {
  const app = read('src/App.jsx');
  assert.doesNotMatch(app, /className="workbench-header-actions"/);
  assert.equal(declaration('.workbench-header-title', 'flex'), '1');
  assert.equal(declaration('.workbench-active-device', 'flex'), '1');
  assert.equal(declaration('.workbench-active-device', 'min-width'), '0');
  assert.equal(declaration('.workbench-wireless-form > input', 'flex'), '1');
  assert.equal(declaration('.workbench-wireless-form', 'width', '(min-width: 1280px)'), 'auto');
  assert.equal(declaration('.workbench-wireless-form', 'flex', '(min-width: 1280px)'), undefined);
  assert.match(app, /className=\{`min-w-0 flex-1 xl:w-64 /);
  assert.equal(declaration('.workbench-wireless-form', 'flex-wrap'), 'wrap');
});
test('long identifiers and translated toolbar content have shrink and wrapping boundaries', () => {
  assert.equal(declaration('.workbench-history-address', 'width'), 'fit-content');
  assert.equal(declaration('.workbench-history-address', 'max-width'), '100%');
  assert.equal(declaration('.workbench-history-address code', 'flex'), '0 1 auto');
  assert.equal(declaration('.workbench-history-address button', 'flex-shrink'), '0');
  assert.equal(declaration('.workbench-wrap-anywhere', 'overflow-wrap'), 'anywhere');
  assert.equal(declaration('.workbench-history-address code', 'overflow-wrap'), 'anywhere');
  assert.equal(declaration('.workbench-history-address code', 'user-select'), 'all');
  assert.equal(declaration('.workbench-toolbar-actions', 'flex-wrap'), 'wrap');
  assert.match(read('src/App.jsx'), /navigator\.clipboard\.writeText\(item\.ip\)/);
});
test('card-owned inspection and danger overlays portal to the viewport while retaining original action callbacks', () => {
  for (const file of ['InspectionPanel.jsx', 'DangerConfirmModal.jsx']) {
    const source = read('src/components/' + file), ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
    let portal = false;
    traverse(ast, { CallExpression({ node }) {
      if (node.callee.name === 'createPortal' && node.arguments[0]?.type === 'JSXElement'
        && node.arguments[1]?.object?.name === 'document' && node.arguments[1]?.property?.name === 'body') portal = true;
    } });
    assert.equal(portal, true, file);
  }
  assert.match(read('src/components/DangerConfirmModal.jsx'), /onClick=\{onConfirm\}/);
  assert.match(read('src/components/DangerConfirmModal.jsx'), /onClick=\{loading \? undefined : onCancel\}/);
});
test('inspection still submits the full target and original options, never a shortened display identifier', async () => {
  const source = read('src/components/InspectionPanel.jsx'), ast = parse(source, { sourceType: 'module', plugins: ['jsx'] }); let fn;
  traverse(ast, { VariableDeclarator({ node }) { if (node.id.name === 'startInspection') fn = node.init; } });
  const id = 'hdc:' + 'A'.repeat(128), calls = [];
  const fixture = { isVip: true, isVipLoading: false, isOnline: true, includeBugreport: false,
    includeAiSummary: false, device: { id, model: 'Fixture' }, inspectionPath: 'fixture-path', tr: value => value,
    setRunning() {}, setProgress() {}, setResult() {}, setError() {},
    window: { electronAPI: { inspectionStart: async value => { calls.push(value); return { ok: true }; } } } };
  const action = runInNewContext('(' + source.slice(fn.start, fn.end) + ')', fixture);
  await action(); assert.equal(calls.length, 1); assert.equal(calls[0].deviceId, id); assert.equal(calls[0].outputBaseDir, 'fixture-path');
  assert.equal(calls[0].includeAiSummary, false); assert.equal(calls[0].includeBugreport, false);
  fixture.isOnline = false;
  await action(); assert.equal(calls.length, 1);
});
test('native shortcut dialogs retain top-layer menu hosting, full targets and confirmation semantics', () => {
  assert.match(read('src/components/SelectMenu.jsx'), /triggerRef\.current\?\.closest\('dialog\[open\]'\) \|\| document\.body/);
  assert.match(read('src/components/SelectMenu.jsx'), /title=\{selected\?\.label \|\| placeholder\}/);
  assert.match(read('src/components/DeviceShortcutConfirm.jsx'), /\{request\.deviceId\}/);
  assert.match(read('src/components/DeviceShortcutConfirm.jsx'), /\{request\.command\}/);
  assert.match(read('src/components/DeviceShortcutConfirm.jsx'), /request\.resolve\(true\)/);
  assert.match(read('src/components/DeviceShortcutEditor.jsx'), /save\(normalizeDeviceShortcuts\(draft\)\)/);
  assert.match(read('src/components/DeviceShortcutEditor.jsx'), /submit\(onSave\)/);
  assert.match(read('src/components/DeviceShortcutEditor.jsx'), /submit\(onSaveShared\)/);
});
