const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;

test('actual preview-host refresh ignores stale initial/event/decision lists and replies from a previous mount', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/components/AiOutboundPreviewHost.jsx'), 'utf8');
  let callback;
  traverse(parse(source, { sourceType: 'module', plugins: ['jsx'] }), { VariableDeclarator({ node }) {
    if (node.id.name === 'refresh') callback = source.slice(node.init.arguments[0].start, node.init.arguments[0].end);
  } });
  assert.ok(callback);
  const pending = [], updates = [], alive = { current: true }, listEpoch = { current: 0 };
  const refresh = vm.runInNewContext(`(${callback})`, { alive, listEpoch, setState: value => updates.push(value),
    window: { electronAPI: { aiOutboundList: () => new Promise(resolve => pending.push(resolve)) } } });
  const initial = refresh(), event = refresh();
  pending[1]({ ok: true, pending: [{ id: 'new-preview' }] }); await event;
  pending[0]({ ok: true, pending: [{ id: 'stale-preview' }] }); await initial;
  assert.equal(updates.length, 1); assert.equal(updates[0].pending[0].id, 'new-preview');
  const decision = refresh(), newerEvent = refresh();
  pending[3]({ ok: true, pending: [] }); await newerEvent;
  pending[2]({ ok: true, pending: [{ id: 'cancelled-preview' }] }); await decision;
  assert.equal(updates.length, 2); assert.equal(updates[1].pending.length, 0);
  const oldMount = refresh(); alive.current = false; listEpoch.current++; alive.current = true;
  const newMount = refresh(); pending[5]({ ok: true, pending: [{ id: 'current-mount' }] }); await newMount;
  pending[4]({ ok: true, pending: [{ id: 'previous-mount' }] }); await oldMount;
  assert.equal(updates.length, 3); assert.equal(updates[2].pending[0].id, 'current-mount');
  assert.equal((source.match(/aiOutboundList/g) || []).length, 1, 'All refresh origins use the same sequence gate');
});

test('workspace evidence action explains the final confirmation rather than claiming immediate consent', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/components/AiWorkspaceEvidence.jsx'), 'utf8');
  assert.ok(source.includes("tr('继续后将显示最终发送预览；确认前不会联网。')"));
  assert.ok(source.includes("tr('查看并确认发送')"));
  assert.ok(!source.includes('点击分析即同意发送'));
  for (const locale of ['en', 'tw', 'ja', 'ko']) {
    const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, `../electron/locales/${locale}-tools.json`), 'utf8'));
    assert.ok(catalog['继续后将显示最终发送预览；确认前不会联网。']); assert.ok(catalog['查看并确认发送']);
  }
});
