import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser'), traverse = require('@babel/traverse').default, postcss = require('postcss');
const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
function declaration(selector, property) {
  let result;
  postcss.parse(read('src/styles/workbenchLayout.css')).walkRules(selector, rule => {
    rule.walkDecls(property, node => { result = node.value; });
  });
  return result;
}
test('device and history grids size against their content area instead of viewport column jumps', () => {
  const app = read('src/App.jsx');
  assert.match(app, /import '\.\/styles\/workbenchLayout\.css'/);
  assert.match(app, /className="workbench-device-list"/);
  assert.match(app, /className="workbench-history-grid"/);
  assert.equal(declaration('.workbench-device-list', 'grid-template-columns'), 'repeat(auto-fit, minmax(min(100%, 35rem), 1fr))');
  assert.equal(declaration('.workbench-device-list', 'align-items'), 'start');
  assert.equal(declaration('.workbench-history-grid', 'grid-template-columns'), 'repeat(auto-fit, minmax(min(100%, 20rem), 1fr))');
});
test('sidebar translations wrap normally with fixed icons rather than a Japanese-only width exception', () => {
  const app = read('src/App.jsx');
  assert.doesNotMatch(app, /locale === 'ja-JP' \? 'w-72'/);
  assert.equal(declaration('.workbench-sidebar-nav > button > span', 'white-space'), 'normal');
  assert.equal(declaration('.workbench-sidebar-nav > button > span', 'min-width'), '0');
  assert.equal(declaration('.workbench-sidebar-nav > button > svg', 'flex-shrink'), '0');
});
test('long identifiers and translated toolbar content have shrink and wrapping boundaries', () => {
  assert.equal(declaration('.workbench-wrap-anywhere', 'overflow-wrap'), 'anywhere');
  assert.equal(declaration('.workbench-history-address code', 'overflow-wrap'), 'anywhere');
  assert.equal(declaration('.workbench-history-address code', 'user-select'), 'all');
  assert.equal(declaration('.workbench-header-actions', 'flex-wrap'), 'wrap');
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
  const action = runInNewContext('(' + source.slice(fn.start, fn.end) + ')', { isVip: true, isVipLoading: false, includeBugreport: false,
    includeAiSummary: false, device: { id, model: 'Fixture' }, inspectionPath: 'fixture-path', tr: value => value,
    setRunning() {}, setProgress() {}, setResult() {}, setError() {},
    window: { electronAPI: { inspectionStart: async value => { calls.push(value); return { ok: true }; } } } });
  await action(); assert.equal(calls.length, 1); assert.equal(calls[0].deviceId, id); assert.equal(calls[0].outputBaseDir, 'fixture-path');
  assert.equal(calls[0].includeAiSummary, false); assert.equal(calls[0].includeBugreport, false);
});
test('native shortcut dialogs retain top-layer menu hosting, full targets and confirmation semantics', () => {
  assert.match(read('src/components/SelectMenu.jsx'), /triggerRef\.current\?\.closest\('dialog\[open\]'\) \|\| document\.body/);
  assert.match(read('src/components/SelectMenu.jsx'), /title=\{selected\?\.label \|\| placeholder\}/);
  assert.match(read('src/components/DeviceShortcutConfirm.jsx'), /\{request\.deviceId\}/);
  assert.match(read('src/components/DeviceShortcutConfirm.jsx'), /\{request\.command\}/);
  assert.match(read('src/components/DeviceShortcutConfirm.jsx'), /request\.resolve\(true\)/);
  assert.match(read('src/components/DeviceShortcutEditor.jsx'), /onSave\(normalizeDeviceShortcuts\(draft\)\)/);
});
