import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import * as helpers from '../src/shared/applicationPicker.js';

const { APPLICATION_RECENTS_KEY, applicationDeviceKey, normalizeApplications, readApplications,
  filterApplications, readApplicationRecents, rememberApplication, normalizeApplicationRecents, validApplicationPackage } = helpers;
const memory = () => { const values = new Map(); return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; };
const device = (id, generation = 0) => ({ id, generation, status: 'device' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

test('first-open search focus waits for a visible animation frame and never steals a later user focus', () => {
  const require = createRequire(import.meta.url), { parse } = require('@babel/parser'), traverse = require('@babel/traverse').default;
  const source = fs.readFileSync(new URL('../src/components/ApplicationPicker.jsx', import.meta.url), 'utf8'); let callback;
  traverse(parse(source, { sourceType: 'module', plugins: ['jsx'] }), { CallExpression({ node }) {
    if (!['useEffect', 'useLayoutEffect'].includes(node.callee.name)) return;
    const text = source.slice(node.arguments[0]?.start, node.arguments[0]?.end);
    if (text.includes('open && placed') || text.includes('!open || !placed')) callback = node.arguments[0];
  } });
  assert.ok(callback);
  const frames = new Map(), trigger = { current: {} }, body = {}, document = { body, activeElement: trigger.current }; let focused = 0;
  const focus = vm.runInNewContext(`(${source.slice(callback.start, callback.end)})`, { open: true, placed: true, trigger, document,
    search: { current: { focus: () => focused++ } }, requestAnimationFrame: fn => { frames.set(1, fn); return 1; }, cancelAnimationFrame: id => frames.delete(id) });
  const cleanup = focus(); assert.equal(focused, 0); assert.equal(frames.size, 1);
  frames.get(1)(); assert.equal(focused, 1); cleanup(); assert.equal(frames.size, 0);
  focused = 0; const cancel = focus(); document.activeElement = {}; frames.get(1)(); assert.equal(focused, 0); cancel();
  document.activeElement = body; const leave = focus(); leave(); assert.equal(frames.size, 0); assert.equal(focused, 0);
});

test('package rows are bounded, deduplicated, display only reliable labels, and search both names and packages', () => {
  const rows = normalizeApplications(['com.a', { packageName: 'com.b', label: 'Browser' }, { packageName: 'com.c', name: 'Camera' },
    { packageName: 'com.a', label: 'duplicate' }, { packageName: 'com.invalid x' }, { packageName: 'com.d', label: '\nwrong' }]);
  assert.deepEqual(rows.map(row => row.label), ['com.a', 'Browser', 'Camera', 'com.d']);
  assert.deepEqual(filterApplications(rows, 'BROW').map(row => row.packageName), ['com.b']);
  assert.deepEqual(filterApplications(rows, 'com.c').map(row => row.packageName), ['com.c']);
  assert.deepEqual(filterApplications(rows, '', ['com.c', 'com.b']).slice(0, 2).map(row => row.packageName), ['com.c', 'com.b']);
  assert.equal(normalizeApplications(Array.from({ length: 2100 }, (_, i) => `com.pkg${i}`)).length, 2000);
  for (const value of ['bad space', 'a;reboot', 'x\n', 'a'.repeat(257)]) assert.equal(validApplicationPackage(value), false);
  assert.equal(applicationDeviceKey(device('USB A')), '');
});

test('list reads are explicit, deduplicate inflight work, expire, retry failures, and never call commands', async () => {
  const pending = deferred(); let reads = 0, executions = 0;
  const api = { packageList: () => { reads++; return reads === 1 ? pending.promise : { ok: true, packages: ['com.new'] }; }, execute: () => executions++ };
  const target = device('picker-cache-ttl'); assert.equal(reads, 0);
  const first = readApplications(api, target, { now: 1000 }), same = readApplications(api, target, { now: 1000 }); await flush();
  assert.equal(reads, 1); pending.resolve({ ok: true, packages: ['com.old'] }); assert.deepEqual(await first, await same);
  assert.equal((await readApplications(api, target, { now: 60000 }))[0].packageName, 'com.old'); assert.equal(reads, 1);
  assert.equal((await readApplications(api, target, { now: 62000 }))[0].packageName, 'com.new'); assert.equal(reads, 2);
  await assert.rejects(readApplications(api, { ...target, status: 'offline' })); assert.equal(reads, 2);
  const retryApi = { packageList: async () => ++reads === 3 ? { ok: false } : { ok: true, packages: ['com.retry'] } };
  await assert.rejects(readApplications(retryApi, target)); assert.equal((await readApplications(retryApi, target))[0].packageName, 'com.retry');
  assert.equal(executions, 0);
});

test('old generation and old refresh completion cannot replace a newly cached list', async () => {
  const pending = []; const api = { packageList: () => { const item = deferred(); pending.push(item); return item.promise; } };
  const old = readApplications(api, device('picker-generation', 0)); await flush();
  const latest = readApplications(api, device('picker-generation', 1)); await flush();
  pending[1].resolve({ ok: true, packages: ['com.generation1'] }); await latest;
  pending[0].resolve({ ok: true, packages: ['com.generation0'] }); await old;
  assert.equal((await readApplications(api, device('picker-generation', 1)))[0].packageName, 'com.generation1');
  const first = readApplications(api, device('picker-generation', 1), { refresh: true }); await flush();
  const second = readApplications(api, device('picker-generation', 1), { refresh: true }); await flush();
  pending[3].resolve({ ok: true, packages: ['com.latest'] }); await second;
  pending[2].resolve({ ok: true, packages: ['com.stale'] }); await first;
  assert.equal((await readApplications(api, device('picker-generation', 1)))[0].packageName, 'com.latest');
});

test('recents are exact-device metadata, bounded, and preserve original corrupt bytes or failed writes', () => {
  const storage = memory();
  for (let index = 0; index < 8; index++) rememberApplication('A', `com.app${index}`, storage);
  rememberApplication('hdc:A', 'com.harmony', storage);
  assert.equal(readApplicationRecents(storage).items.find(item => item.deviceId === 'A').packages.length, 6);
  assert.equal(readApplicationRecents(storage).items[0].deviceId, 'hdc:A');
  for (let index = 0; index < 25; index++) rememberApplication(`D${index}`, 'com.app', storage);
  assert.equal(readApplicationRecents(storage).items.length, 20);
  const before = storage.values.get(APPLICATION_RECENTS_KEY); rememberApplication('D24', '', storage); assert.equal(storage.values.get(APPLICATION_RECENTS_KEY), before);
  storage.values.set(APPLICATION_RECENTS_KEY, '{corrupt'); assert.throws(() => rememberApplication('A', 'com.app', storage)); assert.equal(storage.values.get(APPLICATION_RECENTS_KEY), '{corrupt');
  storage.values.set(APPLICATION_RECENTS_KEY, before); storage.setItem = () => { throw new Error('quota'); };
  assert.throws(() => rememberApplication('A', 'com.app', storage), /quota/); assert.equal(storage.values.get(APPLICATION_RECENTS_KEY), before);
  assert.throws(() => normalizeApplicationRecents({ version: 1, items: [], command: 'reboot' }));
  assert.throws(() => normalizeApplicationRecents({ version: 1, items: [{ deviceId: 'A', packages: ['com.a'], logs: 'secret' }] }));
});

function componentHarness(api, storage = memory()) {
  const slots = []; let cursor = 0, props, effects = [], cleanups = [], changes = [], focus = 0;
  const source = fs.readFileSync(new URL('../src/components/ApplicationPicker.jsx', import.meta.url), 'utf8');
  const logic = source.slice(0, source.indexOf('  return <div')).replace(/^import .+;\n/gm, '').replace('export default function ApplicationPicker', 'function ApplicationPicker');
  const component = vm.runInNewContext(`${logic}\nreturn { show, load, select, keyboard, change, current, filtered, open, trigger, search, position }; }\nApplicationPicker`, {
    ...helpers, readApplicationRecents: () => readApplicationRecents(storage), rememberApplication: (id, name) => rememberApplication(id, name, storage),
    window: { electronAPI: api, innerWidth: 1000, innerHeight: 800 }, localStorage: storage, document: { body: {} },
    tr: text => text, useLocale: () => 'zh-CN', isDarkTheme: () => false, useId: () => 'fixture-picker',
    useLayoutEffect: () => {}, useEffect(fn, deps) { if (!deps.length) effects.push(fn); },
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
  });
  const render = (next = props) => { props = next; cursor = 0; const ui = component({ theme: {}, onChange: value => changes.push(value), ...props }); ui.trigger.current = { closest: () => null, focus: () => focus++, getBoundingClientRect: () => ({ left: 20, top: 60, bottom: 100, width: 400 }) }; ui.search.current = {}; return ui; };
  const commit = () => { cleanups.push(...effects.splice(0).map(fn => fn()).filter(Boolean)); };
  return { render, commit, unmount: () => cleanups.splice(0).forEach(fn => fn()), changes, get focus() { return focus; } };
}

test('opening calculates popup placement before its first render instead of mounting a hidden subtree', () => {
  const h = componentHarness({ packageList: async () => ({ ok: true, packages: [] }) });
  const ui = h.render({ device: device('first-visible') }); h.commit(); ui.show();
  assert.equal(h.render().open, true);
  assert.deepEqual(JSON.parse(JSON.stringify(h.render().position)), { left: 20, top: 106, width: 400, maxHeight: 380 });
});

test('actual picker callbacks lazily load and fence device/generation/unmount replies; selecting is metadata only', async () => {
  const pending = []; let executions = 0;
  const h = componentHarness({ packageList: args => { const item = deferred(); pending.push({ ...item, args }); return item.promise; }, adbShell: () => executions++ });
  let ui = h.render({ device: device('component-A', 0) }); h.commit(); assert.equal(pending.length, 0);
  ui.show(); await flush(); assert.equal(pending.length, 1);
  ui = h.render({ device: device('component-A', 1) }); ui.show(); await flush(); assert.equal(pending.length, 2);
  pending[1].resolve({ ok: true, packages: [{ packageName: 'com.current', label: 'Current' }] }); await flush();
  pending[0].resolve({ ok: true, packages: ['com.stale'] }); await flush();
  ui = h.render(); assert.equal(ui.current.items[0].packageName, 'com.current');
  ui.change({ query: 'CURRENT', active: 0 }); ui = h.render(); assert.equal(ui.filtered.length, 1);
  let prevented = 0; ui.keyboard({ key: 'Enter', preventDefault: () => prevented++, target: { closest: () => null } });
  assert.deepEqual(h.changes, ['com.current']); assert.equal(h.focus, 1); assert.equal(prevented, 1);
  ui = h.render({ device: device('component-B', 0) }); ui.show(); await flush(); h.unmount();
  pending[2].resolve({ ok: true, packages: ['com.unmounted'] }); await flush(); assert.equal(h.render().current.items.length, 0);
  assert.equal(executions, 0);
});

test('actual picker offline/manual/error paths remain usable and Escape returns focus', async () => {
  const storage = memory(); rememberApplication('offline', 'com.recent', storage);
  let reads = 0; const h = componentHarness({ packageList: async () => { reads++; throw new Error('failure'); } }, storage);
  let ui = h.render({ device: { id: 'offline', status: 'offline' } }); h.commit(); ui.show(); await flush(); ui = h.render();
  assert.equal(reads, 0); assert.equal(ui.filtered[0].packageName, 'com.recent'); assert.ok(ui.current.error);
  ui.select('com.manual'); assert.deepEqual(h.changes, ['com.manual']); assert.equal(reads, 0);
  ui = h.render({ device: device('component-error') }); ui.show(); await flush(); ui = h.render(); assert.ok(ui.current.error);
  const before = h.changes.length; ui.select('bad;command'); assert.equal(h.changes.length, before);
  ui.keyboard({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); assert.equal(h.render().open, false);
  ui.select('com.valid'); assert.deepEqual(h.changes, ['com.manual', 'com.valid']);
});
