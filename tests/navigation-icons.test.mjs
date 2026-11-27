import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const { Bot, Sparkles } = require('lucide-react');
const expected = new Map([
  ['ai-center', { label: 'AI 中心', icon: 'Sparkles' }],
  ['logs', { label: 'AI 日志助手', icon: 'Bot' }],
]);

function sidebarIcons(source) {
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  const imports = new Map(); const buttons = new Map();
  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.source.value !== 'lucide-react') continue;
    for (const specifier of statement.specifiers) if (specifier.type === 'ImportSpecifier') imports.set(specifier.local.name, specifier.imported.name);
  }
  traverse(ast, {
    ArrayExpression({ node }) {
      const [target, icon, title] = node.elements;
      if (target?.type !== 'StringLiteral' || !expected.has(target.value)) return;
      assert.equal(buttons.has(target.value), false, `${target.value} should have one sidebar destination`);
      assert.equal(title?.body?.callee?.name, 'tr');
      buttons.set(target.value, { label: title.body.arguments[0].value, icon: imports.get(icon?.name) });
    },
  });
  return buttons;
}

test('the AI center and independent log entry retain distinct semantic icons and navigation', () => {
  const sidebar = readFileSync(new URL('../src/components/WorkbenchSidebar.jsx', import.meta.url), 'utf8');
  const tabs = readFileSync(new URL('../src/components/WorkbenchCenterTabs.jsx', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.deepEqual(sidebarIcons(sidebar), expected);
  assert.match(sidebar, /createElement\(icon, \{ size: 18,/);
  assert.match(tabs, /'ai-tools': SlidersHorizontal/);
  assert.match(app, /if \(destination === 'logs'\) \{ void viewApplicationLogs\(\); return; \}/);
});

test('the installed lucide components render available and distinct 18px SVGs without a GUI', () => {
  const sparkles = renderToStaticMarkup(createElement(Sparkles, { size: 18 }));
  const bot = renderToStaticMarkup(createElement(Bot, { size: 18 }));
  for (const svg of [sparkles, bot]) {
    assert.match(svg, /^<svg\b/);
    assert.match(svg, /width="18"/);
    assert.match(svg, /height="18"/);
  }
  assert.match(sparkles, /lucide-sparkles/);
  assert.match(bot, /lucide-bot/);
  assert.notEqual(sparkles, bot);
});
