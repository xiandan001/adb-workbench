import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createElement, useEffect, useId, useMemo, useRef, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'rolldown/utils';
import * as textWindow from '../src/shared/aiContextTextWindow.js';
import { workspaceLinePage } from '../src/components/AiWorkspaceState.js';
import { bringAiContext, joinAiContextRows } from '../src/shared/aiHandoff.js';

const children = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(children)];
const content = tree => typeof tree === 'string' || typeof tree === 'number' ? String(tree) : !tree || typeof tree !== 'object' ? '' : [tree.props?.children].flat(Infinity).map(content).join(' ');
const button = (h, label) => children(h.tree()).find(node => node.type === 'button' && (node.props['aria-label'] === label || content(node) === label));
const theme = { input: '', textMuted: '', button: { secondary: '' } };
const tr = (value, args = {}) => value.replace(/\{(\d+)\}/g, (whole, key) => args[key] ?? whole);
function compiled(name) {
  const source = fs.readFileSync(new URL('../src/components/' + name + '.jsx', import.meta.url), 'utf8')
    .replace(/^import .+;\r?\n/gm, '').replace('export default function', 'function').replace(/export function /g, 'function ');
  return transformSync(name + '.jsx', source, { jsx: { runtime: 'classic', pragma: 'jsx', pragmaFrag: 'Fragment' } }).code + '\n' + name;
}
function fixture(name, initial) {
  const slots = [], effects = []; let cursor = 0, changed = false, tree, props = initial;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const runtime = { ...textWindow, workspaceLinePage, tr, useLocale() {}, formatDateTime: () => 'fixture', formatNumber: String,
    ChevronLeft: 'icon', ChevronRight: 'icon', Fragment: 'fragment', setTimeout, clearTimeout, TextEncoder,
    jsx: (type, values, ...nested) => ({ type, props: { ...values, children: nested } }),
    useId: () => 'text-input', useRef(value) { const i = cursor++; return slots[i] || (slots[i] = { current: value }); },
    useState(value) { const i = cursor++; if (!slots[i]) slots[i] = { value: typeof value === 'function' ? value() : value }; const slot = slots[i]; return [slot.value, next => { const result = typeof next === 'function' ? next(slot.value) : next; if (!Object.is(result, slot.value)) { slot.value = result; changed = true; } }]; },
    useMemo(callback, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { deps, value: callback() }; return slots[i].value; },
    useEffect(callback, deps) { const i = cursor++, previous = slots[i]; if (previous && same(previous.deps, deps)) return; slots[i] = { deps, cleanup: previous?.cleanup }; effects.push(() => { slots[i].cleanup?.(); slots[i].cleanup = callback(); }); },
  };
  const component = vm.runInNewContext(compiled(name), runtime);
  const draw = () => { for (let i = 0; i < 20; i++) { cursor = 0; changed = false; tree = component(props); for (const effect of effects.splice(0)) effect(); if (!changed) break; } return tree; };
  draw();
  return { tree: draw, setProps(patch) { props = { ...props, ...patch }; draw(); }, dispose() { for (const slot of slots) slot?.cleanup?.(); } };
}
const waitFor = async predicate => { const deadline = Date.now() + 8000; while (!predicate()) { if (Date.now() > deadline) throw Error('Synthetic input did not settle'); await new Promise(resolve => setTimeout(resolve, 5)); } };

test('async handoff accepts complete >old-limit source metadata and rejects actual escaped overflow without an IPC', async () => {
  const calls = [], api = { aiHandoffCreate: async value => { calls.push(value); return { ok: true, id: 'synthetic' }; } };
  const text = '中'.repeat(300000); await bringAiContext(async () => ({ view: { origin: 'fixture', text, title: 'Synthetic' } }), api);
  assert.equal(calls.length, 1); assert.equal(calls[0].view.text, text); assert.equal(joinAiContextRows([{ raw: text }]), text);
  await assert.rejects(bringAiContext({ view: { origin: 'fixture', text: '"'.repeat(textWindow.AI_CONTEXT_BYTES / 2), title: 'Metadata counted' } }, api), /20 MiB/);
  assert.equal(calls.length, 1, 'No model or handoff IPC may receive the rejected oversized payload');
});

