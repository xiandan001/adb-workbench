import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { firmwareDriverAction } from '../src/components/FirmwareWorkspaceState.js';

const source = readFileSync(new URL('../src/components/FirmwareWorkspaceState.js', import.meta.url), 'utf8')
  .replace(/^import .+;\n/gm, '').replaceAll('export function ', 'function ');
const flush = () => new Promise(resolve => setImmediate(resolve));

function mount(electronAPI, entryDevice, values = new Map()) {
  let cursor = 0;
  let props = { active: true, entryDevice };
  const slots = [], effects = [];
  const timers = new Set();
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

test('the tools disclosure remembers both choices across platforms, page reentry and a fresh workspace', async () => {
  const storage = new Map();
  const api = { firmwareStatus: async () => vendorStatus('installed') };
  const key = 'firmware-workspace-tools-expanded';
  const ui = mount(api, { platformHint: 'rk', requestId: 'rk-start' }, storage);
  assert.equal(ui.view().supportExpanded, undefined);
  assert.equal(storage.has(key), false);
  ui.view().setSupportExpanded(true);
  assert.equal(storage.get(key), 'true');
  ui.view().changePlatform('mtk');
  assert.equal(ui.view().platform, 'mtk');
  assert.equal(ui.view().supportExpanded, true);
  ui.active(false);
  ui.view();
  ui.active(true);
  assert.equal(ui.view().supportExpanded, true);
  ui.unmount();

  const remounted = mount(api, { platformHint: 'rk', requestId: 'rk-remount' }, storage);
  assert.equal(remounted.view().platform, 'rk');
  assert.equal(remounted.view().supportExpanded, true);
  remounted.view().setSupportExpanded(false);
  assert.equal(storage.get(key), 'false');
  remounted.view().changePlatform('mtk');
  assert.equal(remounted.view().supportExpanded, false);
  remounted.unmount();

  const restarted = mount(api, undefined, new Map(storage));
  assert.equal(restarted.view().supportExpanded, false);
  await flush();
  restarted.unmount();
});

test('invalid or blocked tool disclosure storage leaves the default and the current session usable', () => {
  const key = 'firmware-workspace-tools-expanded';
  const malformed = mount({}, undefined, new Map([[key, 'not-a-boolean']]));
  assert.equal(malformed.view().supportExpanded, undefined);
  malformed.unmount();

  const blocked = mount({}, undefined, {
    get() { throw Error('storage blocked'); },
    set() { throw Error('storage blocked'); },
  });
  assert.equal(blocked.view().supportExpanded, undefined);
  blocked.view().setSupportExpanded(true);
  assert.equal(blocked.view().supportExpanded, true);
  blocked.view().setSupportExpanded(false);
  assert.equal(blocked.view().supportExpanded, false);
  blocked.unmount();
});

test('last firmware restoration is read-only, does not block the picker and cannot overwrite a new choice', async () => {
  let sendOld;
  const restoring = new Promise(resolve => { sendOld = resolve; });
  const calls = [];
  const ui = mount({
    firmwareStatus: async () => vendorStatus('installed'),
    firmwareRestoreFile: platform => { calls.push(['restore', platform]); return restoring; },
    firmwareChooseFile: async platform => { calls.push(['choose', platform]); return { ok: true, fileName: 'new.img' }; },
  });
  await flush();
  assert.equal(ui.view().restoringFile, true);
  assert.equal(ui.view().busy, '');
  assert.deepEqual(calls, [['restore', 'rk']]);
  await ui.view().act('file');
  assert.equal(ui.view().file.fileName, 'new.img');
  sendOld({ ok: true, fileName: 'old.img' });
  await flush();
  assert.equal(ui.view().restoringFile, false);
  assert.equal(ui.view().file.fileName, 'new.img');
  assert.deepEqual(calls, [['restore', 'rk'], ['choose', 'rk']]);
});

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
  let finish;
  const installing = new Promise(resolve => { finish = resolve; });
  const ui = mount({
    firmwareStatus: async platform => { calls.push(['probe', platform]); return vendorStatus('installed'); },
    firmwareInstallDriver: async platform => {
      calls.push(['install', platform]);
      return installing;
    },
  }, { platformHint: 'mtk', requestId: 'reinstall-a' });
  await flush();
  assert.equal(firmwareDriverAction(ui.view().status), 'reinstall');
  ui.view().setConfirm(true);
  assert.equal(ui.view().confirm, true);
  const operation = ui.view().act('install');
  assert.equal(ui.view().confirm, false);
  assert.equal(ui.view().busy, 'install');
  ui.view().setConfirm(true);
  assert.equal(ui.view().confirm, false);
  await ui.view().act('install');
  ui.view().changePlatform('rk');
  assert.equal(ui.view().platform, 'mtk');
  finish({ ok: true, status: vendorStatus('bound') });
  await operation;
  assert.equal(ui.view().confirm, false);
  assert.equal(ui.view().busy, '');
  assert.equal(ui.view().status.state, 'bound');
  assert.deepEqual(calls, [['probe', 'mtk'], ['install', 'mtk']]);
  ui.unmount();
});

test('cancelled or failed MTK reinstallation clears the pending state and leaves no stale confirmation', async () => {
  const outcomes = [{ cancelled: true }, { ok: false, code: 'install-failed' }, Error('installer quit unexpectedly')];
  for (const outcome of outcomes) {
    const ui = mount({
      firmwareStatus: async () => vendorStatus('installed'),
      firmwareInstallDriver: async () => {
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    }, { platformHint: 'mtk', requestId: 'reinstall-outcome' });
    await flush();
    ui.view().setConfirm(true);
    const operation = ui.view().act('install');
    assert.equal(ui.view().confirm, false);
    assert.equal(ui.view().busy, 'install');
    await operation;
    assert.equal(ui.view().confirm, false);
    assert.equal(ui.view().busy, '');
    ui.view().setConfirm(true);
    assert.equal(ui.view().confirm, true, 'The next explicit attempt may open a fresh confirmation');
    ui.unmount();
  }
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
