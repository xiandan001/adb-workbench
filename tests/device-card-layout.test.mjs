import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { transformWithOxc } from 'vite';
import { tr, setLanguage } from '../src/shared/i18n.js';
import { displayDeviceId, platformLabel, isHarmonyDevice } from '../src/shared/devicePlatform.js';
import { deviceStatusLabel } from '../src/shared/deviceWorkflow.js';
import { deviceTerminalCommands, deviceTerminalPresentation, createDeviceTerminalRequest } from '../src/shared/deviceTerminal.js';
import { recordingButtonState } from '../src/shared/recordingWorkspace.js';
const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser'), traverse = require('@babel/traverse').default;
const read = file => fs.readFileSync(new URL('../src/components/' + file, import.meta.url), 'utf8');
const element = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
const walk = (node, predicate) => !node || typeof node !== 'object' ? [] : [...(predicate(node) ? [node] : []), ...node.children.flatMap(child => walk(child, predicate))];
const text = node => node === false || node == null ? '' : typeof node === 'object' ? node.children.map(text).join('') : String(node);
const cssClass = (node, name) => String(node.props.className || '').split(/\s+/).includes(name);
const theme = { primary: 'emerald', header: 'bg-white border-slate-200', text: 'text-slate-700', textMuted: 'text-slate-500', input: 'border-slate-200', button: { primary: 'primary-fixture', secondary: 'secondary-fixture' } };
let header;
async function component() {
  if (header) return header;
  const source = read('DeviceCardHeader.jsx').replace(/^import .*;\r?\n/gm, '').replace('export default function DeviceCardHeader', 'function DeviceCardHeader');
  const result = await transformWithOxc(source + '\nglobalThis.component = DeviceCardHeader;', 'DeviceCardHeader.jsx', { jsx: { runtime: 'classic' } });
  const sandbox = { React: { createElement: element }, tr, useLocale() {}, displayDeviceId, platformLabel, deviceStatusLabel };
  for (const name of ['Smartphone', 'Unplug', 'Play', 'Pencil', 'Star', 'Loader2']) sandbox[name] = () => null;
  runInNewContext(result.code, sandbox); header = sandbox.component; return header;
}
async function render(extra = {}) {
  const callbacks = Object.fromEntries(['onSelectDevice', 'onTogglePin', 'onDisconnect', 'onStart', 'onBeginRename', 'onNameSubmit', 'onEditNameChange', 'onEditNameKeyDown'].map(name => [name, () => {}]));
  const props = { device: { id: 'hdc:' + 'a'.repeat(128), status: 'device', model: 'Fixture' }, deviceName: 'LongAlias'.repeat(20),
    theme, isOnline: true, isActive: true, isPinned: true, scrcpyLoading: false, isEditing: false, editName: '', ...callbacks, ...extra };
  return { tree: (await component())(props), props };
}
test('real header render separates identity, chips and actions while preserving complete long identifiers and aliases', async () => {
  for (const length of [32, 64, 128]) {
    const id = 'hdc:' + 'f'.repeat(length), alias = 'Very long alias ' + 'Unbroken'.repeat(30);
    const { tree } = await render({ device: { id, status: 'device' }, deviceName: alias });
    const ids = walk(tree, node => cssClass(node, 'device-card-id')), names = walk(tree, node => cssClass(node, 'device-card-name'));
    assert.equal(ids.length, 1); assert.equal(text(ids[0]), id.slice(4)); assert.equal(ids[0].props.title, id.slice(4));
    assert.equal(text(names[0]), alias); assert.equal(names[0].props.title, alias);
    for (const name of ['device-card-identity', 'device-card-chips', 'device-card-header-actions']) assert.equal(walk(tree, node => cssClass(node, name)).length, 1);
    const actions = walk(tree, node => cssClass(node, 'device-card-header-actions'))[0];
    assert.equal(walk(actions, node => cssClass(node, 'device-card-id')).length, 0);
    assert.equal(walk(tree, node => cssClass(node, 'device-card-chips'))[0].children.some(child => typeof child === 'object' && cssClass(child, 'device-card-id')), false);
  }
});
test('header keeps original action callbacks and only offline/loading disable the primary action', async () => {
  for (const changes of [{}, { isOnline: false }, { scrcpyLoading: true }]) {
    const calls = []; const onStart = value => calls.push(value), event = { fixture: true };
    const { tree, props } = await render({ ...changes, onStart });
    const primary = walk(tree, node => cssClass(node, 'device-card-primary'))[0];
    assert.equal(primary.props.onClick, onStart); primary.props.onClick(event); assert.equal(calls[0], event);
    assert.equal(primary.props.disabled, !props.isOnline || props.scrcpyLoading);
    const select = walk(tree, node => cssClass(node, 'device-card-selection'))[0]; assert.equal(select.props.onClick, props.onSelectDevice); assert.equal(select.props['aria-pressed'], true);
    const pin = walk(tree, node => node.props['data-device-pin'])[0]; assert.equal(pin.props.onClick, props.onTogglePin);
  }
});
test('rename remains parent-owned and submits the complete device identity unchanged', async () => {
  const calls = [], id = 'hdc:' + 'b'.repeat(128), card = read('DeviceCard.jsx');
  let submit;
  traverse(parse(card, { sourceType: 'module', plugins: ['jsx'] }), { VariableDeclarator({ node }) { if (node.id.name === 'handleNameSubmit') submit = node.init; } });
  runInNewContext('(' + card.slice(submit.start, submit.end) + ')', { device: { id }, editName: '  Alias  ', onNameChange: (...args) => calls.push(args), setIsEditing: value => calls.push(value) })();
  assert.deepEqual(calls[0], [id, 'Alias']); assert.equal(calls[1], false);
  const { tree, props } = await render({ isEditing: true, editName: 'Entire typed alias' });
  const input = walk(tree, node => node.type === 'input')[0];
  assert.equal(input.props.value, props.editName); assert.equal(input.props.onBlur, props.onNameSubmit); assert.equal(input.props.onKeyDown, props.onEditNameKeyDown);
});
test('five languages render full status/selection/primary labels without rebuilding identity or changing actions', async () => {
  try {
    for (const locale of ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR']) {
      await setLanguage(locale); const { tree } = await render();
      assert.equal(text(walk(tree, node => cssClass(node, 'device-card-primary'))[0]), tr('开始投屏'));
      assert.equal(text(walk(tree, node => cssClass(node, 'device-card-selection'))[0]), tr('当前设备'));
      assert.ok(text(walk(tree, node => cssClass(node, 'device-card-state'))[0]).includes(tr('在线')));
    }
  } finally { await setLanguage('zh-CN'); }
});
test('card CSS bounds identifiers, preserves nonbreaking badges and offers visible adaptive tool grids', () => {
  const css = read('DeviceCard.css');
  for (const selector of ['device-card-identity', 'device-card-identity-content', 'device-card-name-row', 'device-card-id', 'device-card-header-actions']) assert.ok(css.includes('.' + selector));
  const rule = name => new RegExp('\\.' + name + '(?![\\w-])[^{}]*\\{([^}]+)\\}').exec(css)?.[1] || '';
  assert.match(rule('device-card-id'), /text-overflow:\s*ellipsis/); assert.match(rule('device-card-id'), /user-select:\s*text/);
  assert.match(rule('device-card-name'), /-webkit-line-clamp:\s*2/);
  assert.match(rule('device-card-state'), /white-space:\s*nowrap/);
  assert.match(css, /@container\s*\(max-width:\s*480px\)[\s\S]*device-card-primary[^{]*\{[^}]*flex-basis:\s*100%/);
  assert.match(css, /repeat\(3,\s*minmax\(0,\s*1fr\)\)/); assert.match(css, /repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(rule('device-card-header-actions'), /flex-wrap:\s*wrap/);
  assert.match(css, /@container\s*\(min-width:\s*720px\)[\s\S]*?\.device-card-header-actions\s*\{[^}]*flex-wrap:\s*nowrap/);
  assert.doesNotMatch(read('DeviceNavigationControls.jsx'), /className="block truncate"/);
  assert.match(read('ControlButton.jsx'), /device-control-label/);
  assert.match(rule('device-terminal-name'), /min-width:\s*0/);
  assert.match(rule('device-terminal-name'), /overflow-wrap:\s*anywhere/);
});
test('fullscreen surface portals only the existing terminal element and keeps inline rendering untouched', () => {
  const source = read('DeviceCard.jsx'); let boundary;
  traverse(parse(source, { sourceType: 'module', plugins: ['jsx'] }), { FunctionDeclaration({ node }) { if (node.id?.name === 'DeviceTerminalSurface') boundary = node; } });
  assert.ok(boundary, 'the terminal has a focused portal boundary');
  const body = {}, calls = [], child = { currentInput: 'unchanged', output: ['unchanged'] };
  const surface = runInNewContext('(' + source.slice(boundary.start, boundary.end) + ')', { document: { body }, createPortal: (element, host) => { calls.push([element, host]); return { portal: element }; } });
  assert.equal(surface({ fullscreen: false, children: child }), child); assert.deepEqual(calls, []);
  assert.equal(surface({ fullscreen: true, children: child }).portal, child); assert.equal(calls[0][0], child); assert.equal(calls[0][1], body);
  assert.match(source, /device-terminal-input/); assert.match(source, /device-terminal-actions/);
});
test('the ROOT/SU warning remains above a fullscreen terminal instead of being hidden by its portal layer', () => {
  const css = read('DeviceCard.css'), danger = read('DangerConfirmModal.jsx'), card = read('DeviceCard.jsx');
  const terminal = /\.device-terminal-fullscreen\s*\{([^}]+)\}/.exec(css)?.[1];
  const terminalLayer = Number(/z-index:\s*(\d+)/.exec(terminal)?.[1]);
  const warningLayer = Number(/\bz-\[(\d+)\]/.exec(danger)?.[1]);
  assert.equal(terminalLayer, 50); assert.ok(warningLayer > terminalLayer);
  assert.match(card, /setSuUnsupportedOpen\(true\)/); assert.match(card, /open=\{suUnsupportedOpen\}/);
});
test('closing the async ROOT warning focuses the current connected trigger without replaying the probe', async () => {
  const source = read('DeviceCard.jsx'), ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  const functions = {};
  traverse(ast, { VariableDeclarator({ node }) { if (['toggleSuMode', 'closeSuWarning'].includes(node.id.name)) functions[node.id.name] = source.slice(node.init.start, node.init.end); } });
  assert.ok(functions.closeSuWarning);
  let resolveProbe, probes = 0, open = false, animation, focused = 0;
  const trigger = { disabled: false, isConnected: true, focus() { focused++; } }, terminalRootRef = { current: trigger };
  const sandbox = { suMode: false, isOnline: true, setSuChecking: value => { trigger.disabled = value; },
    checkSuSupported: () => { probes++; return new Promise(resolve => { resolveProbe = resolve; }); },
    setSuUnsupportedOpen: value => { open = value; }, terminalRootRef,
    requestAnimationFrame: callback => { animation = callback; } };
  const toggle = runInNewContext('(' + functions.toggleSuMode + ')', sandbox), close = runInNewContext('(' + functions.closeSuWarning + ')', sandbox);
  const pending = toggle(); assert.equal(trigger.disabled, true); assert.equal(probes, 1);
  await Promise.resolve(); resolveProbe({ supported: false, strategy: 'none' }); await pending;
  assert.equal(open, true); assert.equal(trigger.disabled, false); close(); assert.equal(open, false); assert.equal(focused, 0);
  animation(); assert.equal(focused, 1); assert.equal(probes, 1);
  close(); terminalRootRef.current = null; animation(); assert.equal(focused, 1);
  terminalRootRef.current = { ...trigger, isConnected: false }; close(); animation(); assert.equal(focused, 1);
  assert.match(source, /ref=\{terminalRootRef\}/); assert.match(source, /onCancel=\{closeSuWarning\}/); assert.match(source, /onConfirm=\{closeSuWarning\}/);
});
test('portal transitions preserve a middle scroll position or follow the tail, while new output retains its existing auto-scroll', () => {
  const source = read('DeviceCard.jsx'), ast = parse(source, { sourceType: 'module', plugins: ['jsx'] }); let change, effect;
  traverse(ast, {
    VariableDeclarator({ node }) { if (node.id.name === 'changeTerminalFullscreen') change = node.init; },
    CallExpression({ node }) { if (node.callee.name === 'useLayoutEffect' && source.slice(node.start, node.end).includes('terminalOutputRef')) effect = node.arguments[0]; }
  });
  assert.ok(change); assert.ok(effect);
  for (const top of [123, 1144]) {
    const output = { current: { scrollTop: top, scrollHeight: 1400, clientHeight: 256 } }, saved = { current: null }, modes = [];
    const context = { terminalOutputRef: output, terminalScrollRestoreRef: saved, setTerminalFullscreen: value => modes.push(value) };
    const switchLayout = runInNewContext('(' + source.slice(change.start, change.end) + ')', context);
    const restore = runInNewContext('(' + source.slice(effect.start, effect.end) + ')', context);
    switchLayout(true); output.current = { scrollTop: 0, scrollHeight: 1000, clientHeight: 503 }; restore();
    assert.equal(output.current.scrollTop, top === 123 ? 123 : 497); assert.equal(saved.current, null);
    switchLayout(false); output.current = { scrollTop: 0, scrollHeight: 1400, clientHeight: 256 }; restore();
    assert.equal(output.current.scrollTop, top); assert.deepEqual(modes, [true, false]);
    output.current.scrollTop = 90; restore(); assert.equal(output.current.scrollTop, output.current.scrollHeight, 'ordinary new-output effect still follows existing behavior');
    switchLayout(true); output.current = null; restore(); assert.equal(saved.current, null, 'unmounted output consumes the stale snapshot safely');
  }
});
test('real terminal layout transitions preserve draft, output, font size and a running request without replaying it', async () => {
  const original = read('DeviceCard.jsx');
  const source = original.replace(/^import .*;\r?\n/gm, '').replace('export default DeviceCard;', 'globalThis.card = DeviceCard;');
  const compiled = await transformWithOxc(source, 'DeviceCard.jsx', { jsx: { runtime: 'classic' } });
  const cells = [], calls = [], body = {}; let cursor = 0, release;
  const sandbox = { tr, useLocale() {}, useEffect() {}, useLayoutEffect() {},
    useState(initial) { const index = cursor++; if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial; return [cells[index], value => { cells[index] = typeof value === 'function' ? value(cells[index]) : value; }]; },
    useRef(initial) { const index = cursor++; if (!(index in cells)) cells[index] = { current: initial }; return cells[index]; },
    localStorage: { getItem: () => null }, document: { body }, themes: { default: theme },
    isDarkTheme: () => false, isHarmonyDevice, deviceTerminalCommands, deviceTerminalPresentation, createDeviceTerminalRequest,
    recordingButtonState, deviceConnectionHint: () => '', trapAppMessageFocus() {},
    useDeviceRecording: () => ({ session: null, sessions: [], loaded: true, pending: false }),
    createPortal: (child, host) => ({ type: 'PORTAL', props: { host }, children: [child] })
  };
  sandbox.React = { createElement(type, props, ...children) {
    if (typeof type === 'function' && type.name === 'DeviceTerminalSurface') return type({ ...props, children: children[0] });
    return element(type, props, ...children);
  } };
  for (const name of ['DeviceCardHeader', 'ControlButton', 'SelectMenu', 'DeviceNavigationControls', 'DeviceRecordingStatus', 'DeviceRecentMedia', 'AiContextButton', 'InspectionPanel', 'PackageManagerPanel', 'DangerConfirmModal']) sandbox[name] = () => null;
  const imports = parse(original, { sourceType: 'module', plugins: ['jsx'] }).program.body.find(node => node.type === 'ImportDeclaration' && node.source.value === 'lucide-react');
  for (const item of imports.specifiers) sandbox[item.local.name] = () => null;
  runInNewContext(compiled.code, sandbox);
  const id = 'hdc:' + 'c'.repeat(128);
  const props = { device: { id, status: 'device', model: 'Fixture' }, theme: { ...theme, terminal: { bg: 'bg-black', output: 'bg-black', text: 'text-slate-300', accent: 'text-green-400' } },
    sharedCommandHistory: ['saved command'], onSaveTerminalCommand() {}, onExecuteCommand: (deviceId, command) => { calls.push([deviceId, command]); return new Promise(resolve => { release = resolve; }); } };
  const draw = () => { cursor = 0; return sandbox.card(props); };
  const find = (tree, predicate) => { const result = walk(tree, predicate)[0]; assert.ok(result); return result; };
  let tree = draw(); find(tree, node => node.props.label === tr('终端')).props.onClick(); tree = draw();
  find(tree, node => node.type === 'input' && node.props.placeholder === tr('输入 HDC Shell 命令...')).props.onChange({ target: { value: 'echo fixture' } }); tree = draw();
  const executing = find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} }); tree = draw();
  find(tree, node => node.props.title === tr('放大')).props.onClick(); tree = draw();
  assert.equal(find(tree, node => node.type === 'PORTAL').props.host, body);
  const heading = find(tree, node => cssClass(node, 'device-terminal-name'));
  assert.ok(text(heading).includes('c'.repeat(128))); assert.equal(heading.props.title, text(heading));
  assert.ok(find(tree, node => node.props.title === tr('中断当前命令')));
  assert.equal(calls.length, 1); assert.deepEqual(calls[0], [id, 'echo fixture']);
  release('completed synthetic output'); await executing; tree = draw();
  find(tree, node => node.type === 'input' && node.props.placeholder === tr('输入 HDC Shell 命令...')).props.onChange({ target: { value: 'unsent draft' } });
  find(tree, node => node.props.title === tr('放大 (Ctrl+=)')).props.onClick(); tree = draw();
  const dialog = find(tree, node => node.props.role === 'dialog'); let prevented = false;
  dialog.props.onKeyDown({ key: 'Escape', defaultPrevented: false, preventDefault() { prevented = true; } }); tree = draw();
  assert.equal(prevented, true); assert.equal(walk(tree, node => node.type === 'PORTAL').length, 0);
  assert.equal(find(tree, node => node.type === 'input' && node.props.placeholder === tr('输入 HDC Shell 命令...')).props.value, 'unsent draft');
  assert.match(text(tree), /completed synthetic output/);
  assert.equal(find(tree, node => cssClass(node, 'device-terminal-output')).props.style.fontSize, '13px');
  assert.equal(calls.length, 1);
});
