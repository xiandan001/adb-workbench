import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser'); const traverse = require('@babel/traverse').default;
const source = name => readFileSync(new URL(`../src/components/ai-tools/${name}.jsx`, import.meta.url), 'utf8');
const ast = name => parse(source(name), { sourceType: 'module', plugins: ['jsx'] });
const attribute = (node, name) => node.openingElement.attributes.find(value => value.type === 'JSXAttribute' && value.name.name === name)?.value;
const text = node => node.type === 'JSXText' ? node.value : node.type === 'JSXExpressionContainer' && node.expression?.callee?.name === 'tr' ? node.expression.arguments[0].value : (node.children || []).map(text).join('');

test('detected CLI entry passes the exact tool identity and explicit launch intent into the existing form', () => {
  let entry; let form;
  traverse(ast('AiProjectsPanel'), { JSXElement(element) {
    const node = element.node; const label = attribute(node, 'aria-label')?.expression;
    if (node.openingElement.name.name === 'button' && label?.callee?.name === 'tr' && label.arguments[0]?.value === '创建项目并启动 {0}') entry = node;
    if (node.openingElement.name.name === 'AiProjectForm') form = node;
  } });
  assert.ok(entry); const click = attribute(entry, 'onClick').expression.body;
  assert.equal(click.callee.name, 'openForm'); assert.equal(click.arguments[0].type, 'NullLiteral');
  assert.equal(click.arguments[1].object.name, 'item'); assert.equal(click.arguments[1].property.name, 'id'); assert.equal(click.arguments[2].value, true);
  assert.equal(attribute(form, 'defaultToolId').expression.property.name, 'defaultToolId');
  assert.equal(attribute(form, 'launchAfterSave').expression.property.name, 'launchAfterSave');
});

test('normal add and empty-state add remain save-only; only quick-start save continuation opens launch', () => {
  const addButtons = []; let continued = 0;
  traverse(ast('AiProjectsPanel'), {
    JSXElement(element) {
      if (element.node.openingElement.name.name !== 'button') return;
      if (['添加项目', '添加第一个项目'].includes(text(element.node).trim())) addButtons.push(attribute(element.node, 'onClick').expression.body);
    },
    CallExpression(call) {
      if (call.node.callee.name !== 'setLaunch' || call.getFunctionParent()?.parentPath.node.id?.name !== 'save') return;
      const guard = call.findParent(parent => parent.isIfStatement()); assert.ok(guard);
      assert.match(source('AiProjectsPanel').slice(guard.node.test.start, guard.node.test.end), /context\.launchAfterSave/); continued++;
    },
  });
  assert.equal(addButtons.length, 2); for (const click of addButtons) { assert.equal(click.callee.name, 'openForm'); assert.equal(click.arguments.length, 0); }
  assert.equal(continued, 1);
  let defaultIntent;
  traverse(ast('AiProjectForm'), { FunctionDeclaration(fn) {
    if (fn.node.id.name !== 'AiProjectForm') return;
    defaultIntent = fn.node.params[0].properties.find(property => property.key.name === 'launchAfterSave').value.right.value;
  } });
  assert.equal(defaultIntent, false);
});

test('automatic non-AGY effect only prepares preview; actual launch is confined to the explicit final button handler', () => {
  let autoEffect = 0; let launchRequests = 0; let finalButton = 0;
  traverse(ast('AiProjectLaunch'), {
    CallExpression(call) {
      if (call.node.callee.name === 'useEffect') {
        const effect = source('AiProjectLaunch').slice(call.node.arguments[0].start, call.node.arguments[0].end);
        assert.match(effect, /if \(needsProvider/); assert.match(effect, /void prepare\(\)/); assert.doesNotMatch(effect, /projects_launch['"]|launch\(\)/); autoEffect++;
      }
      if (call.node.callee.name === 'onRequest' && call.node.arguments[0]?.value === 'projects_launch') {
        assert.equal(call.getFunctionParent().parentPath.node.id.name, 'launch'); launchRequests++;
      }
    },
    JSXElement(element) {
      const click = attribute(element.node, 'onClick')?.expression;
      if (element.node.openingElement.name.name === 'button' && click?.type === 'ConditionalExpression' && click.consequent.name === 'launch') {
        assert.equal(click.test.name, 'preview'); assert.equal(click.alternate.name, 'prepare'); finalButton++;
      }
      if (element.node.openingElement.name.name === 'AiToolsDialog') assert.equal(attribute(element.node, 'busy').expression.right.value, 'launch', 'read-only preview remains cancellable');
    },
  });
  assert.equal(autoEffect, 1); assert.equal(launchRequests, 1); assert.equal(finalButton, 1);
});
