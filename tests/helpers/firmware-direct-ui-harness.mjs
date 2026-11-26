import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'rolldown/utils';

const source = ['FirmwareDirectState.js', 'FirmwareDirectPanel.jsx']
  .map(name => readFileSync(new URL(`../../src/components/${name}`, import.meta.url), 'utf8'))
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
const changeTarget = (app, value) => {
  button(app.render().tree, '更换目标').props.onClick();
  const select = nodes(app.render().tree).find(node => node.type === 'selection' && node.props.ariaLabel === '刷机目标');
  assert.ok(select.props.options.some(option => option.value === value));
  select.props.onChange(value);
};

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
    Loader2: 'loading', Download: 'download', TriangleAlert: 'warning', CheckCircle2: 'done', ChevronDown: 'chevron',
    SelectMenu: 'selection', React: { Fragment: 'fragment' },
    tr: (label, values) => values ? label.replace(/\{(\d+)\}/g, (_, key) => values[key]) : label,
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
  const render = (file = readyFile, blocked = false) => {
    cursor = 0;
    const direct = model.useFirmwareDirect({ platform, active, api, firmwareId: file?.firmwareId });
    const tree = model.FirmwareDirectPanel({ platform, direct, file, theme, targetHint: Object.hasOwn(options, 'targetHint') ? options.targetHint : 'usb1',
      blocked, onCopyFirmwarePath: options.onCopyFirmwarePath, onOpenVendor: options.onOpenVendor,
      onCopyFirmwareFingerprint: options.onCopyFirmwareFingerprint, handoffFeedback: options.handoffFeedback, handoffDisabled: options.handoffDisabled,
      onReviewFirmware: options.onReviewFirmware, reviewPending: options.reviewPending, reviewFeedback: options.reviewFeedback });
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

export { button, changeTarget, copy, flush, modeOptions, mount, nodes, readyFile, text };
