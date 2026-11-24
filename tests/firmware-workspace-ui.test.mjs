import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { firmwareDriverAction } from '../src/components/FirmwareWorkspaceState.js';

const source = readFileSync(new URL('../src/components/FirmwareWorkspaceState.js', import.meta.url), 'utf8')
  .replace(/^import .+;\n/gm, '').replaceAll('export function ', 'function ');
const flush = () => new Promise(resolve => setImmediate(resolve));

function mount(electronAPI, entryDevice) {
  let cursor = 0;
  let props = { active: true, entryDevice };
  const slots = [], effects = [];
  const timers = new Set();
  const values = new Map();
  function changed(old = [], next = []) {
    return old.length !== next.length || next.some((value, index) => !Object.is(value, old[index]));
  }
  const runtime = {
    tr: value => value,
    window: { electronAPI },
    localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout: callback => timers.add(callback) && callback,
    clearTimeout: callback => timers.delete(callback),
    useCallback(fn, deps) {
      const index = cursor++;
      if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { fn, deps };
      return slots[index].fn;
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || changed(previous.deps, deps)) effects.push(() => {
        previous?.cleanup?.();
        slots[index] = { deps, cleanup: effect() };
      });
    },
    useRef: value => (slots[cursor++] ??= { current: value }),
    useState(initial) {
      const slot = slots[cursor++] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slot.value, next => { slot.value = typeof next === 'function' ? next(slot.value) : next; }];
    },
  };
  const model = runInNewContext(`(function(){${source};return { useFirmwareWorkspace, readFirmwarePlatform };})()`, runtime);
  const view = () => {
    cursor = 0;
    const value = model.useFirmwareWorkspace(props);
    for (const effect of effects.splice(0)) effect();
    for (const timer of Array.from(timers)) { timers.delete(timer); timer(); }
    return value;
  };
  view();
  return {
    view, model,
    entry: next => { props = { ...props, entryDevice: next }; },
    active: next => { props = { ...props, active: next }; },
    unmount: () => slots.forEach(slot => slot?.cleanup?.()),
  };
}

const vendorStatus = state => ({ ok: true, state, devices: [], installer: { available: true }, tool: { available: true } });

test('driver action preserves installation and offers reinstallation for known installed packages only', () => {
  const status = state => ({ state, installer: { canChoose: true } });
  for (const state of ['installed', 'bound']) assert.equal(firmwareDriverAction(status(state)), 'reinstall');
  assert.equal(firmwareDriverAction({ ...status('problem'), driverPackage: { inf: 'rockusb.inf' } }), 'reinstall');
  for (const state of ['missing', 'problem']) assert.equal(firmwareDriverAction(status(state)), 'install');
  assert.equal(firmwareDriverAction(status('unknown')), null);
  assert.equal(firmwareDriverAction(status('installed'), 'probe failed'), null);
  assert.equal(firmwareDriverAction({ state: 'installed', installer: { available: false } }), null);
});

test('the card hint applies once and explicit changes keep platform firmware selections separate', async () => {
  const selected = [];
  let cancel = false;
  const ui = mount({
    firmwareStatus: async () => vendorStatus('installed'),
    firmwareChooseFile: async platform => { selected.push(platform); return cancel ? { cancelled: true } : { ok: true, fileName: platform }; },
  }, { platformHint: 'mtk', requestId: 'card-a' });
  await flush();
  assert.equal(ui.view().platform, 'mtk');
  await ui.view().act('file');
  ui.view().changePlatform('rk');
  assert.equal(ui.view().platform, 'rk');
  assert.equal(ui.model.readFirmwarePlatform(), 'rk');
  await ui.view().act('file');
  ui.view().changePlatform('mtk');
  cancel = true;
  await ui.view().act('file');
  assert.equal(ui.view().file.fileName, 'mtk');
  assert.deepEqual(selected, ['mtk', 'rk', 'mtk']);
  ui.entry({ platformHint: 'rk', requestId: 'card-b' });
  assert.equal(ui.view().file.fileName, 'rk');
  ui.unmount();
});

test('a single install operation rechecks driver state and does not call the vendor tool', async () => {
  const actions = [];
  let state = 'missing';
  let release;
  const ui = mount({
    firmwareStatus: async () => { actions.push('check'); return vendorStatus(state); },
    firmwareInstallDriver: async () => { actions.push('install'); return new Promise(resolve => { release = resolve; }); },
    firmwareOpenTool: async () => { actions.push('open'); return { ok: true }; },
  });
  await flush();
  assert.equal(ui.view().status.state, 'missing');
  const install = ui.view().act('install');
  assert.equal(ui.view().busy, 'install');
  await ui.view().act('vendor');
  state = 'installed';
  release({ ok: true, code: 'restart-required' });
  await install;
  assert.equal(ui.view().busy, '');
  assert.equal(ui.view().status.state, 'installed');
  assert.match(ui.view().notice, /重启/);
  assert.deepEqual(actions, ['check', 'install', 'check']);
  ui.unmount();
});

