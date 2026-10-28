const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const source = fs.readFileSync(path.join(__dirname, '../src/components/TaskCenter.jsx'), 'utf8');
let effect;
traverse(parser.parse(source, { sourceType: 'module', plugins: ['jsx'] }), { CallExpression({ node }) {
  if (node.callee.name === 'useEffect' && node.arguments[0] && source.slice(node.arguments[0].start, node.arguments[0].end).includes('incomingTaskRef.current === requestKey')) effect = source.slice(node.arguments[0].start, node.arguments[0].end);
} });
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const opened = [], refreshed = [], notices = []; let reads = 0;
  const context = { incomingTaskId: '', incomingTaskRequestId: 0, loading: false, incomingTaskRef: { current: '' }, recorderMountedRef: { current: true }, activeTasks: [], history: [], tr: value => value,
    setSelectedTaskId: id => opened.push(id), setActiveTasks: items => refreshed.push(['active', items]), setHistory: items => refreshed.push(['history', items]), showToast: message => notices.push(message),
    window: { electronAPI: { taskState: async () => { reads++; return { ok: true, activeTasks: [{ id: 'unknown-running' }], history: [] }; }, taskRun: () => { throw new Error('Navigation must not execute'); } } } };
  return { context, opened, refreshed, notices, reads: () => reads, run() { assert.ok(effect); vm.runInNewContext(`(${effect})()`, context); } };
}

test('known incoming run opens the result drawer without fetching, changing editor input or running a task', async () => {
  const h = harness(); h.context.activeTasks = [{ id: 'known' }]; h.context.incomingTaskId = 'known';
  h.run(); await flush(); assert.deepEqual(h.opened, ['known']); assert.equal(h.reads(), 0); assert.deepEqual(h.refreshed, []);
  h.run(); await flush(); assert.deepEqual(h.opened, ['known']);
  h.context.incomingTaskRequestId++; h.run(); await flush(); assert.deepEqual(h.opened, ['known', 'known']); assert.equal(h.reads(), 0);
  assert.doesNotMatch(effect, /setDraft|setSelectedDeviceIds|setActiveDevice|taskRun/);
});

test('unknown incoming run refreshes state once and missing records never select an unrelated task', async () => {
  const h = harness(); h.context.incomingTaskId = 'unknown-running'; h.run(); await flush();
  assert.equal(h.reads(), 1); assert.deepEqual(h.opened, ['unknown-running']); h.run(); await flush(); assert.equal(h.reads(), 1);
  h.context.incomingTaskId = 'missing'; h.run(); await flush(); assert.equal(h.reads(), 2); assert.deepEqual(h.opened, ['unknown-running']); assert.equal(h.notices.length, 1);
});

test('an older async response or unmounted workspace cannot reopen a stale result drawer', async () => {
  const h = harness(), pending = [];
  h.context.window.electronAPI.taskState = () => new Promise(resolve => pending.push(resolve));
  h.context.incomingTaskId = 'old'; h.run(); h.context.incomingTaskId = 'new'; h.run();
  pending[0]({ ok: true, activeTasks: [{ id: 'old' }], history: [] }); await flush(); assert.deepEqual(h.opened, []);
  pending[1]({ ok: true, activeTasks: [{ id: 'new' }], history: [] }); await flush(); assert.deepEqual(h.opened, ['new']);
  h.context.incomingTaskId = 'closed'; h.run(); h.context.recorderMountedRef.current = false;
  pending[2]({ ok: true, activeTasks: [{ id: 'closed' }], history: [] }); await flush(); assert.deepEqual(h.opened, ['new']);
});
