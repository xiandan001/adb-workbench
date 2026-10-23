import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser'); const traverse = require('@babel/traverse').default;

function membershipCalls(source) {
  const callbacks = [];
  traverse(parse(source, { sourceType: 'module', plugins: ['jsx'] }), {
    JSXAttribute(attribute) {
      if (attribute.node.name.name !== 'onOpenMembership') return;
      const calls = [];
      attribute.traverse({ CallExpression(call) { if (call.node.callee.type === 'Identifier') calls.push({ name: call.node.callee.name, firstArgument: call.node.arguments[0]?.value }); } });
      callbacks.push(calls);
    },
  });
  return callbacks;
}
test('AI membership navigation refreshes the shared status instead of displaying a stale App cache', () => {
  const callbacks = membershipCalls(readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8'));
  assert.equal(callbacks.length, 1);
  assert.ok(callbacks[0].some(call => call.name === 'setActiveTab' && call.firstArgument === 'member'));
  assert.ok(callbacks[0].some(call => call.name === 'refreshVipStatus'));
});
test('the contract distinguishes the former navigation-only callback from a refreshing callback', () => {
  const old = membershipCalls("const ui = <AiToolsWorkspace onOpenMembership={() => setActiveTab('member')} />;");
  assert.equal(old[0].some(call => call.name === 'refreshVipStatus'), false);
});
