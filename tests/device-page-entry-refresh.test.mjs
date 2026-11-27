import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { resolveActiveDeviceId, singleFlight } from '../src/shared/deviceWorkflow.js';
import { tr } from '../src/shared/i18n.js';
import { centerPage } from '../src/shared/workbenchCenters.js';

const require = createRequire(import.meta.url), { parse } = require('@babel/parser'), traverse = require('@babel/traverse').default;
const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8'), ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
const declarations = new Map(), effects = [];
let discoveryNoticeGate, sidebarNavigation, settingsStickyClasses;
traverse(ast, {
  VariableDeclarator({ node, parent }) {
    if (['setActiveTab', 'fetchDevices', 'previousDevicePageRef', 'refreshConnectionHistory', 'selectCenterLeaf', 'navigateSidebar'].includes(node.id.name)) declarations.set(node.id.name, parent);
  },
  CallExpression({ node, parent }) {
    if (node.callee.name !== 'useEffect') return;
    const body = source.slice(node.arguments[0].start, node.arguments[0].end);
    if (body.includes('previousDevicePageRef.current') || body.includes("document.addEventListener('visibilitychange'") || body.includes('loadInitialSettings();')) effects.push(parent);
  },
  JSXAttribute({ node, parent }) {
    if (parent.name?.name === 'WorkbenchSidebar' && node.name.name === 'onNavigate' &&
        node.value?.expression?.type === 'Identifier') sidebarNavigation = node.value.expression.name;
  },
  JSXElement({ node }) {
    if (!node.children.some(child => child.type === 'JSXElement' && child.openingElement.name.name === 'SettingsCategoryTabs')) return;
    const classes = node.openingElement.attributes.find(attribute => attribute.name?.name === 'className');
    settingsStickyClasses = classes?.value?.expression?.quasis?.flatMap(quasi => quasi.value.cooked.trim().split(/\s+/));
  },
  JSXExpressionContainer({ node }) {
    const expression = node.expression;
    if (expression.type === 'LogicalExpression' && expression.right.type === 'JSXElement' &&
        source.slice(expression.right.start, expression.right.end).includes('{tr(error)}')) {
      discoveryNoticeGate = source.slice(expression.left.start, expression.left.end);
    }
  },
});

