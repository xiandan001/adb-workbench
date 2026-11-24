import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'rolldown/utils';

const source = ['FirmwareDirectState.js', 'FirmwareDirectPanel.jsx']
  .map(name => readFileSync(new URL(`../src/components/${name}`, import.meta.url), 'utf8'))
  .join('\n').replace(/^import .+;\n/gm, '').replace(/export (?:default )?(?=function |const )/g, '');
const code = transformSync('FirmwareDirectPanel.jsx', source, { jsx: { runtime: 'classic', pragma: 'jsx' } }).code;
const flush = () => new Promise(resolve => setImmediate(resolve));
const theme = { input: '', textMuted: '', button: { primary: '', secondary: '' } };
const modeOptions = ['download-only', 'firmware-upgrade', 'format-all-download'];
const readyFile = { ok: true, firmwareId: 'private-receipt' };
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : !node || typeof node !== 'object' ? '' : [node.props?.children].flat(Infinity).map(text).join(' ');
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && text(node).trim() === label);

function mount(api, options = {}) {
  let platform = options.platform || 'mtk';
  let active = options.active ?? true;
  const slots = [], effects = [], timers = new Set();
  let cursor = 0;
  function changed(old = [], next = []) {
    return old.length !== next.length || next.some((value, index) => !Object.is(value, old[index]));
  }
  const runtime = {
    useId: () => 'direct-title', useLocale() {}, isDarkTheme: () => false,
    Loader2: 'loading', Download: 'download', SelectMenu: 'selection', React: { Fragment: 'fragment' }, tr: label => label,
    jsx: (type, props, ...children) => ({ type, props: { ...props, children } }),
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
      const slot = slots[cursor++] ??= { value: initial };
      return [slot.value, next => { slot.value = typeof next === 'function' ? next(slot.value) : next; }];
    },
    setTimeout(callback) { timers.add(callback); return callback; },
    clearTimeout: callback => timers.delete(callback),
  };
  const model = runInNewContext(`(function(){${code};return { useFirmwareDirect, FirmwareDirectPanel };})()`, runtime);
  const render = (file = readyFile) => {
    cursor = 0;
    const direct = model.useFirmwareDirect({ platform, active, api });
    const tree = model.FirmwareDirectPanel({ platform, direct, file, theme, targetHint: 'usb1' });
    for (const effect of effects.splice(0)) effect();
    return { tree, direct };
  };
  render();
  return {
    render,
    active: value => { active = value; },
    platform: value => { platform = value; },
    tick() { for (const timer of Array.from(timers)) { timers.delete(timer); timer(); } },
  };
}

const copy = value => JSON.parse(JSON.stringify(value));

test('unverified profiles offer only the vendor fallback and no start action', async () => {
  const calls = [];
  const app = mount({
    firmwareDirectState: async () => ({ ok: true, enabled: false, modes: [], job: null }),
    firmwareDirectArm: async () => { calls.push('arm'); },
  });
  await flush();
  const { tree } = app.render();
  assert.match(text(tree), /尚未开放直刷，请使用厂商工具/);
  assert.equal(button(tree, '开始刷机'), undefined);
  assert.deepEqual(calls, []);
  const workspace = readFileSync(new URL('../src/components/FirmwareWorkspace.jsx', import.meta.url), 'utf8');
  assert.match(workspace, /打开厂商工具/);
});

test('only a click arms the selected firmware, explicit mode and optional USB hint', async () => {
  const calls = [];
  const app = mount({
    firmwareDirectState: async () => ({ ok: true, enabled: true, modes: modeOptions, job: null }),
    firmwareDirectArm: async (platform, input) => {
      calls.push([platform, copy(input)]);
      return { ok: true, job: { id: 'job', phase: 'waiting' } };
    },
  });
  await flush();
  assert.equal(button(app.render({ ok: true }).tree, '开始刷机').props.disabled, true);
  const select = nodes(app.render().tree).find(node => node.type === 'selection');
  select.props.onChange('firmware-upgrade');
  const arm = button(app.render().tree, '开始刷机');
  assert.equal(arm.props.disabled, false);
  assert.deepEqual(calls, []);
  arm.props.onClick();
  await flush();
  assert.deepEqual(calls, [['mtk', { firmwareId: 'private-receipt', mode: 'firmware-upgrade', targetHint: 'usb1' }]]);
  assert.match(text(app.render().tree), /请手动让目标设备进入刷机模式/);
});

test('one waiting job can be polled and chosen without another arm or automatic selection', async () => {
  const calls = [];
  let state = { id: 'job', phase: 'waiting' };
  const app = mount({
    firmwareDirectState: async platform => {
      calls.push(['state', platform]);
      return { ok: true, enabled: true, modes: modeOptions, job: state };
    },
    firmwareDirectChoose: async (platform, input) => {
      calls.push(['choose', platform, copy(input)]);
      state = { ...state, phase: 'checking' };
      return { ok: true, job: state };
    },
  });
  await flush();
  assert.ok(button(app.render().tree, '取消'));
  assert.equal(button(app.render().tree, '开始刷机'), undefined);
  state = { id: 'job', phase: 'choice-required', candidates: [{ id: 'a', label: 'USB A' }, { id: 'b', label: 'USB B' }] };
  app.tick();
  await flush();
  const choiceView = app.render().tree;
  assert.equal(button(choiceView, 'USB A').type, 'button');
  assert.deepEqual(calls.map(entry => entry[0]), ['state', 'state']);
  button(choiceView, 'USB B').props.onClick();
  await flush();
  assert.ok(calls.some(entry => entry[0] === 'choose' && entry[2].targetId === 'b'));
  assert.equal(button(app.render().tree, '取消'), undefined);
});

test('cancelling while waiting addresses only the visible job', async () => {
  const calls = [];
  const app = mount({
    firmwareDirectState: async () => ({ ok: true, enabled: true, modes: modeOptions, job: { id: 'job', phase: 'waiting' } }),
    firmwareDirectCancel: async (platform, id) => {
      calls.push([platform, id]);
      return { ok: true, job: { id, phase: 'cancelled' } };
    },
  });
  await flush();
  button(app.render().tree, '取消').props.onClick();
  await flush();
  assert.deepEqual(calls, [['mtk', 'job']]);
  assert.match(text(app.render().tree), /等待已取消/);
});

test('writing has progress, no cancel action, and no reads while the workspace is hidden', async () => {
  let reads = 0;
  const app = mount({
    firmwareDirectState: async () => {
      reads++;
      return { ok: true, enabled: true, modes: modeOptions, job: { id: 'job', phase: 'writing', percent: 35 } };
    },
  });
  await flush();
  const { tree } = app.render();
  assert.equal(nodes(tree).find(node => node.type === 'progress').props.value, 35);
  assert.equal(button(tree, '取消'), undefined);
  app.active(false);
  app.render();
  app.tick();
  assert.equal(reads, 1);
  app.active(true);
  app.render();
  await flush();
  assert.equal(reads, 2);
});
