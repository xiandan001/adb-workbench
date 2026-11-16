import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { recentWorksets, restoreFreshWorkset, suggestWorksetName } from '../src/shared/worksetQuickRestore.js';
import { tr } from '../src/shared/i18n.js';

const require = createRequire(import.meta.url), { parse } = require('@babel/parser'), traverse = require('@babel/traverse').default;
const source = readFileSync(new URL('../src/components/WorkbenchRecentWorksets.jsx', import.meta.url), 'utf8');
const callbacks = {};
traverse(parse(source, { sourceType: 'module', plugins: ['jsx'] }), {
  FunctionDeclaration({ node }) { if (['load', 'restore'].includes(node.id?.name)) callbacks[node.id.name] = source.slice(node.start, node.end); },
  CallExpression({ node }) { if (node.callee.name === 'useEffect') callbacks.effect = source.slice(node.arguments[0].start, node.arguments[0].end); },
  JSXAttribute({ node }) { if (node.name.name === 'onCancel') callbacks.cancel = source.slice(node.value.expression.start, node.value.expression.end); }
});
const instantiate = (code, bindings) => new Function(...Object.keys(bindings), `return (${code});`)(...Object.values(bindings));

test('recent worksets are the newest five without changing the backend list', () => {
  const items = Array.from({ length: 8 }, (_, index) => ({ id: String(index), updatedAt: new Date(1000 * index).toISOString() }));
  assert.deepEqual(recentWorksets(items).map(item => item.id), ['7', '6', '5', '4', '3']);
  assert.equal(items[0].id, '0');
});

test('quick restore revalidates the ID and uses detached fresh configuration, never the stale row', async () => {
  const fresh = { id: 'saved', name: 'Fresh', deviceId: 'B', packageName: 'com.current', logs: { filter: { text: 'error' } } };
  let restored, reads = 0;
  await restoreFreshWorkset('saved', { list: async () => { reads++; return { ok: true, items: [fresh] }; },
    onRestore: async item => { restored = item; fresh.deviceId = 'changed'; fresh.logs.filter.text = 'changed'; }, isCurrent: () => true });
  assert.equal(reads, 1); assert.equal(restored.deviceId, 'B'); assert.equal(restored.packageName, 'com.current');
  assert.equal(restored.logs.filter.text, 'error');
});

test('deleted, failed and cancelled lists never restore configuration', async () => {
  let calls = 0;
  const onRestore = () => { calls++; };
  await assert.rejects(restoreFreshWorkset('deleted', { list: async () => ({ ok: true, items: [] }), onRestore, isCurrent: () => true }));
  await assert.rejects(restoreFreshWorkset('saved', { list: async () => ({ ok: false, error: 'offline' }), onRestore, isCurrent: () => true }), /offline/);
  assert.equal((await restoreFreshWorkset('saved', { list: async () => ({ ok: true, items: [{ id: 'saved' }] }), onRestore, isCurrent: () => false })).cancelled, true);
  assert.equal(calls, 0);
});

test('suggested workset name uses device and page, is bounded and has no control characters', () => {
  assert.equal(suggestWorksetName([{ id: 'A', model: 'Panel' }], 'A', 'Tasks'), 'Panel · Tasks');
  assert.equal(suggestWorksetName([], 'offline-A', 'Tasks'), 'offline-A · Tasks');
  assert.equal(suggestWorksetName([], '', 'Devices'), 'Devices');
  const name = suggestWorksetName([{ id: 'A', model: '\n' + 'x'.repeat(100) }], 'A', 'Tasks');
  assert.equal(name.length, 80); assert.equal(name.includes('\n'), false);
});

test('actual recent restore callback is single-flight, keeps errors inline and retries the same fresh ID', async () => {
  let release, listCalls = 0, restored, closes = 0, fail = true;
  const state = { busy: '', error: '' }, lock = { current: false };
  const restore = instantiate(callbacks.restore, { restoreLock: lock, loading: false, alive: { current: true }, restoreFreshWorkset,
    setBusy: value => { state.busy = value; }, setError: value => { state.error = value; }, onClose: () => { closes++; },
    onRestore: item => { restored = item; }, window: { electronAPI: { worksetList: () => { listCalls++; return new Promise(resolve => { release = () => resolve(fail ? { ok: false, error: 'retry this' } : { ok: true, items: [{ id: 'A', deviceId: 'fresh-device' }] }); }); } } } });
  const first = restore({ id: 'A', deviceId: 'stale' }); await restore({ id: 'A' });
  assert.equal(listCalls, 1); assert.equal(lock.current, true); assert.equal(state.busy, 'A');
  release(); await first; assert.equal(state.error, 'retry this'); assert.equal(closes, 0); assert.equal(lock.current, false);
  fail = false; const retry = restore({ id: 'A' }); release(); await retry;
  assert.equal(listCalls, 2); assert.equal(restored.deviceId, 'fresh-device'); assert.equal(closes, 1); assert.equal(state.error, '');
});

test('actual initial loading and modal cleanup ignore cancelled results and return focus to the trigger', async () => {
  let release, writes = 0, focus = 0, shown = 0, closed = 0;
  const alive = { current: true }, loadTicket = { current: 0 };
  const load = instantiate(callbacks.load, { alive, loadTicket, setLoading() {}, setError() { writes++; }, setItems() { writes++; }, recentWorksets, tr,
    window: { electronAPI: { worksetList: () => new Promise(resolve => { release = resolve; }) } } });
  const pending = load(); const beforeCancel = writes; alive.current = false; release({ ok: true, items: [{ id: 'A' }] }); await pending;
  assert.equal(writes, beforeCancel);
  const effect = instantiate(callbacks.effect, { alive, dialog: { current: { showModal() { shown++; }, close() { closed++; } } },
    triggerRef: { current: { isConnected: true, focus() { focus++; } } }, document: { activeElement: {} }, load() {} });
  const cleanup = effect(); assert.equal(shown, 1); assert.equal(alive.current, true);
  cleanup(); assert.equal(alive.current, false); assert.equal(closed, 1); assert.equal(focus, 1);
  let closes = 0, prevented = 0; const restoreLock = { current: true };
  const cancel = instantiate(callbacks.cancel, { restoreLock, onClose: () => { closes++; } });
  cancel({ preventDefault() { prevented++; } }); assert.equal(closes, 0);
  restoreLock.current = false; cancel({ preventDefault() { prevented++; } }); assert.equal(closes, 1); assert.equal(prevented, 2);
});
