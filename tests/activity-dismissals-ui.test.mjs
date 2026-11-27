import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { transformSync } from 'rolldown/utils';
import * as helpers from '../src/shared/activityDismissals.js';
import { activityPresentation } from '../src/shared/activityPresentation.js';

const pause = () => new Promise(resolve => setTimeout(resolve, 0));
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
const text = tree => typeof tree === 'string' || typeof tree === 'number' ? String(tree) : !tree || typeof tree !== 'object' ? '' : [tree.props?.children].flat(Infinity).map(text).join(' ');
const button = (h, label) => nodes(h.tree()).find(node => node.type === 'button' && (node.props['aria-label'] === label || text(node).trim() === label || label === '后台活动' && text(node).includes(label)));
const theme = { card: '', text: '', textMuted: '', input: '', button: { primary: '', secondary: '' } };
function environment({ registry = [], activeTasks = [], history = [], activeGuards = [], guards = [], recordings = [], legacy = [], values = new Map(), hashFailure = false } = {}) {
  const writes = [], forbidden = [], subscribers = new Map(), focus = [], timers = new Set();
  const storage = { fail: false, getItem: key => values.get(key) ?? null, setItem(key, value) { if (this.fail) throw Error('quota'); writes.push({ key, value }); values.set(key, value); } };
  const document = { body: {}, activeElement: null }; document.activeElement = document.body;
  let cursor = 0, changed = true, tree, effects = [], props = { theme, tasks: legacy, onOpen: () => forbidden.push('navigate') }; const slots = [], elements = new Map();
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const subscribe = name => callback => { subscribers.set(name, callback); return () => subscribers.delete(name); };
  const runtime = { console, document, activityPresentation, ...helpers, running: helpers.activityRunning, crypto: webcrypto, SidebarConnectionStatus: 'SidebarConnectionStatus', WorkbenchSidebarButton: 'SidebarTrigger',
    readActivityDismissals: () => helpers.readActivityDismissals(storage), recordActivityDismissals: rows => helpers.recordActivityDismissals(rows, storage), prepareActivityItems: (rows, tracker) => hashFailure ? Promise.reject(Error('Synthetic hash failure')) : helpers.prepareActivityItems(rows, tracker, webcrypto),
    tr: (value, args = {}) => value.replace(/\{(\d+)\}/g, (all, key) => args[key] ?? all), useLocale: () => 'zh-CN',
    jsx: (type, props, ...children) => type === 'SidebarTrigger'
      ? { type: 'button', props: { ...props, 'aria-label': props.label, children } } : { type, props: { ...props, children } },
    window: { electronAPI: { workbenchActivityList: async () => ({ items: registry, olderCount: 7 }), taskState: async () => ({ activeTasks, history }), deviceGuardState: async () => ({ activeGuards, history: guards }), recordingSessionsList: async () => ({ sessions: recordings }),
      onWorkbenchActivity: subscribe('registry'), onTaskCenterUpdate: subscribe('tasks'), onDeviceGuardUpdate: subscribe('guards'), onRecordingState: subscribe('recordings'),
      workbenchActivityCancel: async value => { forbidden.push({ method: 'cancel', value }); return { ok: true }; }, workbenchActivityDismiss: async () => { forbidden.push('backend-dismiss'); return { ok: true }; }, serialConnect: () => forbidden.push('connect'), artifactsDelete: () => forbidden.push('delete') } },
    useState(initial) { const index = cursor++; if (!slots[index]) { const slot = { value: typeof initial === 'function' ? initial() : initial }; slot.set = update => { slot.value = typeof update === 'function' ? update(slot.value) : update; changed = true; }; slots[index] = slot; } return [slots[index].value, slots[index].set]; },
    useRef(value) { const index = cursor++; return slots[index] || (slots[index] = { current: value }); },
    useMemo(callback, deps) { const index = cursor++, previous = slots[index]; if (previous && same(previous.deps, deps)) return previous.value; const value = callback(); slots[index] = { deps, value }; return value; },
    useEffect(callback, deps) { const index = cursor++, previous = slots[index] || (slots[index] = {}); if (same(previous.deps, deps)) return; previous.deps = deps; effects.push(() => { previous.cleanup?.(); previous.cleanup = callback(); }); },
    setInterval(callback, delay) { const id = setInterval(callback, delay); timers.add(id); return id; }, clearInterval,
    requestAnimationFrame(callback) { const id = setTimeout(() => callback(0), 0); timers.add(id); return id; }, cancelAnimationFrame: clearTimeout,
  };
  for (const name of ['Activity', 'CheckCircle2', 'CircleAlert', 'Loader2', 'Square', 'X']) runtime[name] = 'icon';
  const source = fs.readFileSync(new URL('../src/components/WorkbenchActivity.jsx', import.meta.url), 'utf8').replace(/^import .+;\r?\n/gm, '').replace('export default function', 'function');
  const Component = vm.runInNewContext('(function(){' + transformSync('WorkbenchActivity.jsx', source, { jsx: { runtime: 'classic', pragma: 'jsx' } }).code + ';return WorkbenchActivity;})()', runtime);
  const render = () => { cursor = 0; const previousElements = new Set(elements.values()); tree = Component(props); for (const node of nodes(tree)) if (node.props.ref) { const ref = node.props.ref; if (!ref.current) { const element = { isConnected: true, focus() { document.activeElement = element; focus.push(node.props['aria-label'] || text(node)); }, showModal() { this.open = true; }, close() { this.open = false; }, contains(element) { return [...elements.values()].includes(element); } }; ref.current = element; elements.set(ref, element); } previousElements.delete(ref.current); } for (const value of previousElements) { value.isConnected = false; if (document.activeElement === value) document.activeElement = document.body; } };
  const drain = async () => { for (let index = 0; index < 40; index++) { changed = false; render(); for (const effect of effects.splice(0)) effect(); await pause(); if (!changed) { await pause(); if (!changed) return; } } throw Error('Activity fixture did not settle'); };
  return { tree: () => tree, drain, storage, values, writes, forbidden, document, focus, emit(name, value) { subscribers.get(name)?.(value); }, setProps(next) { props = { ...props, ...next }; }, dispose() { for (const slot of slots) slot?.cleanup?.(); for (const timer of timers) { clearTimeout(timer); clearInterval(timer); } } };
}
const rows = h => nodes(h.tree()).filter(node => node.props?.['data-activity-id']);

