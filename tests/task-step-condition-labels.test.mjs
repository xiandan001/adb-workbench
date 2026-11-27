import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'rolldown/utils';

const source = readFileSync(new URL('../src/components/TaskCenter.jsx', import.meta.url), 'utf8');
const start = source.indexOf('function renderStepFields(');
const end = source.indexOf('function TaskList(', start);
const { code } = transformSync('TaskStepFields.jsx', source.slice(start, end), { jsx: { runtime: 'classic', pragma: 'jsx', pragmaFrag: 'Fragment' } });
const fields = runInNewContext(`(function(){${code};return renderStepFields;})()`, {
  tr: label => label, Fragment: 'fragment', TextField: 'text', NumberField: 'number',
  jsx: (type, props, ...children) => ({ type, props, children })
});
const nodes = value => !value || typeof value !== 'object' ? [] : [value, ...value.children.flat(Infinity).flatMap(nodes)];

test('wait log shows one required group with independent keyword and regex entry', () => {
  const updates = [], page = fields({ type: 'waitLog', keyword: '', regex: '' }, patch => updates.push(patch), false);
  const group = nodes(page).find(node => node.type === 'fieldset'); assert.ok(group);
  assert.match(nodes(group).find(node => node.type === 'legend').children.join(''), /至少填写一项/);
  const inputs = nodes(group).filter(node => node.type === 'text'); assert.equal(inputs.length, 2);
  inputs[0].props.onChange('timeout'); inputs[1].props.onChange('E[0-9]+');
  assert.deepEqual(structuredClone(updates), [{ keyword: 'timeout' }, { regex: 'E[0-9]+' }]);
});

test('wait and assert mark the selector group, not any single locator as required', () => {
  for (const type of ['waitText', 'assertText']) {
    const page = fields({ type }, () => {}, false);
    const group = nodes(page).find(node => node.type === 'fieldset'); assert.ok(group);
    assert.match(nodes(group).find(node => node.type === 'legend').children.join(''), /至少填写一项/);
    const locators = nodes(group).filter(node => node.type === 'text');
    assert.equal(locators.length, 6);
    assert.ok(locators.every(node => !node.props.required));
    assert.equal(nodes(page).filter(node => node.type === 'number').length, type === 'waitText' ? 1 : 0);
  }
});
