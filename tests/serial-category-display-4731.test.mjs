import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import { listProtocolCommands, getProtocolCategoryLabel } from '../src/shared/rs232Protocol.js';

test('actual category picker keeps canonical builtin groups localized after adding a custom command to that group', () => {
  const source = fs.readFileSync(new URL('../src/components/Rs232ProtocolPanel.jsx', import.meta.url), 'utf8');
  let label;
  traverseModule.default(parse(source, { sourceType: 'module', plugins: ['jsx'] }), { VariableDeclarator({ node }) {
    if (node.id.name === 'categoryLabel') label = source.slice(node.init.start, node.init.end);
  } });
  assert.ok(label);
  const originals = new Map(listProtocolCommands().map(command => [command.id, command]));
  const category = originals.get('lango-005').category;
  const commands = [...originals.values(), { id: 'custom-00000000-0000-4000-8000-000000000001', builtin: false, category }];
  for (const locale of ['en-US', 'zh-TW', 'ja-JP', 'ko-KR']) {
    const display = vm.runInNewContext('(' + label + ')', { locale, commands, originals, getProtocolCategoryLabel });
    assert.equal(display(category), getProtocolCategoryLabel(category, locale));
    assert.equal(display('My literal category'), 'My literal category');
  }
});