test('the icon-only background activity trigger retains its accessible label and opens the original panel', async t => {
  const evidence = environment({ history: [{ id: 'fixture', scriptName: 'Fixture task', status: 'success', startedAt: 1, endedAt: 2 }] });
  t.after(evidence.dispose);
  evidence.setProps({ rail: true });
  await evidence.drain();
  const trigger = nodes(evidence.tree()).find(node => node.type === 'button' && node.props['aria-label']?.startsWith('后台活动 · '));
  assert.ok(trigger);
  assert.equal(trigger.props.showHint, true);
  trigger.props.onClick();
  await evidence.drain();
  assert.equal(rows(evidence).length, 1);
  assert.deepEqual(evidence.forbidden, []);
});

test('actual custom dialog clear-all removes every ended source including below the visible cap, without cancelling active or late work', async t => {
  const e = environment({ history: Array.from({ length: 90 }, (_, index) => ({ id: 'done-' + index, scriptName: 'Ended ' + index, status: 'success', startedAt: 1, endedAt: 10 + index })), activeTasks: [{ id: 'active', scriptName: 'Active unknown', status: 'future-active', startedAt: 200 }] }); t.after(e.dispose); await e.drain();
  button(e, '后台活动').props.onClick(); await e.drain(); const clear = button(e, '清除已结束记录'); assert.ok(clear); assert.equal(clear.props.disabled, false); assert.equal(rows(e).length, 60);
  e.document.activeElement = e.document.body; await clear.props.onClick(); await e.drain(); assert.equal(rows(e).length, 1); assert.match(text(e.tree()), /Active unknown/); assert.equal(helpers.readActivityDismissals(e.storage).entries.length, 90); assert.deepEqual(e.forbidden, []); assert.notEqual(e.document.activeElement, e.document.body);
  e.emit('tasks', { activeTasks: [], history: [{ id: 'active', scriptName: 'Late completion', status: 'success', startedAt: 200, endedAt: 300 }] }); await e.drain(); assert.equal(rows(e).length, 1); assert.match(text(e.tree()), /Late completion/); assert.deepEqual(e.forbidden, []);
});

