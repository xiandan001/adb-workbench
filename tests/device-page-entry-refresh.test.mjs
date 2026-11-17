import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { resolveActiveDeviceId, singleFlight } from '../src/shared/deviceWorkflow.js';
import { tr } from '../src/shared/i18n.js';

const require = createRequire(import.meta.url), { parse } = require('@babel/parser'), traverse = require('@babel/traverse').default;
const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8'), ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
const declarations = new Map(), effects = [], sidebar = new Map();
traverse(ast, {
  VariableDeclarator({ node, parent }) {
    if (['setActiveTab', 'fetchDevices', 'previousDevicePageRef'].includes(node.id.name)) declarations.set(node.id.name, parent);
  },
  CallExpression({ node, parent }) {
    if (node.callee.name !== 'useEffect') return;
    const body = source.slice(node.arguments[0].start, node.arguments[0].end);
    if (body.includes('previousDevicePageRef.current') || body.includes("document.addEventListener('visibilitychange'") || body.includes('loadInitialSettings();')) effects.push(parent);
  },
  JSXAttribute({ node }) {
    if (node.name.name !== 'onClick' || node.value?.type !== 'JSXExpressionContainer') return;
    const callback = node.value.expression, call = callback.body;
    if (callback.type === 'ArrowFunctionExpression' && call?.type === 'CallExpression' && call.callee.name === 'setActiveTab'
      && ['devices', 'settings', 'serial'].includes(call.arguments[0]?.value)) sidebar.set(call.arguments[0].value, source.slice(callback.start, callback.end));
  },
});
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture({ page = 'devices', initialRows = [], discover = async () => initialRows } = {}) {
  assert.ok(declarations.get('previousDevicePageRef'), 'App must fence a real device-page transition');
  assert.equal(effects.length, 3, 'Execute the actual entry, startup and polling effects');
  const ordered = [...declarations.values(), ...effects].sort((first, second) => first.start - second.start);
  const effectSlots = [], refs = [], memoSlots = [], jobs = [], listeners = new Map(), timers = new Map(), calls = [];
  const state = { devices: initialRows, active: initialRows[0]?.id || '', loading: false, error: '' };
  let navigation = { activeTab: page, sshVisited: false, aiToolsVisited: false, aiVisited: false }, effectIndex, refIndex, memoIndex, timerId = 0;
  const target = name => ({ addEventListener: (event, callback) => listeners.set(name + ':' + event, callback), removeEventListener: event => listeners.delete(name + ':' + event) });
  const context = {
    tr, singleFlight, resolveActiveDeviceId, worksetTargetRef: { current: '' }, devicesRef: { current: initialRows },
    document: { ...target('document'), visibilityState: 'visible' },
    window: { ...target('window'), electronAPI: {
      getDevices: async () => { calls.push('getDevices'); return discover(); }, loadAllSettings: async () => ({ success: true, data: {} }),
      loadConnectionHistory: async () => ({ success: true, data: [] }), loadTerminalHistory: async () => ({ success: true, data: [] }),
    } },
    setNavigation: update => { navigation = update(navigation); }, setDevices: update => { state.devices = update(state.devices); },
    setActiveDeviceId: update => { state.active = update(state.active); }, setLoading: value => { state.loading = value; }, setError: value => { state.error = value; },
    useCallback: callback => callback,
    useMemo(callback) { const index = memoIndex++; return memoSlots[index] || (memoSlots[index] = callback()); },
    useRef(value) { const index = refIndex++; return refs[index] || (refs[index] = { current: value }); },
    useEffect(callback, deps) {
      const index = effectIndex++, previous = effectSlots[index];
      if (previous && deps.every((value, dependency) => Object.is(value, previous.deps[dependency]))) return;
      const slot = { deps, cleanup: previous?.cleanup }; effectSlots[index] = slot;
      jobs.push(() => { slot.cleanup?.(); slot.cleanup = callback(); });
    },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id),
    refreshVipStatus() {}, setCustomThemes() {}, setCustomThemesLoaded() {}, setConnectionHistory() {}, setTerminalCommandHistory() {}, setHarmonyTerminalCommandHistory() {},
    inspectionPathLoadedRef: { current: false }, performancePathLoadedRef: { current: false }, taskCenterPathLoadedRef: { current: false }, qualityCenterPathLoadedRef: { current: false },
  };
  const program = `(function renderEntry(navigation) { const { activeTab } = navigation; ${ordered.map(node => source.slice(node.start, node.end)).join('\n')} return { fetchDevices, setActiveTab, sidebar: { ${[...sidebar].map(([pageName, callback]) => JSON.stringify(pageName) + ': ' + callback).join(',')} } }; })`;
  const renderActual = runInNewContext(program, context); let current;
  const render = () => { effectIndex = 0; refIndex = 0; memoIndex = 0; current = renderActual(navigation); for (const job of jobs.splice(0)) job(); return current; };
  render();
  return { state, calls, render, manual: () => current.fetchDevices(),
    click: next => { assert.ok(current.sidebar[next]); current.sidebar[next](); render(); },
    fire: event => { assert.ok(listeners.has(event)); listeners.get(event)(); },
    tick: () => { const [id, job] = timers.entries().next().value; assert.equal(job.delay, 5000); timers.delete(id); return job.callback(); },
    dispose: () => { for (const slot of effectSlots) slot.cleanup?.(); },
  };
}

