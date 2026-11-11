import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { trapAppMessageFocus } from '../src/shared/appMessageDialog.js';
const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser'), traverse = require('@babel/traverse').default;
const source = readFileSync(new URL('../src/components/DangerConfirmModal.jsx', import.meta.url), 'utf8');
const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
function sourceFunction(kind, context) {
  let target;
  traverse(ast, {
    CallExpression({ node }) {
      if (kind === 'focus' && node.callee.name === 'useEffect' && source.slice(node.start, node.end).includes('requestAnimationFrame')) target = node.arguments[0];
      if (kind === 'loading' && node.callee.name === 'useEffect' && source.slice(node.start, node.end).includes('loading')) target = node.arguments[0];
    },
    JSXAttribute({ node }) { if (kind === 'key' && node.name.name === 'onKeyDown') target = node.value.expression; }
  });
  assert.ok(target, `missing ${kind} boundary`);
  return runInNewContext('(' + source.slice(target.start, target.end) + ')', { trapAppMessageFocus, ...context });
}
function fixture(disabled = false) {
  const document = { activeElement: null }, focused = [], cancelled = [];
  const node = name => ({ name, disabled, tabIndex: 0, isConnected: true, getClientRects: () => [1], focus(options) { focused.push({ name, preventScroll: options?.preventScroll }); document.activeElement = this; } });
  const previous = node('terminal-root'), cancel = node('cancel'), confirm = node('confirm'), panel = node('dialog');
  panel.ownerDocument = document; panel.contains = value => [panel, cancel, confirm].includes(value); panel.querySelectorAll = () => [cancel, confirm];
  document.activeElement = previous;
  let animation;
  const context = { open: true, loading: disabled, document, cancelRef: { current: cancel }, dialogRef: { current: panel },
    requestAnimationFrame(callback) { animation = callback; return 1; }, cancelAnimationFrame: id => cancelled.push(id) };
  return { context, previous, cancel, confirm, panel, focused, cancelled, frame: () => animation() };
}
test('opening danger confirmation focuses safe Cancel and closing restores the originating terminal control', () => {
  const f = fixture(); const cleanup = sourceFunction('focus', f.context)(); f.frame();
  assert.equal(f.context.document.activeElement, f.cancel); cleanup();
  assert.equal(f.context.document.activeElement, f.previous); assert.deepEqual(f.cancelled, [1]);
  assert.ok(f.focused.every(item => item.preventScroll === true));
});
test('loading keeps keyboard focus in the dialog and disconnected return targets are not focused', () => {
  const f = fixture(true); const cleanup = sourceFunction('focus', f.context)(); f.frame();
  assert.equal(f.context.document.activeElement, f.panel);
  f.context.document.activeElement = f.previous; sourceFunction('loading', f.context)();
  assert.equal(f.context.document.activeElement, f.panel);
  f.previous.isConnected = false; const count = f.focused.length; cleanup(); assert.equal(f.focused.length, count);
});

test('failed confirmation restores safe Cancel focus after loading so Shift+Tab cannot leave the warning', () => {
  const f = fixture(true);
  sourceFunction('loading', f.context)();
  assert.equal(f.context.document.activeElement, f.panel);
  f.context.loading = false; f.cancel.disabled = false; f.confirm.disabled = false;
  sourceFunction('loading', f.context)();
  assert.equal(f.context.document.activeElement, f.cancel);
  let prevented = 0;
  sourceFunction('key', { loading: false })({ key: 'Tab', currentTarget: f.panel, shiftKey: true, preventDefault() { prevented++; } });
  assert.equal(prevented, 1); assert.equal(f.context.document.activeElement, f.confirm);
  sourceFunction('loading', f.context)();
  assert.equal(f.context.document.activeElement, f.confirm, 'already-focused controls retain focus');
});
test('Escape cancels only the warning and loading blocks cancel; Tab remains in its own dialog', () => {
  for (const loading of [false, true]) {
    const f = fixture(loading); let cancellations = 0, prevented = 0, stopped = 0;
    const handler = sourceFunction('key', { loading, onCancel: () => cancellations++ });
    handler({ key: 'Escape', preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
    assert.equal(cancellations, loading ? 0 : 1); assert.equal(prevented, 1); assert.equal(stopped, 1);
    f.context.document.activeElement = loading ? f.panel : f.confirm;
    handler({ key: 'Tab', currentTarget: f.panel, shiftKey: false, preventDefault() { prevented++; } });
    assert.equal(f.context.document.activeElement, loading ? f.panel : f.cancel);
  }
});
test('danger overlay exposes its dialog label without changing confirm or remember callbacks', () => {
  assert.match(source, /role="dialog"/); assert.match(source, /aria-modal="true"/); assert.match(source, /aria-labelledby=\{titleId\}/);
  assert.match(source, /onClick=\{onConfirm\}/); assert.match(source, /onRememberChoiceChange\(event\.target\.checked\)/);
});