test('actual single-remove saves before hiding; quota/corrupt failures retain rows and reload keeps successful removals', async t => {
  const input = { guards: [{ id: 'g', status: 'unknown-old', startedAt: 1, endedAt: 2 }], recordings: [{ id: 'r', status: 'saved', startedAt: 1, endedAt: 3 }], legacy: [{ id: 'legacy', key: 'inspection', tab: 'devices', title: 'Legacy', status: 'success', startedAt: 1, endedAt: 4 }] };
  const e = environment(input); t.after(e.dispose); await e.drain(); button(e, '后台活动').props.onClick(); await e.drain(); assert.equal(rows(e).length, 3); assert.equal(nodes(e.tree()).filter(node => node.type === 'button' && node.props['aria-label'] === '移除活动记录').length, 3);
  e.storage.fail = true; await button(e, '移除活动记录').props.onClick(); await e.drain(); assert.equal(rows(e).length, 3); assert.match(text(e.tree()), /未能移除/); assert.equal(e.writes.length, 0);
  e.storage.fail = false; await button(e, '移除活动记录').props.onClick(); await e.drain(); assert.equal(rows(e).length, 2); assert.equal(e.writes.length, 1); assert.deepEqual(e.forbidden, []);
  const reloaded = environment({ ...input, values: e.values }); t.after(reloaded.dispose); await reloaded.drain(); assert.equal(rows(reloaded).length, 2);
  e.values.set(helpers.ACTIVITY_DISMISSALS_KEY, '{corrupt'); await button(e, '移除活动记录').props.onClick(); await e.drain(); assert.equal(rows(e).length, 2); assert.equal(e.values.get(helpers.ACTIVITY_DISMISSALS_KEY), '{corrupt');
});

test('a stale remove callback cannot hide a row that has become authoritative active before React commits', async t => {
  const e = environment({ history: [{ id: 'reuse', scriptName: 'Old run', status: 'success', endedAt: 2 }] }); t.after(e.dispose); await e.drain(); button(e, '后台活动').props.onClick(); await e.drain(); const remove = button(e, '移除活动记录'); assert.ok(remove);
  e.emit('tasks', { activeTasks: [{ id: 'reuse', scriptName: 'New active', status: 'new-active-status', startedAt: 3 }], history: [] }); await remove.props.onClick(); await e.drain(); assert.equal(rows(e).length, 1); assert.match(text(e.tree()), /New active/); assert.equal(e.writes.length, 0); assert.deepEqual(e.forbidden, []);
});

test('actual registry/external aliases stay removed after source polls while explicit cancellation remains unchanged', async t => {
  const ended = { id: 'registry-t', kind: 'task', title: 'Task alias', status: 'completed', startedAt: 1, updatedAt: 4, target: { page: 'tasks', id: 't' } };
  const active = { id: 'live-registry', kind: 'ai', title: 'Live analysis', status: 'running', startedAt: 5, canCancel: true, target: { page: 'ai-workspace', id: 'case' } };
  const e = environment({ registry: [ended, active], history: [{ id: 't', status: 'success', startedAt: 2, endedAt: 3 }] }); t.after(e.dispose); await e.drain(); button(e, '后台活动').props.onClick(); await e.drain(); assert.equal(rows(e).length, 2);
  await button(e, '移除活动记录').props.onClick(); await e.drain(); assert.equal(rows(e).length, 1); assert.deepEqual(e.forbidden, []);
  e.emit('registry', { items: [], olderCount: 12 }); e.emit('tasks', { activeTasks: [], history: [{ id: 't', status: 'success', startedAt: 2, endedAt: 3 }] }); await e.drain(); assert.equal(rows(e).length, 0); assert.doesNotMatch(text(e.tree()), /这里只展示近期活动/);
  e.emit('registry', { items: [active], olderCount: 12 }); await e.drain(); await button(e, '取消活动').props.onClick(); await e.drain(); assert.equal(e.forbidden.length, 1); assert.equal(e.forbidden[0].method, 'cancel'); assert.equal(e.forbidden[0].value.id, 'live-registry');
});

test('active source rows remain visible even while local identity preparation fails', async t => {
  const e = environment({ hashFailure: true, activeTasks: [{ id: 'live', scriptName: 'Always visible active', status: 'unfamiliar', startedAt: 1 }] }); t.after(e.dispose); await e.drain();
  assert.equal(rows(e).length, 1); assert.match(text(e.tree()), /Always visible active/); assert.equal(button(e, '移除活动记录'), undefined); assert.equal(e.writes.length, 0); assert.deepEqual(e.forbidden, []);
});
