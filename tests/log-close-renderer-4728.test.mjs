import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { logDocumentKey } from '../src/shared/logSessionSnapshot.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(overrides = {}) {
  const slots = [], effects = [], layout = [], calls = [], listeners = {};
  let cursor = 0, props;
  const snapshot = { uiRevision: 'original-ui-revision', name: 'Current', source: 'realtime', deviceId: 'A', entries: [{ id: 'frozen', raw: 'frozen raw' }],
    evidence: [], markers: [], aiTurns: [], filter: {}, buffers: ['main'], timeRange: { kind: 'all' } };
  const handlers = {
    logDocumentState: async input => ({ accepted: true }),
    logCloseDecision: async input => ({ accepted: true }),
    logGetState: async () => ({ source: 'realtime', deviceId: 'A', sourceIdentity: 'main-source-A', captureId: 'capture-A', running: false, entries: [{ id: 'flushed', raw: 'last buffered raw' }], truncated: false }),
    logSessionSave: async input => ({ ok: true, session: { id: 'saved', name: input.name, entryCount: input.entries.length } }),
    logSessionCancel: async () => ({ ok: true }), ...overrides,
  };
  const api = Object.fromEntries(Object.entries(handlers).map(([name, callback]) => [name, async input => { calls.push({ name, input }); return callback(input); }]));
  api.onLogCloseRequested = callback => { listeners.request = callback; return () => { listeners.request = null; }; };
  api.onLogCloseCancelled = callback => { listeners.cancel = callback; return () => { listeners.cancel = null; }; };
  const effect = (queue, callback, deps) => {
    const index = cursor++, previous = slots[index];
    if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
      slots[index] = { deps, cleanup: previous?.cleanup };
      queue.push(() => { slots[index].cleanup?.(); slots[index].cleanup = callback(); });
    }
  };
  const source = readFileSync(new URL('../src/shared/useLogCloseProtection.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export default function', 'function');
  const hook = runInNewContext(`${source}\nuseLogCloseProtection`, {
    window: { electronAPI: api }, tr: text => text, logDocumentKey, crypto: { randomUUID },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
    useLayoutEffect: (callback, deps) => effect(layout, callback, deps), useEffect: (callback, deps) => effect(effects, callback, deps),
  });
  const defaults = { documentId: 'doc-A', sourceIdentity: 'main-source-A', ready: true, reviewKey: 'review-A', dirty: true, paused: false, getSnapshot: () => snapshot,
    getCaptureIdentity: () => ({ source: 'realtime', captureId: 'capture-A' }),
    onStopAi: async () => { calls.push({ name: 'stop-ai' }); }, onStop: async () => { calls.push({ name: 'stop-capture' }); },
    onSaved: input => { calls.push({ name: 'saved-callback', input }); } };
  function render(update) {
    props = { ...(props || defaults), ...update }; cursor = 0;
    const value = hook(props); while (layout.length) layout.shift()(); while (effects.length) effects.shift()(); return value;
  }
  function ask(extra = {}) {
    const state = calls.filter(call => call.name === 'logDocumentState').at(-1).input;
    const request = { ...state, requestId: randomUUID(), intent: 'quit', ...extra }; delete request.dirty;
    listeners.request(request); return request;
  }
  render();
  return { render, ask, snapshot, calls, listeners, handlers };
}

