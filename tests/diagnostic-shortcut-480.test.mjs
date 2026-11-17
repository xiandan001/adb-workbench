import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import { searchDestinations } from '../src/shared/workbenchSearch.js';
const source = fs.readFileSync(new URL('../src/components/DiagnosticCaptureButton.jsx', import.meta.url), 'utf8');
let activate;
traverseModule.default(parse(source, { sourceType: 'module', plugins: ['jsx'] }), { FunctionDeclaration({ node }) { if (node.id.name === 'activate') activate = source.slice(node.start, node.end); } });
const fixture = capture => {
  const calls = []; const run = vm.runInNewContext('(' + activate + ')', { view: { loading: false, busy: '', capture }, recording: capture?.recording === true,
    model: { start: async () => calls.push('start') }, onOpenChange: value => calls.push(['open', value]) });
  return { calls, run };
};
test('first explicit shortcut starts application capture, while existing captures open controls without replacing or stopping', async () => {
  const fresh = fixture({ recording: false, available: false }); await fresh.run(); assert.deepEqual(fresh.calls, ['start']);
  for (const capture of [{ recording: false, available: true }, { recording: true, available: true }, null]) {
    const f = fixture(capture); await f.run(); assert.deepEqual(f.calls, [['open', true]]);
  }
});
test('global search is a controls-only destination and the direct stop/export button reuses the shared operation', () => {
  const destination = searchDestinations().find(item => item.id === 'diagnostics:application-log');
  assert.equal(destination.destination.kind, 'diagnostics'); assert.equal(destination.action, undefined);
  assert.match(source, /recording && <button[^\n]+model\.stopAndExport\(\)/);
  assert.doesNotMatch(source, /adbStartLog|aiAnalyze|feedbackSubmit|serialSend/);
});