test('short text remains directly editable; a 20 MiB paste retains its complete value but never paints a giant field', async t => {
  const changes = []; let h;
  h = fixture('AiContextTextInput', { value: 'old', label: 'Body', onChange(value) { changes.push(value); h.setProps({ value }); } }); t.after(h.dispose);
  children(h.tree()).find(node => node.type === 'textarea').props.onChange({ target: { value: 'short edit' } }); assert.equal(changes[0], 'short edit');
  const body = 'x'.repeat(textWindow.AI_CONTEXT_BYTES), input = children(h.tree()).find(node => node.type === 'textarea');
  let prevented = false; input.props.onPaste({ preventDefault() { prevented = true; }, currentTarget: { selectionStart: 0, selectionEnd: 'short edit'.length }, clipboardData: { getData: () => body } });
  assert.equal(prevented, true); await waitFor(() => changes.length === 2);
  assert.equal(changes[1], body); assert.ok(content(h.tree()).length < 25000); assert.ok(!children(h.tree()).some(node => node.type === 'textarea'));
  button(h, '替换全部材料').props.onClick(); const replacement = children(h.tree()).find(node => node.type === 'textarea');
  replacement.props.onPaste({ preventDefault() {}, currentTarget: { selectionStart: 0, selectionEnd: 0 }, clipboardData: { getData: () => body + 'x' } });
  await waitFor(() => children(h.tree()).some(node => node.props?.role === 'alert')); assert.equal(changes.length, 2);
  assert.match(content(h.tree()), /20 MiB/); button(h, '取消替换，保留原文').props.onClick(); assert.ok(content(h.tree()).length < 25000);
});

test('late validation cannot overwrite a changed target/value or an unmounted text input', async t => {
  const changes = [], h = fixture('AiContextTextInput', { value: 'first', label: 'Body', onChange: value => changes.push(value) }); t.after(h.dispose);
  const input = children(h.tree()).find(node => node.type === 'textarea');
  input.props.onPaste({ preventDefault() {}, currentTarget: { selectionStart: 0, selectionEnd: 5 }, clipboardData: { getData: () => 'x'.repeat(textWindow.AI_CONTEXT_BYTES) } });
  h.setProps({ value: 'new target' }); h.dispose(); await new Promise(resolve => setTimeout(resolve, 1600)); assert.deepEqual(changes, []);
});

test('actual React evidence DOM is bounded for a single 20 MiB line and citation focus keeps frozen numbering', () => {
  const entry = { id: 'E1', source: 'text', label: 'Synthetic', text: '[L1] ' + 'x'.repeat(textWindow.AI_CONTEXT_BYTES - 20), numbered: true, lineCount: 1 };
  const runtime = { ...textWindow, workspaceLinePage, tr, useLocale() {}, formatDateTime: () => 'fixture', formatNumber: String,
    useEffect, useId, useMemo, useRef, useState, jsx: createElement, Fragment: 'fragment', ChevronLeft: () => null, ChevronRight: () => null };
  const Component = vm.runInNewContext(compiled('AiWorkspaceEvidenceLines'), runtime);
  const html = renderToStaticMarkup(createElement(Component, { entry, first: true, theme }));
  assert.ok(html.length < 30000); assert.match(html, /显示分页不改变/); assert.equal(entry.lineCount, 1);
  const h = fixture('AiWorkspaceEvidenceLines', { entry, first: true, theme, highlight: { evidenceId: 'E1', startLine: 1, endLine: 1, nonce: 1 } });
  const before = content(h.tree()); button(h, '下一段证据文本').props.onClick(); assert.ok(content(h.tree()).length < 30000); assert.notEqual(content(h.tree()), before);
  assert.equal(children(h.tree()).filter(node => node.props?.['data-highlight'] === 'true').length, 1); h.dispose();
});
