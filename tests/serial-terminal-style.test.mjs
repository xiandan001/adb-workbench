import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { SERIAL_TERMINAL_STYLE_KEY, normalizeSerialTerminalStyle, readSerialTerminalStyle, saveSerialTerminalStyle } from '../src/shared/serialTerminalStyle.js';
import * as workspace from '../src/shared/serialWorkspace.js';
import { defaultSerialPreferences } from '../src/shared/serialSettings.js';

const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser'); const traverse = require('@babel/traverse').default;
function storage(initial = {}) {
  const values = new Map(Object.entries(initial)); const writes = [];
  return { values, writes, getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { writes.push([key, value]); values.set(key, value); } };
}
function panelFunction(name, context) {
  const source = readFileSync(new URL('../src/components/SerialPanel.jsx', import.meta.url), 'utf8'); let target;
  traverse(parse(source, { sourceType: 'module', plugins: ['jsx'] }), {
    FunctionDeclaration({ node }) { if (node.id?.name === name) target = node; },
    VariableDeclarator({ node }) { if (node.id.name === name) target = node.init; },
  });
  const tr = (message, params = {}) => message.replace(/\{(\d+)\}/g, (token, index) => Object.hasOwn(params, index) ? String(params[index] ?? '') : token);
  context.tr = tr;
  assert.ok(target, `missing ${name}`); return runInNewContext(`(${source.slice(target.start, target.end)})`, context);
}
function initialSettings(saved, workspaceModule = workspace) {
  return panelFunction('initialSettings', { defaultSerialPreferences, readSerialPreferences: defaultSerialPreferences,
    readSerialHistory: () => [], readSerialWorkspace: workspaceModule.readSerialWorkspace,
    readSerialTerminalStyle: () => readSerialTerminalStyle(saved) })();
}

test('style is a strict visual-only enum; absent storage defaults current without writing', () => {
  const saved = storage(); assert.equal(readSerialTerminalStyle(saved), 'current'); assert.deepEqual(saved.writes, []);
  assert.equal(SERIAL_TERMINAL_STYLE_KEY, 'adb-workbench.serial-terminal-style.v1');
  for (const style of ['current', 'classic']) { assert.equal(normalizeSerialTerminalStyle(style), style); saveSerialTerminalStyle(style, saved); assert.equal(readSerialTerminalStyle(saved), style); }
  const before = saved.getItem(SERIAL_TERMINAL_STYLE_KEY);
  for (const value of ['', 'CLASSIC', ' classic', null, true, 1, [], {}, { style: 'classic' }, 'classic\0']) {
    assert.throws(() => normalizeSerialTerminalStyle(value)); assert.throws(() => saveSerialTerminalStyle(value, saved));
    assert.equal(saved.getItem(SERIAL_TERMINAL_STYLE_KEY), before);
  }
  assert.ok(saved.writes.every(([key]) => key === SERIAL_TERMINAL_STYLE_KEY));
});

test('malformed saved styles remain untouched; only an explicit valid save repairs the visual value', () => {
  for (const raw of ['not json', 'null', '"future"', '{"style":"classic","enter":"lf"}', ' '.repeat(200)]) {
    const saved = storage({ [SERIAL_TERMINAL_STYLE_KEY]: raw });
    assert.throws(() => readSerialTerminalStyle(saved), /样式/); assert.equal(saved.getItem(SERIAL_TERMINAL_STYLE_KEY), raw); assert.equal(saved.writes.length, 0);
    const loaded = initialSettings(saved); assert.equal(loaded.workspace.terminal.style, 'current'); assert.match(loaded.terminalStyleError, /样式/);
    saveSerialTerminalStyle('classic', saved); assert.equal(readSerialTerminalStyle(saved), 'classic');
  }
});

test('page navigation and a fresh module restore style but never persist terminal input semantics, ports or drafts', async () => {
  const saved = storage(); saveSerialTerminalStyle('classic', saved); const original = workspace.readSerialWorkspace();
  try {
    workspace.updateSerialWorkspace({ mode: 'terminal', selectedPath: 'COM97', terminalSelectedPath: 'COM98', draft: 'memory only',
      terminal: { ...original.terminal, enter: 'lf', backspace: 'bs', localEcho: true, style: 'current' } });
    const navigation = initialSettings(saved);
    assert.equal(navigation.workspace.terminal.style, 'classic'); assert.equal(navigation.workspace.terminal.enter, 'lf');
    const fresh = await import(`../src/shared/serialWorkspace.js?style-restart=${Date.now()}`);
    const restarted = initialSettings(saved, fresh).workspace;
    assert.equal(restarted.terminal.style, 'classic'); assert.equal(restarted.terminal.enter, 'cr');
    assert.equal(restarted.terminal.backspace, 'del'); assert.equal(restarted.terminal.localEcho, false);
    assert.equal(restarted.selectedPath, ''); assert.equal(restarted.terminalSelectedPath, ''); assert.equal(restarted.draft, '');
    assert.equal(restarted.mode, 'rs232'); assert.equal(saved.values.size, 1);
    assert.equal(saved.getItem(SERIAL_TERMINAL_STYLE_KEY), '"classic"');
  } finally { workspace.updateSerialWorkspace(original); }
});

test('the actual panel handler saves appearance only, leaves failed choices unchanged and never invokes serial IPC', () => {
  const saved = storage({ [SERIAL_TERMINAL_STYLE_KEY]: '"classic"' });
  let state = { ...workspace.readSerialWorkspace(), terminal: { ...workspace.readSerialWorkspace().terminal, style: 'classic' } };
  let error = ''; let nativeCalls = 0;
  const context = { workspace: state, saveSerialTerminalStyle: style => saveSerialTerminalStyle(style, saved),
    setTerminalStyleError: message => { error = message; }, updateWorkspace: patch => { state = { ...state, ...patch }; context.workspace = state; },
    window: { electronAPI: new Proxy({}, { get() { nativeCalls++; throw Error('must not call serial IPC'); } }) } };
  const change = panelFunction('changeTerminalSettings', context);
  const write = saved.setItem; saved.setItem = () => { throw Error('fixture storage quota'); };
  assert.equal(change({ style: 'current' }), false); assert.equal(state.terminal.style, 'classic');
  assert.equal(saved.getItem(SERIAL_TERMINAL_STYLE_KEY), '"classic"'); assert.match(error, /保存/);
  saved.setItem = write; assert.equal(change({ style: 'current' }), true); assert.equal(state.terminal.style, 'current'); assert.equal(error, '');
  const count = saved.writes.length;
  change({ enter: 'lf', backspace: 'bs', localEcho: true, expanded: true });
  assert.equal(saved.writes.length, count); assert.equal(state.terminal.localEcho, true); assert.equal(nativeCalls, 0);
  assert.equal(change({ style: 'unsupported' }), false); assert.equal(state.terminal.style, 'current');
});

test('unavailable storage is visible at initial read and no default value is silently written', () => {
  const saved = { getItem() { throw Error('fixture access denied'); }, setItem() { throw Error('unexpected write'); } };
  const settings = initialSettings(saved);
  assert.equal(settings.workspace.terminal.style, 'current'); assert.match(settings.terminalStyleError, /样式/);
});