test('device discovery warnings do not appear in preferences or independent transport workspaces', () => {
  assert.ok(discoveryNoticeGate, 'Evaluate the actual discovery banner render gate');
  const available = (activeTab, error) => noticeVisible(activeTab, error, { visible: true });
  for (const page of ['firmware', 'serial', 'ssh', 'settings']) assert.equal(available(page, 'HDC unavailable'), false, page);
  for (const page of ['devices', 'tasks', 'performance']) assert.equal(available(page, 'HDC unavailable'), true, page);
  assert.equal(available('devices', ''), false);
});
test('settings category tabs pin without pulling over preceding settings notices', () => {
  assert.ok(settingsStickyClasses?.includes('sticky'));
  assert.ok(settingsStickyClasses.includes('top-0'));
  assert.equal(settingsStickyClasses.some(token => /(?:^|:)-(?:mt|top)-/.test(token)), false);
  assert.match(source, /\{workspaceSaveError && <div role="status"/);
  assert.match(source, /\{applicationSaveError && <div role="status"/);
});
const noticeVisible = (activeTab, error, taskDiscoveryWarning) =>
  Boolean(runInNewContext(discoveryNoticeGate, { activeTab, error, taskDiscoveryWarning }));

const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture({ page = 'devices', initialRows = [], discover = async () => initialRows } = {}) {
  assert.ok(declarations.get('previousDevicePageRef'), 'App must fence a real device-page transition');
  assert.ok(declarations.has(sidebarNavigation), 'Exercise the callback actually bound to the sidebar');
  assert.equal(effects.length, 3, 'Execute the actual entry, startup and polling effects');
  const ordered = [...declarations.values(), ...effects].sort((first, second) => first.start - second.start);
  const effectSlots = [], refs = [], memoSlots = [], jobs = [], listeners = new Map(), timers = new Map(), calls = [];
  const state = { devices: initialRows, active: initialRows[0]?.id || '', loading: false, error: '',
    taskDiscoveryWarning: { failures: 0, visible: false } };
  let navigation = { activeTab: page, sshVisited: false, aiToolsVisited: false, aiVisited: false }, effectIndex, refIndex, memoIndex, timerId = 0;
  const target = name => ({ addEventListener: (event, callback) => listeners.set(name + ':' + event, callback), removeEventListener: event => listeners.delete(name + ':' + event) });
  const membershipOriginRef = { current: null };
  const context = {
    tr, singleFlight, resolveActiveDeviceId, centerPage, rememberedCenterPages: { current: {} },
    historyVersion: { current: 0 }, worksetTargetRef: { current: '' }, devicesRef: { current: initialRows },
    membershipOriginRef, rememberMembershipOrigin: origin => { membershipOriginRef.current = origin; },
    document: { ...target('document'), visibilityState: 'visible' },
    window: { ...target('window'), electronAPI: {
      getDevices: async progress => { calls.push('getDevices'); return discover(progress); }, loadAllSettings: async () => ({ success: true, data: {} }),
      loadConnectionHistory: async () => ({ success: true, data: [] }), loadTerminalHistory: async () => ({ success: true, data: [] }),
    } },
    setNavigation: update => { navigation = update(navigation); }, setDevices: update => { state.devices = update(state.devices); },
    setActiveDeviceId: update => { state.active = update(state.active); }, setLoading: value => { state.loading = value; }, setError: value => { state.error = value; },
    setTaskDiscoveryWarning: update => { state.taskDiscoveryWarning = update(state.taskDiscoveryWarning); },
    useCallback(callback, deps) {
      const index = memoIndex++, previous = memoSlots[index];
      if (previous && deps.every((value, i) => value === previous.deps[i])) return previous.callback;
      memoSlots[index] = { callback, deps }; return callback;
    },
    useMemo(callback) { const index = memoIndex++; return memoSlots[index] || (memoSlots[index] = callback()); },
    useRef(value) { const index = refIndex++; return refs[index] || (refs[index] = { current: value }); },
    useEffect(callback, deps) {
      const index = effectIndex++, previous = effectSlots[index];
      if (previous && deps.every((value, dependency) => Object.is(value, previous.deps[dependency]))) return;
      const slot = { deps, cleanup: previous?.cleanup }; effectSlots[index] = slot;
      jobs.push(() => { slot.cleanup?.(); slot.cleanup = callback(); });
    },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id),
    setCustomThemes() {}, setCustomThemesLoaded() {}, setConnectionHistory() {}, setTerminalCommandHistory() {}, setHarmonyTerminalCommandHistory() {},
    inspectionPathLoadedRef: { current: false }, performancePathLoadedRef: { current: false }, taskCenterPathLoadedRef: { current: false }, qualityCenterPathLoadedRef: { current: false },
  };
  const program = `(function renderEntry(navigation) { const { activeTab } = navigation; ${ordered.map(node => source.slice(node.start, node.end)).join('\n')} return { fetchDevices, navigate: ${sidebarNavigation} }; })`;
  const renderActual = runInNewContext(program, context); let current;
  const render = () => { effectIndex = 0; refIndex = 0; memoIndex = 0; current = renderActual(navigation); for (const job of jobs.splice(0)) job(); return current; };
  render();
  return { state, calls, render, manual: () => current.fetchDevices(),
    notice: (page = navigation.activeTab) => noticeVisible(page, state.error, state.taskDiscoveryWarning),
    click: next => { current.navigate(next); render(); },
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

test('Task Center waits for a second complete background failure, not duplicate terminal progress', async t => {
  const online = { id: 'USB-A', model: 'Retained device', status: 'device' };
  const healthy = { devices: [online], channels: { adb: 'ready', hdc: 'ready' } };
  const unavailable = { devices: [{ ...online, status: 'unconfirmed' }], channels: { adb: 'unconfirmed', hdc: 'ready' } };
  let response = healthy;
  const h = fixture({ page: 'tasks', initialRows: [online], discover: async report => {
    report(response);
    report(response);
    return response;
  } });
  t.after(h.dispose);
  await flush();
  response = unavailable;
  await h.tick();
  assert.equal(h.state.taskDiscoveryWarning.failures, 1);
  assert.equal(h.notice(), false);
  assert.equal(h.notice('devices'), true);
  assert.equal(h.state.active, online.id);
  assert.equal(h.state.devices[0].status, 'unconfirmed', 'Presentation must not mark a failed ADB transport confirmed');
  await h.tick();
  assert.equal(h.state.taskDiscoveryWarning.failures, 2);
  assert.equal(h.notice(), true);
  response = healthy;
  await h.tick();
  assert.equal(h.state.taskDiscoveryWarning.failures, 0);
  assert.equal(h.notice(), false);
  assert.equal(h.state.devices[0].status, 'device');
  response = unavailable;
  await h.manual();
  assert.equal(h.state.taskDiscoveryWarning.failures, 1);
  assert.equal(h.notice(), true, 'Explicit refresh still reports a failed probe immediately');
});

test('Task Center does not suppress a background failure when there is no retained confirmed device', async t => {
  let fail = false;
  const h = fixture({ page: 'tasks', discover: async () => {
    if (fail) throw new Error('ADB unavailable');
    return [];
  } });
  t.after(h.dispose);
  await flush();
  fail = true;
  await h.tick();
  assert.equal(h.state.taskDiscoveryWarning.failures, 1);
  assert.equal(h.notice(), true);
  assert.deepEqual(h.state.devices, []);
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
  assert.equal(h.state.devices[0].model, rows[0].model); assert.equal(h.state.devices[0].status, 'unconfirmed');
  assert.equal(h.state.active, rows[0].id); assert.equal(h.state.loading, false); assert.match(h.state.error, /isolated discovery failure/);
  reject = false; h.click('serial'); h.click('devices'); await flush(); assert.equal(h.calls.length, 3);
  assert.deepEqual(h.state.devices, rows); assert.equal(h.state.error, '');
});
