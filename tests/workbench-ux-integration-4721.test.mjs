import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url), { parse } = require('@babel/parser'), traverse = require('@babel/traverse').default;
const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
function effect(path, match) {
  const source = read(path), ast = parse(source, { sourceType: 'module', plugins: ['jsx'] }); let found;
  traverse(ast, { CallExpression({ node }) {
    if (['useEffect', 'useLayoutEffect'].includes(node.callee.name) && source.slice(node.arguments[0].start, node.arguments[0].end).includes(match)) found = node.arguments[0];
  } });
  assert.ok(found, match); return source.slice(found.start, found.end);
}
function initializer(path, name) {
  const source = read(path), ast = parse(source, { sourceType: 'module', plugins: ['jsx'] }); let found;
  traverse(ast, { VariableDeclarator({ node }) { if (node.id.name === name) found = node.init; } });
  assert.ok(found, name); return source.slice(found.start, found.end);
}
function declaration(path, name) {
  const source = read(path), ast = parse(source, { sourceType: 'module', plugins: ['jsx'] }); let found;
  traverse(ast, { FunctionDeclaration({ node }) { if (node.id?.name === name) found = node; } });
  assert.ok(found, name); return source.slice(found.start, found.end);
}
test('late workset application defaults cannot overwrite target or package edits, or a closed form', async () => {
  const callback = effect('src/components/WorkbenchWorksets.jsx', 'targetEdited.current = false');
  for (const changed of ['target', 'application', 'closed', 'none']) {
    let release; const loaded = new Promise(resolve => { release = resolve; });
    const values = {}, mounted = { current: false }, epoch = { current: 0 }, loadTicket = { current: 0 }, targetEdited = { current: false };
    const bindings = { open: true, mounted, epoch, loadTicket, targetEdited, deviceId: 'A', packageName: '', dialog: { current: { showModal() {}, close() {} } }, document: { activeElement: { focus() {} } },
      setTarget: value => { values.target = value; }, setApplication: value => { values.application = value; }, setName() {}, setError() {}, setNotice() {}, setBusy() {}, load: () => { loadTicket.current++; return loaded; } };
    const cleanup = runInNewContext(`(${callback})`, bindings)();
    if (changed === 'target') { targetEdited.current = true; values.target = 'B'; values.application = ''; }
    if (changed === 'application') { targetEdited.current = true; values.application = 'user.input'; }
    if (changed === 'closed') cleanup();
    release({ context: { application: { deviceId: 'A', packageName: 'late.old' } } });
    await loaded; await Promise.resolve();
    assert.equal(values.application, changed === 'none' ? 'late.old' : changed === 'application' ? 'user.input' : '');
  }
  const source = read('src/components/WorkbenchWorksets.jsx');
  assert.match(source, /targetEdited\.current = true; setTarget/);
  assert.match(source, /targetEdited\.current = true; setApplication/);
});

test('late initial workset list cannot overwrite the result of a newer explicit save', async () => {
  let release; const oldList = new Promise(resolve => { release = resolve; }); let visible;
  const code = declaration('src/components/WorkbenchWorksets.jsx', 'load') + '\n' + declaration('src/components/WorkbenchWorksets.jsx', 'save') + '\n({load,save})';
  const old = { ok: true, items: [{ id: 'old' }], context: {} }, current = { ok: true, items: [{ id: 'new' }], context: {} };
  const api = runInNewContext(code, { epoch: { current: 1 }, loadTicket: { current: 0 }, mounted: { current: true },
    window: { electronAPI: { worksetList: () => oldList, worksetSave: async () => current } },
    setData: value => { visible = value; }, setNotice() {}, name: 'Current configuration', target: 'A', application: 'com.fixture', pages: { devices: 'Devices' }, page: 'devices',
    action: async (_operation, run) => run(), confirmAppMessage: async () => true, tr: value => value });
  const first = api.load(); await api.save(); release(old); await first;
  assert.equal(visible.items[0].id, 'new');
});