test('old review revision is rejected locally before stopping a new operation, even before the main cancellation arrives', async () => {
  const h = harness(), request = h.ask();
  const current = h.render({ reviewKey: 'new-review-same-document' });
  await assert.rejects(current.save(request), /内容已切换/);
  await assert.rejects(current.resolve(request, 'discard'), /内容已切换/);
  assert.equal(h.calls.some(call => ['stop-ai', 'stop-capture', 'logSessionSave', 'logCloseDecision'].includes(call.name)), false);
});
test('a delayed close request for an old source or revision cancels without opening a prompt', async () => {
  const h = harness();
  h.ask({ documentId: 'old-document' }); await tick(); assert.equal(h.render().request, null);
  h.ask({ revision: 0 }); await tick(); assert.equal(h.render().request, null);
  assert.equal(h.calls.filter(call => call.name === 'logCloseDecision').length, 2);
  assert.ok(h.calls.filter(call => call.name === 'logCloseDecision').every(call => call.input.action === 'cancel'));
});
test('source replacement while saving cannot mark the new document clean or authorize close', async () => {
  let finish;
  const h = harness({ logSessionSave: () => new Promise(resolve => { finish = resolve; }) }), request = h.ask();
  const saving = h.render().save(request); while (!finish) await tick();
  h.render({ documentId: 'doc-B', reviewKey: 'review-B' }); finish({ ok: true, session: { id: 'old-saved' } });
  await assert.rejects(saving, /已保存.*内容已切换/);
  assert.equal(h.calls.some(call => call.name === 'saved-callback'), false);
  assert.equal(h.calls.some(call => call.name === 'logDocumentState' && call.input.dirty === false), false);
});
test('source replacement while AI cancellation is awaiting must not stop the newly selected capture', async () => {
  let finishAi;
  const h = harness(); h.render({ onStopAi: () => new Promise(resolve => { finishAi = resolve; }) });
  const request = h.ask(), saving = h.render().save(request);
  h.render({ documentId: 'doc-B', reviewKey: 'review-B' }); finishAi();
  await assert.rejects(saving, /内容已切换/);
  assert.equal(h.calls.some(call => call.name === 'stop-capture'), false);
});
test('paused save closes only over the frozen loaded window, not later captured rows', async () => {
  const h = harness(); h.render({ paused: true }); const request = h.ask(); await h.render().save(request);
  const saving = h.calls.find(call => call.name === 'logSessionSave');
  assert.equal(saving.input.entries[0].raw, 'frozen raw'); assert.equal(saving.input.uiRevision, 'original-ui-revision');
  assert.deepEqual(h.calls.filter(call => call.name.startsWith('stop-')).map(call => call.name), ['stop-ai', 'stop-capture']);
});
test('normal save uses the final flushed loaded window but refuses changed capture identity', async () => {
  const h = harness(), request = h.ask(); await h.render().save(request);
  assert.equal(h.calls.find(call => call.name === 'logSessionSave').input.entries[0].raw, 'last buffered raw');
  const wrong = harness({ logGetState: async () => ({ source: 'realtime', deviceId: 'A', captureId: 'different', entries: [] }) }), stale = wrong.ask();
  await assert.rejects(wrong.render().save(stale), /内容已切换/);
  assert.equal(wrong.calls.some(call => call.name === 'logSessionSave'), false);
});
test('a different imported file with the same source/device labels cannot be saved by an old review', async () => {
  const h = harness({ logGetState: async () => ({ source: 'file', deviceId: '', sourceIdentity: 'file-B', captureId: '', entries: [{ id: 'same-id', raw: 'new file B' }] }) });
  h.render({ sourceIdentity: 'file-A', getSnapshot: () => ({ ...h.snapshot, source: 'file', deviceId: '' }), getCaptureIdentity: () => ({ source: 'file', captureId: '' }) });
  const request = h.ask(); await assert.rejects(h.render().save(request), /内容已切换/);
  assert.equal(h.calls.some(call => call.name === 'logSessionSave'), false);
});
test('cancel and unmatched quitCancelled notifications never stop capture or save content', async () => {
  const h = harness(), request = h.ask();
  h.listeners.cancel({ requestId: 'wrong-nonce' }); assert.equal(h.render().request.requestId, request.requestId);
  await h.render().resolve(request, 'cancel'); assert.equal(h.render().request, null); assert.equal(h.render().approved, false);
  assert.equal(h.calls.some(call => ['stop-ai', 'stop-capture', 'logSessionSave'].includes(call.name)), false);
});
test('a late accepted response for an old review cannot approve and lock a newer source prompt', async () => {
  let finish;
  const h = harness({ logCloseDecision: () => new Promise(resolve => { finish = resolve; }) }), old = h.ask();
  const resolving = h.render().resolve(old, 'discard');
  h.listeners.cancel({ requestId: old.requestId }); h.render({ documentId: 'doc-B', reviewKey: 'review-B' });
  const next = h.ask(); h.render(); finish({ accepted: true });
  await assert.rejects(resolving, /内容已切换/);
  assert.equal(h.render().request.requestId, next.requestId); assert.equal(h.render().approved, false);
});