test('initial startup remains one discovery and actual same-page navigation or rerenders add none', async t => {
  for (const page of ['devices', 'settings']) {
    const h = fixture({ page }); t.after(h.dispose); await flush(); assert.equal(h.calls.length, 1);
    h.render(); h.click(page); h.render(); await flush(); assert.equal(h.calls.length, 1);
  }
});

test('each committed other-page to devices transition uses the actual sidebar callback exactly once', async t => {
  const h = fixture(); t.after(h.dispose); await flush();
  h.click('settings'); await flush(); assert.equal(h.calls.length, 1);
  h.click('devices'); await flush(); assert.equal(h.calls.length, 2);
  h.render(); h.click('devices'); await flush(); assert.equal(h.calls.length, 2);
  h.click('serial'); h.click('devices'); await flush(); assert.equal(h.calls.length, 3);
});

test('entry, manual, polling and visibility discovery share one flight and retain displayed rows while pending', async t => {
  const rows = [{ id: 'USB-A', model: 'Named fixture', status: 'device' }]; let release, pending = false;
  const h = fixture({ initialRows: rows, discover: () => pending ? new Promise(resolve => { release = resolve; }) : Promise.resolve(rows) }); t.after(h.dispose); await flush();
  pending = true; h.click('settings'); const manual = h.manual(); await flush();
  assert.equal(h.calls.length, 2); assert.equal(h.state.devices, rows); assert.equal(h.state.loading, true);
  const poll = h.tick(); h.click('devices'); h.fire('window:focus'); h.fire('document:visibilitychange'); await flush();
  assert.equal(h.calls.length, 2); assert.equal(h.state.devices, rows);
  release(rows); await manual; await poll; await flush(); assert.equal(h.state.loading, false); assert.equal(h.state.active, 'USB-A');
});

test('failed page-entry refresh keeps prior identities and selection and the next entry can recover', async t => {
  const rows = [{ id: 'WiFi-A:5555', model: 'Retained board', status: 'device' }]; let reject = false;
  const h = fixture({ initialRows: rows, discover: async () => { if (reject) throw Error('isolated discovery failure'); return rows; } }); t.after(h.dispose); await flush();
  reject = true; h.click('settings'); h.click('devices'); await flush();
  assert.equal(h.calls.length, 2); assert.equal(h.state.devices.length, 1); assert.equal(h.state.devices[0].id, rows[0].id);
  assert.equal(h.state.devices[0].model, rows[0].model); assert.equal(h.state.devices[0].status, 'offline');
  assert.equal(h.state.active, rows[0].id); assert.equal(h.state.loading, false); assert.match(h.state.error, /isolated discovery failure/);
  reject = false; h.click('serial'); h.click('devices'); await flush(); assert.equal(h.calls.length, 3);
  assert.deepEqual(h.state.devices, rows); assert.equal(h.state.error, '');
});