test('a stale initial list failure cannot replace feedback after a successful workset save', async () => {
  let rejectOld; const old = new Promise((_resolve, reject) => { rejectOld = reject; });
  const values = { error: '', notice: '', items: [] }, scope = { open: true, busy: '', epoch: { current: 0 }, loadTicket: { current: 0 }, targetEdited: { current: false }, mounted: { current: false },
    deviceId: 'A', packageName: '', name: 'Saved', target: 'A', application: '', page: 'devices', pages: { devices: 'Devices' },
    window: { electronAPI: { worksetList: () => old, worksetSave: async () => ({ ok: true, items: [{ id: 'saved' }], context: {} }) } },
    dialog: { current: { showModal() {}, close() {} } }, document: { activeElement: { focus() {} } },
    setTarget() {}, setApplication() {}, setName() {}, setBusy() {}, setData: value => { values.items = value.items; },
    setError: value => { values.error = value; }, setNotice: value => { values.notice = value; }, confirmAppMessage: async () => true, tr: value => value };
  const code = ['load', 'action', 'save'].map(name => declaration('src/components/WorkbenchWorksets.jsx', name)).join('\n') + `\nconst cleanup=(${effect('src/components/WorkbenchWorksets.jsx', 'targetEdited.current = false')})(); ({save,cleanup});`;
  const api = runInNewContext(code, scope); await api.save(); rejectOld(Error('obsolete read failure'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(values.items[0].id, 'saved'); assert.match(values.notice, /工作集已保存/); assert.equal(values.error, ''); api.cleanup();
});
function scrollFixture() {
  const listeners = new Map(), frames = new Map(); let frameId = 0, observer;
  const element = { scrollHeight: 200, clientHeight: 300, position: 0,
    get scrollTop() { return this.position; }, set scrollTop(value) { this.position = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const bindings = { page: 'devices', mainRef: { current: element }, positions: { current: { devices: 800 } }, schedule() {},
    requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; }, cancelAnimationFrame: id => frames.delete(id),
    MutationObserver: class { constructor(fn) { this.fn = fn; this.connected = false; observer = this; } observe() { this.connected = true; } disconnect() { this.connected = false; } } };
  const cleanup = runInNewContext(`(${effect('src/shared/useWorkbenchUiWorkspace.js', 'new MutationObserver')})`, bindings)();
  return { element, bindings, cleanup, listeners, mutate: () => { if (observer.connected) observer.fn(); for (const [id, fn] of frames) { frames.delete(id); fn(); } }, observer: () => observer };
}
test('page position survives initially short loading content and restores after asynchronous discovery', () => {
  const f = scrollFixture(); assert.equal(f.element.scrollTop, 0);
  f.listeners.get('scroll')(); assert.equal(f.bindings.positions.current.devices, 800);
  f.element.scrollHeight = 2200; f.mutate(); assert.equal(f.element.scrollTop, 800); assert.equal(f.observer().connected, false);
  f.listeners.get('scroll')(); assert.equal(f.bindings.positions.current.devices, 800);
  f.cleanup(); assert.equal(f.listeners.size, 0);
});
test('manual scrolling wins over delayed restore and observers do not jump the user back later', () => {
  const f = scrollFixture(); f.listeners.get('wheel')();
  f.element.scrollHeight = 2200; f.element.scrollTop = 120; f.listeners.get('scroll')(); f.mutate();
  assert.equal(f.element.scrollTop, 120); assert.equal(f.bindings.positions.current.devices, 120); f.cleanup();
});
test('log-file-only worksets restore filter configuration without an implicit device connection or AI call', async () => {
  const calls = [], state = {}, refs = { current: '' }, item = { id: 'x', name: 'File filter', page: 'devices', deviceId: '', packageName: '', logs: { deviceId: '', filter: { text: 'error' }, buffers: ['main'] } };
  const restore = runInNewContext(`(${initializer('src/App.jsx', 'restoreWorkset')})`, {
    window: { electronAPI: { logAnalyzerApplyContext: async value => { calls.push(value); return { ok: true }; } } }, devices: [], worksetTargetRef: refs,
    setActiveDeviceId: value => { state.device = value; }, setNavigationContext: value => { state.context = value; }, setWorksetRequest: value => { state.request = value; },
    setActiveTab: value => { state.page = value; }, setWorksetNotice() {}, rememberWorksetContext: async () => {}, crypto: { randomUUID: () => 'request' }, tr: value => value
  });
  await restore(item);
  assert.equal(calls.length, 1); assert.equal(calls[0].worksetLogs.filter.text, 'error'); assert.equal(calls[0].deviceId, '');
  assert.equal(state.page, 'devices'); assert.equal(state.request.id, 'x');
});
test('global status and connection UI share one entry and keep the same explicit navigation callback', () => {
  assert.doesNotMatch(read('src/App.jsx'), /<SidebarConnectionStatus/);
  const activity = read('src/components/WorkbenchActivity.jsx');
  assert.equal((activity.match(/<SidebarConnectionStatus/g) || []).length, 1);
  assert.match(activity, /setOpen\(false\); onNavigateConnection\?\.\(page\)/);
  assert.match(activity, /connectionSummary\.connections/);
});