test('vendor tool opens with no selected firmware or connected device and launch errors stay inline', async () => {
  const actions = [];
  let response = { ok: false, error: 'vendor launch error' };
  const ui = mount({
    firmwareStatus: async () => vendorStatus('installed'),
    firmwareOpenTool: async platform => { actions.push(platform); return response; },
  });
  await flush();
  assert.equal(ui.view().file, undefined);
  assert.equal(ui.view().status.devices.length, 0);
  await ui.view().act('vendor');
  assert.equal(ui.view().error, 'vendor launch error');
  response = { ok: true };
  await ui.view().act('vendor');
  assert.equal(ui.view().notice, '厂商工具已打开');
  assert.equal(ui.view().error, '');
  assert.deepEqual(actions, ['rk', 'rk']);
  ui.unmount();
});

test('uses the post-install probe without a second query and identifies an untrusted tool', async () => {
  let checks = 0;
  const ui = mount({
    firmwareStatus: async () => { checks += 1; return vendorStatus('missing'); },
    firmwareInstallDriver: async () => ({ ok: true, status: vendorStatus('bound') }),
    firmwareOpenTool: async () => ({ ok: false, code: 'untrusted-package' }),
  });
  await flush();
  await ui.view().act('install');
  assert.equal(ui.view().status.state, 'bound');
  assert.equal(checks, 1);
  await ui.view().act('vendor');
  assert.match(ui.view().error, /校验未通过/);
  ui.unmount();
});

test('reinstallation reuses the current platform and accepts the fresh probe without a second scan', async () => {
  const calls = [];
  const ui = mount({
    firmwareStatus: async platform => { calls.push(['probe', platform]); return vendorStatus('installed'); },
    firmwareInstallDriver: async platform => {
      calls.push(['install', platform]);
      return { ok: true, status: vendorStatus('bound') };
    },
  }, { platformHint: 'mtk', requestId: 'reinstall-a' });
  await flush();
  assert.equal(firmwareDriverAction(ui.view().status), 'reinstall');
  await ui.view().act('install');
  assert.equal(ui.view().status.state, 'bound');
  assert.deepEqual(calls, [['probe', 'mtk'], ['install', 'mtk']]);
  ui.unmount();
});

test('page reentry reuses status and only an explicit refresh forces a new driver probe', async () => {
  const calls = [];
  const ui = mount({
    firmwareStatus: async (platform, force) => { calls.push([platform, force]); return vendorStatus('installed'); },
  });
  await flush();
  ui.view();
  ui.active(false);
  ui.view();
  ui.active(true);
  ui.view();
  assert.deepEqual(calls, [['rk', false]]);
  ui.view().changePlatform('mtk');
  ui.view();
  await flush();
  assert.deepEqual(calls, [['rk', false], ['mtk', false]]);
  await ui.view().refresh();
  assert.deepEqual(calls.at(-1), ['mtk', true]);
  ui.view().changePlatform('rk');
  ui.view();
  assert.deepEqual(calls.at(-1), ['rk', false]);
  await flush();
  ui.view().changePlatform('mtk');
  ui.view();
  assert.equal(calls.length, 4);
  ui.unmount();
});

test('the single vendor button selects tools only when needed and never opens after a cancelled picker', async () => {
  const calls = [];
  let picked = { cancelled: true };
  let opened = { ok: true };
  const ui = mount({
    firmwareStatus: async () => ({ ...vendorStatus('installed'), tool: { available: false } }),
    firmwareChooseTools: async () => { calls.push('pick'); return picked; },
    firmwareOpenTool: async () => { calls.push('open'); return opened; },
  });
  await flush();
  await ui.view().act('vendor');
  assert.deepEqual(calls, ['pick']);
  picked = vendorStatus('installed');
  await ui.view().act('vendor');
  assert.deepEqual(calls, ['pick', 'pick', 'open']);
  await ui.view().act('vendor');
  assert.deepEqual(calls.slice(-2), ['open', 'open']);
  opened = { ok: false, code: 'tool-unavailable' };
  await ui.view().act('vendor');
  assert.equal(ui.view().status.tool.available, false);
  picked = { cancelled: true };
  await ui.view().act('vendor');
  assert.equal(calls.at(-1), 'pick');
  ui.unmount();
});
