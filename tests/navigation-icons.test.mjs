import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const { Bot, SlidersHorizontal } = require('lucide-react');
const expected = new Map([['AI 工具管理', 'SlidersHorizontal'], ['AI 日志助手', 'Bot']]);

function textOf(node) {
  if (node.type === 'JSXText') return node.value;
  return (node.children || []).map(textOf).join('');
}

function sidebarIcons(source) {
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  const imports = new Map(); const buttons = [];
  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.source.value !== 'lucide-react') continue;
    for (const specifier of statement.specifiers) if (specifier.type === 'ImportSpecifier') imports.set(specifier.local.name, specifier.imported.name);
  }
  traverse(ast, {
    JSXElement(element) {
      if (element.node.openingElement.name.name !== 'button'
        || !element.findParent(parent => parent.isJSXElement() && parent.node.openingElement.name.name === 'nav')) return;
      const label = textOf(element.node).replace(/\s+/g, ' ').trim();
      if (!expected.has(label)) return;
      const icons = element.node.children.filter(child => child.type === 'JSXElement' && imports.has(child.openingElement.name.name));
      assert.equal(icons.length, 1, `${label} should have one lucide icon`);
      const icon = icons[0].openingElement;
      const size = icon.attributes.find(attribute => attribute.type === 'JSXAttribute' && attribute.name.name === 'size');
      buttons.push({ label, icon: imports.get(icon.name.name), size: size?.value?.expression?.value });
    },
  });
  return buttons;
}

test('AI sidebar buttons use distinct semantic icons while keeping the 20px size', () => {
  const buttons = sidebarIcons(readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8'));
  assert.equal(buttons.length, expected.size);
  for (const [label, icon] of expected) {
    const matches = buttons.filter(button => button.label === label);
    assert.equal(matches.length, 1, `${label} should appear once in the sidebar`);
    assert.deepEqual(matches[0], { label, icon, size: 20 });
  }
  assert.notEqual(buttons[0].icon, buttons[1].icon);
});

test('the installed lucide components render two available and distinct 20px SVGs without a GUI', () => {
  const sliders = renderToStaticMarkup(createElement(SlidersHorizontal, { size: 20 }));
  const bot = renderToStaticMarkup(createElement(Bot, { size: 20 }));
  for (const svg of [sliders, bot]) {
    assert.match(svg, /^<svg\b/);
    assert.match(svg, /width="20"/);
    assert.match(svg, /height="20"/);
  }
  assert.match(sliders, /lucide-sliders-horizontal/);
  assert.match(bot, /lucide-bot/);
  assert.notEqual(sliders, bot);
});
