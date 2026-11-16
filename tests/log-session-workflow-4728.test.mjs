import test from 'node:test';
import assert from 'node:assert/strict';
import { freezeLogSnapshot, saveBeforeRestore } from '../src/shared/logSessionWorkflow.js';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url), { parse } = require('@babel/parser'), traverse = require('@babel/traverse').default;
function callback(file, name) {
  const source = readFileSync(new URL('../src/components/' + file, import.meta.url), 'utf8'); let found;
  traverse(parse(source, { sourceType: 'module', plugins: ['jsx'] }), {
    FunctionDeclaration({ node }) { if (node.id.name === name) found = node; },
    VariableDeclarator({ node }) { if (node.id.name === name) found = node.init; }
  });
  return source.slice(found.start, found.end);
}
const bind = (source, values) => new Function(...Object.keys(values), `return (${source})`)(...Object.values(values));

test('snapshot freezes exactly one read before asynchronous work without calling capture or AI', () => {
  let reads = 0;
  const input = { uiRevision: 7, entries: [{ id: 'one', raw: 'original' }], markers: [], evidence: [], aiTurns: [], filter: { text: 'error' } };
  const frozen = freezeLogSnapshot(() => { reads++; return input; }, 'Saved'); input.entries[0].raw = 'changed'; input.filter.text = '';
  assert.equal(reads, 1); assert.equal(frozen.entries[0].raw, 'original'); assert.equal(frozen.filter.text, 'error'); assert.equal(frozen.uiRevision, 7);
});
test('save-current-before-restore failure never requests restore and retains the frozen snapshot', async () => {
  let restores = 0;
  const snapshot = { uiRevision: 8 };
  await assert.rejects(saveBeforeRestore({ snapshot, id: 'target', saveCurrent: true, isCurrent: () => true,
    api: { logSessionSave: async value => { assert.equal(value.uiRevision, snapshot.uiRevision); return { ok: false, error: 'disk full' }; }, logSessionLoad: () => restores++ } }), /disk full/);
  assert.equal(restores, 0);
});
test('closing while saving prevents late restore; completed restore is ignored after the source changes', async () => {
  let current = true, finish, restores = 0;
  const pending = saveBeforeRestore({ snapshot: {}, id: 'target', saveCurrent: true, isCurrent: () => current,
    api: { logSessionSave: () => new Promise(resolve => { finish = resolve; }), logSessionLoad: () => restores++ } });
  current = false; finish({ ok: true }); assert.equal(await pending, null); assert.equal(restores, 0);
  current = true;
  const loading = saveBeforeRestore({ id: 'target', saveCurrent: false, isCurrent: () => current,
    api: { logSessionLoad: () => new Promise(resolve => { finish = resolve; }) } });
  current = false; finish({ ok: true, session: { id: 'target' } }); assert.equal(await loading, null);
});
test('actual manager save freezes one snapshot, permits continued capture and reports only that revision', async () => {
  let reads = 0, finish, received, saved;
  const snapshot = { uiRevision: 8, entries: [{ id: 'one', raw: 'original' }] };
  const values = { flight: { current: false }, epoch: { current: 0 }, activeRequest: { current: '' }, alive: { current: true }, freezeLogSnapshot,
    getSnapshot: () => { reads++; return snapshot; }, name: 'Session', crypto: { randomUUID }, setBusy() {}, setError() {}, setMode() {}, tr: text => text, getLocale: () => 'en-US', onMessage() {},
    onSaved: input => { saved = input; }, window: { electronAPI: { logSessionSave: input => { received = input; return new Promise(resolve => { finish = resolve; }); } } } };
  const save = bind(callback('LogSessionManager.jsx', 'save'), values), pending = save();
  snapshot.entries[0].raw = 'new capture'; snapshot.uiRevision = 9;
  finish({ ok: true, session: { name: 'Session', entryCount: 1 } }); await pending;
  assert.equal(reads, 1); assert.equal(received.entries[0].raw, 'original'); assert.equal(saved.uiRevision, 8);
});
test('actual manager save-before-restore fails closed and closing fences a late restore callback', async () => {
  let restores = 0, finish;
  const values = { flight: { current: false }, epoch: { current: 0 }, activeRequest: { current: '' }, alive: { current: true }, canRestore: true,
    selected: { id: 'target' }, sourceIdentity: undefined, currentSource: { current: undefined }, freezeLogSnapshot, getSnapshot: () => ({ entries: [], uiRevision: 1 }), suggestedName: () => 'Current', crypto: { randomUUID },
    setBusy() {}, setError() {}, setMode() {}, setSessions() {}, setSelected() {}, setAction() {}, onMessage() {}, tr: text => text,
    saveBeforeRestore, onSaved() {}, onRestore: () => restores++, window: { electronAPI: { logSessionSave: async () => ({ ok: false, error: 'disk full' }), logSessionLoad: () => { restores++; } } } };
  const action = bind(callback('LogSessionManager.jsx', 'runAction'), values);
  await action('restore-save'); assert.equal(restores, 0);
  values.window.electronAPI.logSessionLoad = () => new Promise(resolve => { finish = resolve; });
  const pending = action('restore'); values.epoch.current++; finish({ ok: true, session: { id: 'target' } }); await pending; assert.equal(restores, 0);
});
test('restore carries authoritative source identity only in response metadata, not the saved session object', async () => {
  let received;
  const session = { id: 'target', entries: [] };
  const response = await saveBeforeRestore({ id: 'target', saveCurrent: false, isCurrent: () => true,
    api: { logSessionLoad: async () => ({ ok: true, session, sourceIdentity: 'backend-epoch' }) } });
  assert.equal(response.sourceIdentity, 'backend-epoch'); assert.equal(Object.hasOwn(response.session, 'sourceIdentity'), false);
  const values = { flight: { current: false }, epoch: { current: 0 }, activeRequest: { current: '' }, alive: { current: true }, canRestore: true,
    selected: { id: 'target' }, sourceIdentity: undefined, currentSource: { current: undefined }, getSnapshot: () => ({ entries: [] }), suggestedName: () => 'Current', freezeLogSnapshot, crypto: { randomUUID }, setBusy() {}, setError() {}, setMode() {}, saveBeforeRestore,
    onSaved() {}, onRestore: (...args) => { received = args; }, window: { electronAPI: { logSessionLoad: async () => response } } };
  await bind(callback('LogSessionManager.jsx', 'runAction'), values)('restore');
  assert.equal(received[0], session); assert.equal(received[1].sourceIdentity, 'backend-epoch');
});
test('save-before-restore carries one initial source token and refuses a stale response from a later main source', async () => {
  let loaded;
  await assert.rejects(saveBeforeRestore({ snapshot: { sourceIdentity: 'A' }, id: 'target', requestId: 'request', expectedSourceIdentity: 'A', saveCurrent: true, isCurrent: () => true,
    api: { logSessionSave: async () => ({ ok: true, session: {} }), logSessionLoad: async args => { loaded = args; return { ok: true, session: {}, sourceIdentity: 'C' }; },
      logGetState: async () => ({ sourceIdentity: 'B' }) } }), /来源已变化/);
  assert.equal(loaded.expectedSourceIdentity, 'A');
});
