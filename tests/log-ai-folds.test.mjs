import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'rolldown/utils';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function descendants(node) {
  if (!node || typeof node !== 'object') return [];
  return [node, ...[node.props?.children].flat(Infinity).flatMap(descendants)];
}
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : !node || typeof node !== 'object' ? '' : [node.props?.children].flat(Infinity).map(text).join(' ');
const find = (tree, predicate) => descendants(tree).find(predicate);
const button = (h, label) => find(h.tree(), node => node.type === 'button' && (node.props['aria-label'] === label || text(node).includes(label)));
function componentHarness(file, name, initialProps = {}, api = {}) {
  const source = fs.readFileSync(new URL('../src/components/' + file, import.meta.url), 'utf8').replace(/^import .+;\r?\n/gm, '').replace('export default function', 'function');
  const code = transformSync(file, source, { jsx: { runtime: 'classic', pragma: 'jsx', pragmaFrag: 'Fragment' } }).code;
  const slots = [], effects = [], calls = [], focusEvents = [], listeners = new Map(); let cursor = 0, changed = false, props = initialProps, tree, locale = 'zh-CN';
  const same = (first, second) => first && second && first.length === second.length && first.every((value, index) => Object.is(value, second[index]));
  const effect = (fn, deps) => { const index = cursor++, slot = slots[index] || (slots[index] = {}); if (deps && same(slot.deps, deps)) return; slot.deps = deps; effects.push(() => { slot.cleanup?.(); slot.cleanup = fn(); }); };
  const runtime = {
    Fragment: 'fragment', jsx: (type, values, ...children) => ({ type, props: { ...values, children } }),
    tr: (value, values = {}) => value.replace(/\{(\d+)\}/g, (whole, index) => values[index] ?? whole), useLocale: () => locale,
    useState(value) { const index = cursor++; if (!slots[index]) { const slot = { value: typeof value === 'function' ? value() : value }; slot.set = update => { const next = typeof update === 'function' ? update(slot.value) : update; if (!Object.is(next, slot.value)) { slot.value = next; changed = true; } }; slots[index] = slot; } return [slots[index].value, slots[index].set]; },
    useRef(value) { const index = cursor++; return slots[index] || (slots[index] = { current: value }); },
    useId() { const index = cursor++; return slots[index] || (slots[index] = 'fold-' + index); },
    useCallback(fn, deps) { const index = cursor++, slot = slots[index]; if (slot && same(slot.deps, deps)) return slot.fn; slots[index] = { fn, deps }; return fn; },
    useEffect: effect,
    createPortal: (children, target) => ({ type: 'portal', props: { target, children } }),
    AlertTriangle: 'icon', ChevronLeft: 'icon', ChevronRight: 'icon', ChevronDown: 'icon', Loader2: 'icon', Send: 'icon', X: 'icon',
    window: { electronAPI: new Proxy({}, { get(_target, method) {
      if (method === 'onAiOutboundChanged') return callback => { listeners.set(method, callback); return () => listeners.delete(method); };
      if (!Object.hasOwn(api, method)) return undefined;
      return (...args) => { calls.push({ method, args }); return api[method](...args); };
    } }) },
  };
  const component = vm.runInNewContext(code + '\n' + name, runtime);
  function render() {
    cursor = 0; tree = component(props);
    for (const node of descendants(tree)) if (node.type === 'dialog' && node.props.ref && !node.props.ref.current) node.props.ref.current = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
    for (const node of descendants(tree)) if (node.type === 'button' && node.props.ref && !node.props.ref.current) node.props.ref.current = { focus: options => focusEvents.push({ text: text(node), options }) };
    return tree;
  }
  async function drain() { for (let index = 0; index < 20; index++) { changed = false; render(); for (const run of effects.splice(0)) run(); await tick(); if (!changed && !effects.length) { render(); return; } } throw Error('Fold fixture did not settle'); }
  return { calls, focusEvents, render, drain, tree: () => tree, setProps(value) { props = { ...props, ...value }; }, setLocale(value) { locale = value; }, refresh: () => listeners.get('onAiOutboundChanged')?.(),
    dispose() { for (const slot of slots) slot?.cleanup?.(); } };
}
const scope = Object.freeze({ label: 'A.log', retainedEntries: 2, totalEntries: 20, retainedLines: 4, bytes: 2048, partial: true, omittedOversized: 1 });
test('actual scope disclosure preserves its frozen summary and partial warning while hiding only explanations', async t => {
  const h = componentHarness('LogInlineAnalysisScope.jsx', 'LogInlineAnalysisScope', { scope }); t.after(h.dispose); await h.drain();
  assert.match(text(h.tree()), /2\/20/); assert.match(text(h.tree()), /只分析以上局部范围/); assert.doesNotMatch(text(h.tree()), /最终以完整发送确认预览为准/);
  const toggle = button(h, '范围说明'); assert.ok(toggle); assert.equal(toggle.props.type, 'button'); assert.equal(toggle.props['aria-expanded'], false); assert.ok(toggle.props['aria-controls']);
  assert.equal(find(h.tree(), node => node.props?.id === toggle.props['aria-controls']).props.hidden, true);
  toggle.props.onClick(); await h.drain(); assert.equal(button(h, '范围说明').props['aria-expanded'], true); assert.match(text(h.tree()), /最终以完整发送确认预览为准/); assert.match(text(h.tree()), /1 条记录因单条超出/);
  button(h, '范围说明').props.onClick(); await h.drain(); assert.equal(button(h, '范围说明').props['aria-expanded'], false); assert.match(text(h.tree()), /2\/20/); assert.match(text(h.tree()), /只分析以上局部范围/); assert.deepEqual(h.calls, []);
});
test('controlled scope preference survives stream and locale refresh without expanding or running a query', async t => {
  let saved = true; const writes = []; let h;
  h = componentHarness('LogInlineAnalysisScope.jsx', 'LogInlineAnalysisScope', { scope, expanded: saved, onExpandedChange(value) { saved = value; writes.push(value); h.setProps({ expanded: value }); } }); t.after(h.dispose); await h.drain();
  assert.equal(button(h, '范围说明')?.props['aria-expanded'], true); button(h, '范围说明').props.onClick(); await h.drain(); assert.deepEqual(writes, [false]);
  h.setProps({ scope: { ...scope } }); h.setLocale('ja-JP'); await h.drain(); assert.equal(button(h, '范围说明').props['aria-expanded'], false); assert.deepEqual(h.calls, []);
  const restarted = componentHarness('LogInlineAnalysisScope.jsx', 'LogInlineAnalysisScope', { scope, expanded: saved }); t.after(restarted.dispose); await restarted.drain(); assert.equal(button(restarted, '范围说明').props['aria-expanded'], false);
});
function outboundFixture(props = {}) {
  let pending = [{ id: 'preview-1', title: 'Frozen batch', requestCount: 2, bytes: 200, estimatedInputTokens: 30, redactions: 0 }];
  const operations = [{ id: 'op-1', title: 'Analysis', stage: 'map', status: 'running', usage: {} }];
  const h = componentHarness('AiOutboundPreviewHost.jsx', 'AiOutboundPreviewHost', props, {
    aiOutboundList: async () => ({ ok: true, pending, operations }),
    aiOutboundGet: async ({ index }) => ({ ok: true, preview: { id: 'preview-1', selectedRequest: { bytes: 100, parameters: { stream: true, thinking: false }, messages: [{ role: 'user', content: 'exact frozen request ' + index }] } } }),
    aiOutboundDecide: async () => { pending = []; return { ok: true }; },
  }); return h;
}
test('actual usage view docks in normal flow, retains a fallback and leaves the main app floating default compatible', async t => {
  const target = { id: 'composer-slot' }, h = outboundFixture({ usagePlacement: 'inline', usageTarget: target }); t.after(h.dispose); await h.drain();
  const portal = find(h.tree(), node => node.type === 'portal'); assert.equal(portal?.props.target, target);
  assert.doesNotMatch(find(h.tree(), node => node.type === 'aside').props.className, /\bfixed\b/);
  assert.match(find(h.tree(), node => node.type === 'aside').props.className, /min-h-0/);
  assert.equal(button(h, 'AI 发送与用量').props['aria-expanded'], false); button(h, 'AI 发送与用量').props.onClick(); await h.drain(); assert.equal(button(h, 'AI 发送与用量').props['aria-expanded'], true);
  button(h, '收起 AI 发送与用量').props.onClick(); await h.drain(); h.setProps({ usageTarget: null }); await h.drain(); assert.equal(find(h.tree(), node => node.type === 'portal'), undefined); assert.doesNotMatch(find(h.tree(), node => node.type === 'aside').props.className, /\bfixed\b/);
  assert.equal(h.focusEvents.length, 1); assert.match(h.focusEvents[0].text, /AI 发送与用量/); assert.equal(h.focusEvents[0].options.preventScroll, true);
  const legacy = outboundFixture(); t.after(legacy.dispose); await legacy.drain(); assert.match(find(legacy.tree(), node => node.type === 'aside').props.className, /\bfixed\b/);
});
test('usage folding, docking, fullscreen targets and refresh never reset explicit preview visits or authorize a send', async t => {
  let h; const writes = []; h = outboundFixture({ usagePlacement: 'inline', usageTarget: { id: 'panel' }, usageExpanded: false, onUsageExpandedChange(value) { writes.push(value); h.setProps({ usageExpanded: value }); } }); t.after(h.dispose); await h.drain();
  const send = () => button(h, '明确发送本批次'), checkbox = () => find(h.tree(), node => node.type === 'input' && node.props.type === 'checkbox');
  await send().props.onClick(); await h.drain(); assert.equal(h.calls.filter(call => call.method === 'aiOutboundDecide').length, 0); assert.equal(checkbox().props.disabled, true);
  button(h, '下一个请求').props.onClick(); await h.drain(); assert.equal(checkbox().props.disabled, false); checkbox().props.onChange({ target: { checked: true } }); await h.drain(); assert.equal(send().props.disabled, false);
  button(h, 'AI 发送与用量').props.onClick(); await h.drain(); button(h, '收起 AI 发送与用量').props.onClick(); await h.drain();
  for (const usageTarget of [{ id: 'fullscreen' }, null, { id: 'reopened-panel' }]) { h.setProps({ usageTarget }); h.setLocale('ko-KR'); await h.refresh(); await h.drain(); assert.equal(checkbox().props.checked, true); assert.equal(send().props.disabled, false); }
  assert.deepEqual(writes, [true, false]); assert.equal(h.calls.filter(call => call.method === 'aiOutboundGet').length, 2); assert.equal(h.calls.filter(call => call.method === 'aiOutboundDecide').length, 0); assert.equal(button(h, 'AI 发送与用量').props['aria-expanded'], false);
  await send().props.onClick(); await h.drain(); const decisions = h.calls.filter(call => call.method === 'aiOutboundDecide'); assert.equal(decisions.length, 1); assert.equal(decisions[0].args[0].decision, 'send'); assert.equal(decisions[0].args[0].previewId, 'preview-1');
});
test('actual log-window props persist only fold flags and keep exactly one consent host plus an in-flow slot', () => {
  const source = fs.readFileSync(new URL('../src/components/LogAnalyzer.jsx', import.meta.url), 'utf8'), nodes = [];
  traverseModule.default(parse(source, { sourceType: 'module', plugins: ['jsx'] }), { JSXOpeningElement({ node }) { if (['LogInlineAnalysisScope', 'AiOutboundPreviewHost'].includes(node.name.name)) nodes.push(node); } });
  const scopeNode = nodes.find(node => node.name.name === 'LogInlineAnalysisScope'), hosts = nodes.filter(node => node.name.name === 'AiOutboundPreviewHost'); assert.equal(hosts.length, 1);
  const expression = (node, name) => { const attribute = node.attributes.find(item => item.name?.name === name); assert.ok(attribute, name); return source.slice(attribute.value.expression.start, attribute.value.expression.end); };
  const writes = [], context = { setViewField: (key, value) => writes.push({ key, value }) };
  vm.runInNewContext('(' + expression(scopeNode, 'onExpandedChange') + ')', context)(false); vm.runInNewContext('(' + expression(hosts[0], 'onUsageExpandedChange') + ')', context)(true);
  assert.deepEqual(writes, [{ key: 'scopeExpanded', value: false }, { key: 'usageExpanded', value: true }]); assert.match(expression(scopeNode, 'expanded'), /viewPreferences.view.scopeExpanded/); assert.match(expression(hosts[0], 'usageExpanded'), /viewPreferences.view.usageExpanded/);
  assert.match(source, /ref=\{setUsageTarget\} className="[^"]*max-h-\[40%\][^"]*overflow-hidden/); assert.ok(source.indexOf('ref={setUsageTarget}') > source.indexOf('{/* AI Input Bar */}'));
  assert.ok(source.indexOf('<LogInlineAnalysisScope') > source.indexOf('{/* AI Content Area */}'), 'Explanations must share the scrollable analysis area, not force the composer below a 240px pane');
});
