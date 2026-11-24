import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../src/components/FirmwareWorkspaceState.js', import.meta.url), 'utf8')
  .replace(/^import .+;\n/gm, '').replaceAll('export function ', 'function ');
const flush = () => new Promise(resolve => setImmediate(resolve));

function mount(electronAPI, entryDevice) {
  let cursor = 0;
  let props = { active: true, entryDevice };
  const slots = [], effects = [], timers = [];
  const values = new Map();
  const runtime = {
    tr: value => value,
    window: { electronAPI, addEventListener() {}, removeEventListener() {} },
    localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout: callback => timers.push(callback), clearTimeout: () => {},
    useCallback: fn => fn,
    useEffect: effect => effects.push(effect),
    useRef: value => (slots[cursor++] ??= { current: value }),
    useState(initial) {
      const slot = slots[cursor++] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slot.value, next => { slot.value = typeof next === 'function' ? next(slot.value) : next; }];
    },
  };
  const model = runInNewContext(`(function(){${source};return { useFirmwareWorkspace, readFirmwarePlatform };})()`, runtime);
  const view = () => { cursor = 0; return model.useFirmwareWorkspace(props); };
  view();
  const cleanups = effects.splice(0).map(effect => effect());
  for (const timer of timers.splice(0)) timer();
  return { view, model, entry: next => { props = { ...props, entryDevice: next }; }, unmount: () => cleanups.forEach(fn => fn?.()) };
}

const vendorStatus = state => ({ ok: true, state, devices: [], installer: { available: true }, tool: { available: true } });

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
