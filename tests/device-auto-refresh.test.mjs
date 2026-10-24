import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { singleFlight } from '../src/shared/deviceWorkflow.js';
import { tr } from '../src/shared/i18n.js';

const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
let pollingEffect;
let selectionEffect;
let eligibleExpression;
traverse(ast, {
  CallExpression({ node }) {
    if (node.callee.name !== 'useEffect') return;
    const body = source.slice(node.arguments[0].start, node.arguments[0].end);
    if (body.includes("document.addEventListener('visibilitychange'")) pollingEffect = body;
    if (body.includes('previousActiveDeviceIdRef.current')) selectionEffect = body;
  },
  VariableDeclarator({ node }) {
    if (node.id.name === 'eligibleDevices') eligibleExpression = source.slice(node.init.start, node.init.end);
  },
});

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function pollHarness(action = async () => {}) {
  const listeners = new Map(); const timers = new Map(); let nextTimer = 0; let calls = 0;
  const target = name => ({
    addEventListener: (event, fn) => listeners.set(`${name}:${event}`, fn),
    removeEventListener: (event, fn) => { assert.equal(listeners.get(`${name}:${event}`), fn); listeners.delete(`${name}:${event}`); },
  });
  const document = { ...target('document'), visibilityState: 'visible' };
  assert.ok(pollingEffect);
  const cleanup = runInNewContext(`(${pollingEffect})`, {
    window: target('window'), document,
    fetchDevices: singleFlight(async options => { assert.equal(options.silent, true); calls++; await action(); }),
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  })();
  return { listeners, timers, document, cleanup, calls: () => calls,
    fire: async event => { assert.ok(listeners.has(event)); listeners.get(event)(); await flush(); },
    tick: async () => { const [id, { fn, delay }] = timers.entries().next().value; assert.equal(delay, 5000); timers.delete(id); await fn(); },
  };
}

test('App refreshes every five seconds and immediately on focus without overlapping requests', async () => {
  let release;
  const h = pollHarness(() => new Promise(resolve => { release = resolve; }));
  assert.equal(h.calls(), 0);
  await h.fire('window:focus'); await h.fire('window:focus');
  assert.equal(h.calls(), 1);
  release(); await flush();
  assert.equal(h.timers.size, 1);
  const pendingTick = h.tick(); await flush(); assert.equal(h.calls(), 2);
  release(); await pendingTick;
  h.cleanup();
  assert.equal(h.listeners.size, 0); assert.equal(h.timers.size, 0);
});

test('hidden window pauses discovery and resumes immediately when visible', async () => {
  const h = pollHarness();
  h.document.visibilityState = 'hidden';
  await h.tick(); await h.fire('window:focus');
  assert.equal(h.calls(), 0);
  h.document.visibilityState = 'visible';
  await h.fire('document:visibilitychange');
  assert.equal(h.calls(), 1); assert.equal(h.timers.size, 1);
  h.cleanup();
});

test('cleanup during refresh prevents a late response from restarting the poll timer', async () => {
  let release;
  const h = pollHarness(() => new Promise(resolve => { release = resolve; }));
  await h.fire('window:focus'); h.cleanup(); release(); await flush();
  assert.equal(h.timers.size, 0); assert.equal(h.listeners.size, 0);
});

test('selection feedback is brief, once per unavailable selection change, never every refresh', () => {
  assert.ok(selectionEffect);
  const notices = [];
  const scope = { tr, previousActiveDeviceIdRef: { current: 'wifi' }, activeDeviceId: 'usb',
    devices: [{ id: 'usb', status: 'device', model: 'Board' }], deviceNames: { usb: 'My device' }, showToast: message => notices.push(message) };
  const effect = runInNewContext(`(${selectionEffect})`, scope);
  effect(); effect();
  assert.equal(notices.length, 1); assert.match(notices[0], /My device/);
  scope.devices.push({ id: 'wifi', status: 'device' }); scope.activeDeviceId = 'wifi'; effect();
  assert.equal(notices.length, 1);
  scope.activeDeviceId = 'missing'; effect(); assert.equal(notices.length, 1);
});

test('free device card follows the current selection while remaining limited to one device', () => {
  const devices = [{ id: 'wifi', status: 'offline' }, { id: 'usb', status: 'device' }];
  const evaluate = isVipOrLoading => runInNewContext(eligibleExpression, { devices, activeDevice: devices[1], isVipOrLoading });
  assert.deepEqual(Array.from(evaluate(false)), [devices[1]]);
  assert.equal(evaluate(true), devices);
});
