import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { transformSync } from 'rolldown/utils';
import * as protocol from '../src/shared/rs232Protocol.js';
import * as persistence from '../src/shared/rs232ProtocolPreferences.js';
import * as draftHelpers from '../src/shared/rs232ProtocolDraft.js';
import { encodeMessage } from '../src/shared/serialSettings.js';
import { formatHex } from '../src/shared/serialFormat.js';
import { trapAppMessageFocus } from '../src/shared/appMessageDialog.js';

const pause = () => new Promise(resolve => setTimeout(resolve, 0));
const theme = { card: '', text: '', textMuted: '', input: '', button: { primary: '', secondary: '' } };
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
const text = tree => typeof tree === 'string' || typeof tree === 'number' ? String(tree) : !tree || typeof tree !== 'object' ? '' : [tree.props?.children].flat(Infinity).map(text).join(' ');
const find = (h, label) => nodes(h.tree()).find(node => node.type === 'button' && (node.props['aria-label'] === label || text(node).trim() === label));
const region = (h, label) => nodes(h.tree()).find(node => node.props?.['aria-label'] === label);
function environment({ manualFrames = false } = {}) {
  const values = new Map(), writes = [], confirms = [], choices = [], focus = [], timers = new Set();
  const document = { activeElement: null }, previous = { isConnected: true, focus() { document.activeElement = previous; focus.push('previous'); } }; document.activeElement = previous;
  const storage = { fail: false, getItem: key => values.get(key) ?? null, setItem(key, value) { writes.push({ key, value }); if (this.fail) throw Error('quota'); values.set(key, value); } };
  const frames = new Map(); let frameSequence = 0;
  let active, locale = 'zh-CN', sequence = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((item, index) => Object.is(item, b[index]));
  const hookEffect = kind => (callback, deps) => { const owner = active, index = owner.cursor++, slot = owner.slots[index] || (owner.slots[index] = {}); if (deps && same(slot.deps, deps)) return; slot.deps = deps; owner[kind].push(() => { slot.cleanup?.(); slot.cleanup = callback(); }); };
  const runtime = { console, URL, TextEncoder, Uint8Array, crypto: { randomUUID }, document, Fragment: 'fragment', Suspense: 'Suspense', SelectMenu: 'SelectMenu', lazy: () => ({ lazy: true }),
    jsx: (type, props, ...children) => ({ type, props: { ...props, children } }), tr: (value, args = {}) => value.replace(/\{(\d+)\}/g, (all, key) => args[key] ?? all), getLocale: () => locale, useLocale: () => locale,
    trapAppMessageFocus, confirmAppMessage: async options => { confirms.push(options); return choices.shift() ?? false; }, encodeMessage, formatHex,
    ...Object.fromEntries(Object.entries(protocol).filter(([, value]) => typeof value === 'function').map(([name, fn]) => [name, (...args) => fn(...args.map(arg => structuredClone(arg)))])),
    ...Object.fromEntries(Object.entries(draftHelpers).filter(([, value]) => typeof value === 'function')),
    defaultProtocolPreferences: persistence.defaultProtocolPreferences, readProtocolPreferences: () => persistence.readProtocolPreferences(storage), saveProtocolPreferences: value => persistence.saveProtocolPreferences(structuredClone(value), storage),
    upsertProtocolCommand: (value, command) => persistence.upsertProtocolCommand(structuredClone(value), structuredClone(command)), removeProtocolCommand: (value, id) => persistence.removeProtocolCommand(structuredClone(value), id), restoreProtocolCommand: (value, id) => persistence.restoreProtocolCommand(structuredClone(value), id),
    setTimeout(callback, delay) { const timer = setTimeout(callback, delay); timers.add(timer); return timer; }, clearTimeout,
    requestAnimationFrame(callback) { const id = ++frameSequence; frames.set(id, callback); if (!manualFrames) { const timer = setTimeout(() => { const value = frames.get(id); frames.delete(id); value?.(0); }, 0); timers.add(timer); } return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    useState(value) { const owner = active, index = owner.cursor++; if (!owner.slots[index]) { const slot = { value: typeof value === 'function' ? value() : value }; slot.set = update => { const next = typeof update === 'function' ? update(slot.value) : update; if (!Object.is(next, slot.value)) { slot.value = next; owner.changed = true; } }; owner.slots[index] = slot; } return [owner.slots[index].value, owner.slots[index].set]; },
    useRef(value) { const owner = active, index = owner.cursor++; return owner.slots[index] || (owner.slots[index] = { current: value }); },
    useId() { const owner = active, index = owner.cursor++; return owner.slots[index] || (owner.slots[index] = 'serial-ui-' + owner.id + '-' + index); },
    useMemo(callback, deps) { const owner = active, index = owner.cursor++, slot = owner.slots[index]; if (slot && same(slot.deps, deps)) return slot.value; const value = callback(); owner.slots[index] = { deps, value }; return value; },
    useCallback(callback, deps) { const owner = active, index = owner.cursor++, slot = owner.slots[index]; if (slot && same(slot.deps, deps)) return slot.value; owner.slots[index] = { deps, value: callback }; return callback; },
    useEffect: hookEffect('effects'), useLayoutEffect: hookEffect('layouts'),
  };
  for (const name of ['AlertTriangle', 'ArrowDownToLine', 'Code2', 'Pencil', 'Plus', 'RotateCcw', 'Search', 'Trash2', 'X', 'Save', 'ChevronDown', 'Clock', 'Send', 'Star']) runtime[name] = 'icon';
  const context = vm.createContext(runtime), components = {};
  for (const name of ['Rs232ProtocolCommandEditor', 'Rs232ProtocolPanel', 'SerialSendPanel']) {
    const source = fs.readFileSync(new URL('../src/components/' + name + '.jsx', import.meta.url), 'utf8').replace(/^import .+;\r?\n/gm, '').replace('export default function', 'function');
    components[name] = vm.runInContext('(function(){' + transformSync(name + '.jsx', source, { jsx: { runtime: 'classic', pragma: 'jsx', pragmaFrag: 'Fragment' } }).code + ';return ' + name + ';})()', context); runtime[name] = components[name];
  }
  const owners = [];
  function mount(name, props) {
    const owner = { id: ++sequence, cursor: 0, slots: [], effects: [], layouts: [], changed: true, tree: null, props, elements: new Map() }; owners.push(owner);
    const target = kind => {
      const node = nodes(owner.tree).find(item => kind === 'title' ? item.props?.['data-protocol-command-title'] : item.type === 'input' && item.props?.['aria-label']);
      if (!node) return null;
      if (!owner.elements.has(kind)) { const element = { kind, getClientRects: () => [1], scrollIntoView() {}, focus() { document.activeElement = element; focus.push(kind); } }; owner.elements.set(kind, element); }
      return owner.elements.get(kind);
    };
    const render = () => { active = owner; owner.cursor = 0; owner.tree = components[name](owner.props);
      for (const node of nodes(owner.tree)) if (node.props.ref && !node.props.ref.current) node.props.ref.current = node.type === 'dialog' ? { ownerDocument: document, open: false, showModal() { this.open = true; }, close() { this.open = false; }, contains(element) { return [...owner.elements.values()].includes(element); }, querySelector(selector) { return target(selector === '[data-protocol-command-title]' ? 'title' : 'search'); } } : { focus() { document.activeElement = this; focus.push(node.type); }, scrollIntoView() {} };
      for (const callback of owner.layouts.splice(0)) callback(); return owner.tree; };
    const drain = async () => { for (let index = 0; index < 20; index++) { owner.changed = false; render(); for (const callback of owner.effects.splice(0)) callback(); await pause(); if (!owner.changed) { render(); return; } } throw Error('RS232 component fixture did not settle'); };
    return { render, drain, tree: () => owner.tree, setProps(value) { owner.props = { ...owner.props, ...value }; }, dispose() { for (const slot of owner.slots) slot?.cleanup?.(); } };
  }
  return { mount, storage, values, writes, confirms, choices, focus, document, setLocale(value) { locale = value; }, queuedFrames: () => [...frames.values()], flushFrames() { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(0); }, focusOutside() { previous.focus(); }, dispose() { for (const owner of owners) for (const slot of owner.slots) slot?.cleanup?.(); for (const timer of timers) clearTimeout(timer); frames.clear(); } };
}
const editorNode = h => nodes(h.tree()).find(node => typeof node.type === 'function' && node.type.name === 'Rs232ProtocolCommandEditor');
const command = (h, id) => nodes(h.tree()).find(node => node.type === 'button' && node.props.onClick && text(node).includes(protocol.getProtocolDisplayName(protocol.listProtocolCommands().find(item => item.id === id))));

test('actual panel previews fixed/parameter frames and never invokes a serial send while selecting', async t => {
  const e = environment(), used = []; t.after(e.dispose); const h = e.mount('Rs232ProtocolPanel', { theme, isDark: false, onClose() {}, onUse: async frame => { used.push(structuredClone(frame)); return false; } }); await h.drain();
  assert.match(text(h.tree()), /FE 08 58 42 48 43 4D 44 02 08 CF/); assert.equal(used.length, 0);
  command(h, 'lango-042').props.onClick(); await h.drain(); assert.equal(find(h, '填入发送区').props.disabled, true);
  const parameter = nodes(region(h, '协议命令详情')).find(node => node.type === 'input'); parameter.props.onChange({ target: { value: '101' } }); await h.drain(); assert.equal(find(h, '填入发送区').props.disabled, true);
  parameter.props.onChange({ target: { value: '50' } }); await h.drain(); assert.equal(find(h, '填入发送区').props.disabled, false); assert.equal(used.length, 0);
  await find(h, '填入发送区').props.onClick(); assert.equal(used.length, 1); assert.equal(used[0].bytes.at(-1), 0xcf);
  for (const id of ['lango-045', 'lango-report-1']) { command(h, id).props.onClick(); await h.drain(); assert.equal(find(h, '填入发送区').props.disabled, true); }
  await command(h, 'lango-107').props.onClick(); await h.drain(); assert.match(text(region(h, '协议命令详情')), /模拟外设输入/); assert.equal(used.length, 1);
});
test('actual dirty editor cannot disappear on close, escape or command switch without a custom confirmation', async t => {
  const e = environment(); t.after(e.dispose); let closes = 0; const h = e.mount('Rs232ProtocolPanel', { theme, onClose: () => closes++, onUse: async () => true }); await h.drain(); find(h, '添加命令').props.onClick(); await h.drain();
  const child = e.mount('Rs232ProtocolCommandEditor', editorNode(h).props); await child.drain(); nodes(child.tree()).find(node => node.type === 'input').props.onChange({ target: { value: 'Unsaved user command' } }); await child.drain();
  await find(h, '关闭协议面板').props.onClick(); await h.drain(); assert.equal(closes, 0); assert.equal(e.confirms.length, 1); assert.ok(editorNode(h));
  await command(h, 'lango-001').props.onClick(); await h.drain(); assert.ok(editorNode(h)); assert.equal(e.confirms.length, 2);
  await h.tree().props.onCancel({ preventDefault() {} }); await h.drain(); assert.equal(closes, 0); assert.equal(e.confirms.length, 3);
  e.choices.push(true); await find(h, '取消编辑')?.props.onClick?.(); if (editorNode(h)) await editorNode(h).props.onCancel(); await h.drain(); assert.equal(editorNode(h), undefined);
});
test('fill success suppresses old-trigger focus restoration after the parent has focused the send textarea', async t => {
  const e = environment(); t.after(e.dispose); let panel;
  const preferences = { sendMode: 'text', lineEnding: 'crlf', favorites: [] }; let draft = 'AT';
  const sender = e.mount('SerialSendPanel', { theme, preferences, draft, connected: true, sending: false, busy: false, history: [], commandsOpen: false, onCommandsOpen() {}, onSend() { assert.fail('Fill must not send'); }, onDraft(value) { draft = value; sender.setProps({ draft }); }, onPreferences(changes) { Object.assign(preferences, changes); sender.setProps({ preferences: { ...preferences } }); return true; } }); await sender.drain();
  find(sender, 'RS232 协议面板').props.onClick(); await sender.drain(); const lazy = nodes(sender.tree()).find(node => node.type?.lazy);
  panel = e.mount('Rs232ProtocolPanel', lazy.props); await panel.drain(); await find(panel, '填入发送区').props.onClick(); await sender.drain(); panel.dispose();
  assert.equal(draft, 'FE 08 58 42 48 43 4D 44 02 08 CF'); assert.equal(e.document.activeElement, nodes(sender.tree()).find(node => node.type === 'textarea').props.ref.current); assert.equal(e.focus.at(-1), 'textarea');
});
test('the immediate fill lock also blocks stale escape, close and selection callbacks until failure settles', async t => {
  const e = environment(); t.after(e.dispose); let resolve, closes = 0, fills = 0;
  const h = e.mount('Rs232ProtocolPanel', { theme, onClose: () => closes++, onUse: () => { fills++; return new Promise(done => { resolve = done; }); } }); await h.drain();
  const fill = find(h, '填入发送区'), close = find(h, '关闭协议面板'), other = command(h, 'lango-001'), escape = h.tree().props.onCancel;
  const pending = fill.props.onClick(); await escape({ preventDefault() {} }); await close.props.onClick(); await other.props.onClick(); await fill.props.onClick(); await h.drain();
  assert.equal(fills, 1); assert.equal(closes, 0); assert.match(text(region(h, '协议命令详情')), /获取电源状态/); assert.equal(find(h, '关闭协议面板').props.disabled, true);
  resolve(false); await pending; await h.drain(); assert.equal(find(h, '关闭协议面板').props.disabled, false); await find(h, '关闭协议面板').props.onClick(); assert.equal(closes, 1); h.dispose(); assert.equal(e.focus.at(-1), 'previous');
});
test('the sender remains locked during runtime-first failure compensation and no stale control can send or replace the draft', async t => {
  const e = environment(); t.after(e.dispose); let finishRollback, sends = 0, draft = 'AT'; const changes = [], edits = [], config = { baudRate: 19200, port: 'SYNTHETIC-NO-PORT' };
  let preferences = { sendMode: 'text', lineEnding: 'crlf', favorites: [], config };
  const h = e.mount('SerialSendPanel', { theme, preferences, draft, connected: true, sending: false, busy: false, commandsOpen: false, onCommandsOpen() {}, history: [], onSend: () => sends++,
    onDraft: value => { edits.push(value); draft = value; h.setProps({ draft }); }, onPreferences: value => { changes.push(structuredClone(value)); preferences = { ...preferences, ...value }; h.setProps({ preferences }); return changes.length === 1 ? false : new Promise(resolve => { finishRollback = resolve; }); } }); await h.drain();
  find(h, 'RS232 协议面板').props.onClick(); await h.drain(); const use = nodes(h.tree()).find(node => node.type?.lazy).props.onUse;
  const send = nodes(h.tree()).find(node => node.type === 'button' && text(node).includes('Ctrl+Enter')), area = nodes(h.tree()).find(node => node.type === 'textarea'), mode = nodes(h.tree()).find(node => node.type === 'SelectMenu' && node.props.id.endsWith('-mode'));
  const pending = use({ hex: 'FE 08 58 42 48 43 4D 44 02 08 CF' }, 'Power query'); send.props.onClick(); area.props.onChange({ target: { value: 'Unwanted overwrite' } }); mode.props.onChange('ascii'); await pause(); await h.drain();
  assert.equal(sends, 0); assert.equal(draft, 'AT'); assert.equal(edits.length, 0); assert.equal(nodes(h.tree()).find(node => node.type === 'textarea').props.disabled, true);
  assert.deepEqual(changes, [{ sendMode: 'hex', lineEnding: 'none' }, { sendMode: 'text', lineEnding: 'crlf' }]); assert.equal(preferences.config, config);
  finishRollback(false); assert.equal(await pending, false); await h.drain(); assert.equal(draft, 'AT'); assert.equal(preferences.sendMode, 'text'); assert.equal(preferences.lineEnding, 'crlf'); assert.equal(sends, 0);
});
test('editing a template invalidates its previous human review; a failed save retains all edits and duplicate save clicks are locked', async t => {
  const e = environment(); t.after(e.dispose); let reject, saves = 0;
  const initial = { id: 'custom-' + randomUUID(), name: 'My command', category: 'My group', template: 'FE 08 58 42 48 43 4D 44 02 08 CF', note: '', reviewed: true };
  const h = e.mount('Rs232ProtocolCommandEditor', { initial, theme, onCancel() {}, onSave: () => { saves++; return new Promise((_resolve, fail) => { reject = fail; }); } }); await h.drain();
  const name = nodes(h.tree()).find(node => node.type === 'input'); name.props.onChange({ target: { value: 'Retain this name' } }); await h.drain(); assert.equal(nodes(h.tree()).find(node => node.props?.type === 'checkbox').props.checked, true);
  nodes(h.tree()).find(node => node.type === 'textarea').props.onChange({ target: { value: 'FE 08 58 42 48 43 4D 44 02 21 CF' } }); await h.drain(); assert.equal(nodes(h.tree()).find(node => node.props?.type === 'checkbox').props.checked, false);
  const save = find(h, '保存命令'), first = save.props.onClick(), second = save.props.onClick(); await h.drain(); assert.equal(saves, 1);
  reject(Error('Synthetic quota failure')); await Promise.all([first, second]); await h.drain(); assert.equal(nodes(h.tree()).find(node => node.type === 'input').props.value, 'Retain this name'); assert.match(text(h.tree()), /Synthetic quota failure/);
});
test('real protocol storage CRUD keeps failed edits, preserves corrupt bytes and can restore a modified or deleted builtin', async t => {
  const e = environment(); t.after(e.dispose); const h = e.mount('Rs232ProtocolPanel', { theme, onClose() {}, onUse: async () => false }); await h.drain();
  await find(h, '编辑').props.onClick(); await h.drain(); const child = e.mount('Rs232ProtocolCommandEditor', editorNode(h).props); await child.drain();
  nodes(child.tree()).find(node => node.type === 'input').props.onChange({ target: { value: 'Literal user label' } }); await child.drain(); e.storage.fail = true;
  await find(child, '保存命令').props.onClick(); await h.drain(); await child.drain(); assert.ok(editorNode(h)); assert.equal(e.values.has(persistence.RS232_PROTOCOL_PREFS_KEY), false); assert.match(text(child.tree()), /保存失败/);
  e.storage.fail = false; await find(child, '保存命令').props.onClick(); await h.drain(); assert.equal(editorNode(h), undefined); assert.equal(persistence.readProtocolPreferences(e.storage).overrides[0].name, 'Literal user label');
  e.choices.push(true); await find(h, '恢复内置原样').props.onClick(); await h.drain(); assert.equal(persistence.readProtocolPreferences(e.storage).overrides.length, 0); assert.match(text(region(h, '协议命令详情')), /获取电源状态/);
  e.choices.push(true); await find(h, '删除').props.onClick(); await h.drain(); assert.deepEqual(persistence.readProtocolPreferences(e.storage).removed, ['lango-005']);
  find(h, '已删除的内置命令（1）').props.onClick(); await h.drain(); e.choices.push(true); await find(h, '获取电源状态').props.onClick(); await h.drain(); assert.deepEqual(persistence.readProtocolPreferences(e.storage).removed, []);
  const corrupt = '{broken original bytes'; e.values.set(persistence.RS232_PROTOCOL_PREFS_KEY, corrupt); const reopened = e.mount('Rs232ProtocolPanel', { theme, onClose() {}, onUse: async () => false }); await reopened.drain();
  await command(reopened, 'lango-001').props.onClick(); await reopened.drain(); assert.match(text(reopened.tree()), /原数据已保留/); assert.equal(e.values.get(persistence.RS232_PROTOCOL_PREFS_KEY), corrupt);
});
test('post-confirmation remove/restore focus waits for commit, preserves inside focus and ignores cancelled late frames', async t => {
  const e = environment({ manualFrames: true }); t.after(e.dispose); const h = e.mount('Rs232ProtocolPanel', { theme, onClose() {}, onUse: async () => false }); await h.drain();
  e.choices.push(true); await find(h, '删除').props.onClick(); await h.drain(); e.focusOutside(); const deletionFrame = e.queuedFrames(); assert.equal(deletionFrame.length, 1); e.flushFrames(); assert.equal(e.document.activeElement.kind, 'search');
  find(h, '已删除的内置命令（1）').props.onClick(); await h.drain(); e.choices.push(true); await find(h, '获取电源状态').props.onClick(); await h.drain();
  e.focusOutside(); const restorationFrame = e.queuedFrames(); assert.equal(restorationFrame.length, 1); e.flushFrames(); assert.equal(e.document.activeElement.kind, 'title');
  e.choices.push(true); await find(h, '删除').props.onClick(); await h.drain(); const search = h.tree().props.ref.current.querySelector('input[aria-label]'); search.focus(); const alreadyInside = e.document.activeElement; e.flushFrames(); assert.equal(e.document.activeElement, alreadyInside, 'An existing user focus is not stolen');
  find(h, '已删除的内置命令（1）').props.onClick(); await h.drain(); e.choices.push(true); await find(h, '获取电源状态').props.onClick(); await h.drain(); const late = e.queuedFrames(); h.dispose(); const before = e.focus.length; for (const callback of late) callback(0); assert.equal(e.focus.length, before, 'A queued callback cannot focus after unmount');
});
