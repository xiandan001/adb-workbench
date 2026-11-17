import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { startLogWindow } from '../src/shared/logWindowBootstrap.js';

test('blocked language IPC never prevents the first root and a late locale reply never remounts it', async () => {
  let reply; const pending = new Promise(resolve => { reply = resolve; }); let renders = 0;
  const completion = startLogWindow({ render: () => { renders++; }, initializeLanguage: () => pending });
  assert.equal(renders, 1); await Promise.resolve(); assert.equal(renders, 1);
  reply('en-US'); await completion; assert.equal(renders, 1);
});
test('language initialization rejection does not remove the visible root or expose its error text', async () => {
  let renders = 0; const notices = [];
  await startLogWindow({ render: () => { renders++; }, initializeLanguage: () => Promise.reject(new Error('private profile data')), onFailure: code => notices.push(code) });
  assert.equal(renders, 1); assert.deepEqual(notices, ['language-unavailable']);
});
test('actual startup boundary exposes a custom manual retry without raw exception content', () => {
  const require = createRequire(import.meta.url), { parse } = require('@babel/parser'), traverse = require('@babel/traverse').default;
  const original = fs.readFileSync(new URL('../src/components/LogWindowStartupBoundary.jsx', import.meta.url), 'utf8');
  const ast = parse(original, { sourceType: 'module', plugins: ['jsx'] }); let readyNode, retryNode, derived, caught, render;
  traverse(ast, { FunctionDeclaration({ node }) { if (node.id.name === 'LogWindowReady') readyNode = node; },
    ClassMethod({ node }) { if (node.key.name === 'getDerivedStateFromError') derived = node; if (node.key.name === 'componentDidCatch') caught = node; if (node.key.name === 'render') render = node; },
    JSXAttribute({ node }) { if (node.name.name === 'onClick') retryNode = node.value.expression; } });
  let ready = 0, failed = 0, reloads = 0; const diagnostics = [];
  const globals = { useEffect: callback => callback(), console: { error: value => diagnostics.push(value) },
    window: { electronAPI: { startupPresentationReady: () => { ready++; }, startupPresentationFailed: () => { failed++; } }, location: { reload: () => { reloads++; } } } };
  assert.ok(readyNode); assert.equal(ready, 0);
  const state = vm.runInNewContext('(function()' + original.slice(derived.body.start, derived.body.end) + ')', globals)(new Error('private log contents'));
  assert.equal(state.failed, true);
  vm.runInNewContext('(function()' + original.slice(caught.body.start, caught.body.end) + ')', globals)(new Error('private log contents'));
  assert.equal(failed, 1); assert.equal(reloads, 0);
  vm.runInNewContext('(' + original.slice(retryNode.start, retryNode.end) + ')', globals)(); assert.equal(reloads, 1);
  assert.match(original.slice(render.start, render.end), /if \(!this.state.failed\) return this.props.children/);
  assert.match(original.slice(render.start, render.end), /return <LogWindowFailure \/>/);
  assert.match(original, /role="alert"/); assert.deepEqual(diagnostics, ['[LogWindow] renderer-error']);
});
test('actual log ready effect waits for painted frames and cancels abandoned StrictMode attempts', () => {
  const require = createRequire(import.meta.url), { parse } = require('@babel/parser');
  const source = fs.readFileSync(new URL('../src/components/LogWindowStartupBoundary.jsx', import.meta.url), 'utf8');
  const exported = parse(source, { sourceType: 'module', plugins: ['jsx'] }).program.body.find(node => node.type === 'ExportNamedDeclaration' && node.declaration?.id.name === 'LogWindowReady');
  let effect, ready = 0, sequence = 0; const frames = new Map();
  vm.runInNewContext('(' + source.slice(exported.declaration.start, exported.declaration.end) + ')', { useEffect: callback => { effect = callback; },
    requestAnimationFrame: callback => { frames.set(++sequence, callback); return sequence; }, cancelAnimationFrame: id => frames.delete(id),
    window: { electronAPI: { startupPresentationReady: () => { ready++; } } } })();
  const abandoned = effect(); assert.equal(ready, 0); abandoned(); assert.equal(frames.size, 0);
  const committed = effect(); let id = sequence, callback = frames.get(id); frames.delete(id); callback(); assert.equal(ready, 0);
  id = sequence; callback = frames.get(id); frames.delete(id); callback(); assert.equal(ready, 1); committed(); assert.equal(frames.size, 0);
});
