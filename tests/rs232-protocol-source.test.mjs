import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = file => JSON.parse(fs.readFileSync(new URL(file, import.meta.url), 'utf8'));
const load = () => read('../electron/lib/rs232-protocol-catalog.json');
test('catalog preserves every captured source row, category, original TX/RX cell and ordinal', () => {
  const catalog = load(), reference = read('./fixtures/rs232-protocol-source.json');
  assert.equal(catalog.commands.length, 115); assert.equal(catalog.categories.length, 17); assert.equal(reference.commands.length, 111);
  for (const expected of reference.commands) {
    const entry = catalog.commands[expected.sourceIndex - 1];
    for (const key of ['name', 'category', 'sourceIndex', 'sourceControl', 'sourceResponse', 'sourceControlCell', 'sourceResponseCell']) assert.equal(entry[key], expected[key], `${entry.id} ${key}`);
    assert.equal(entry.id, 'lango-' + String(expected.sourceIndex).padStart(3, '0')); assert.ok(entry.sourceNote.length > 0);
  }
  assert.deepEqual(catalog.categories.map(group => catalog.commands.filter(entry => entry.category === group.name).length), [16, 22, 7, 10, 9, 5, 5, 6, 8, 2, 7, 2, 4, 3, 1, 1, 3]);
  assert.deepEqual(catalog.source.documents.map(document => document.sha256), reference.sourceHashes);
});
test('the five unsafe source TX rows are marked without guessing corrected opcodes', () => {
  const entries = load().commands;
  assert.deepEqual(entries.filter(entry => entry.needsReview).map(entry => entry.sourceIndex), [45, 80, 92, 102, 105]);
  assert.equal(entries[44].template, 'FE 08 58 42 48 43 4D 44 02 21 CF');
  assert.equal(entries[91].template, 'FE 08 58 42 48 43 4D 44 03 16 CF');
  assert.equal(entries[104].template, 'FE 08 58 42 48 43 4D 44 02 1B {XX} CF');
});
test('all four board reports remain reference-only and ordinary RX defects do not block valid controls', () => {
  const entries = load().commands, reports = entries.filter(entry => entry.referenceOnly);
  assert.deepEqual(reports.map(entry => entry.id), ['lango-report-1', 'lango-report-2', 'lango-report-3', 'lango-report-4']);
  for (const index of [50, 52, 54, 56, 68, 70, 79, 99, 108]) assert.equal(entries[index - 1].needsReview, false);
  assert.equal(entries[49].sourceResponse, 'FE 0A58 42 48 43 4D 44 03 22 XX YY CF');
  assert.equal(reports[0].sourceResponse, 'FE 0A 58 42 48 43 4D 44 05 01 XX CF');
});
test('all built-in function and category names have explicit five-locale data labels', () => {
  const catalog = load();
  for (const entry of [...catalog.commands, ...catalog.categories, catalog.reportCategory]) {
    for (const locale of ['zh-CN', 'en-US', 'zh-TW', 'ja-JP', 'ko-KR']) assert.ok(typeof entry.labels[locale] === 'string' && entry.labels[locale].trim());
    assert.equal(entry.labels['zh-CN'], entry.name);
  }
});
test('actual Excel sheet rows, complete notes and report cells are preserved independently of the display ordinal', () => {
  const catalog = load(), fixture = read('./fixtures/rs232-protocol-source.json');
  assert.equal(catalog.source.workbook.sha256, '76f3e3cb2486cf64037c6df0fc3295d93fa52b752127cba0284c29b57e891ba3');
  assert.equal(catalog.source.hardwareValidated, false);
  for (const entry of catalog.commands) {
    const original = entry.referenceOnly ? fixture.reports[entry.sourceIndex - 1] : fixture.commands[entry.sourceIndex - 1];
    for (const key of ['sourceSheet', 'sourceRow', 'sourceName', 'sourceNote']) assert.equal(entry[key], original[key]);
    assert.deepEqual(entry.sourceCells, original.sourceCells);
    assert.equal(entry.sourceCells.C.trim().replace(/\s+/gu, ' '), entry.sourceControl); assert.equal(entry.sourceCells.D.trim().replace(/\s+/gu, ' '), entry.sourceResponse);
  }
  assert.equal(catalog.commands[79].sourceRow, 89); assert.equal(catalog.commands[97].sourceRow, 111); assert.equal(catalog.commands[110].sourceRow, 125);
});
test('all 31 channel options retain their original codes and carry explicit native Japanese/Korean input labels', () => {
  const channel = load().commands[36].parameters[0], known = channel.options.filter(option => option.value !== 255);
  assert.equal(known.length, 31); assert.deepEqual(known.map(option => option.value), Array.from({ length: 31 }, (_, index) => index));
  for (const option of known) {
    assert.equal(option.labels['zh-CN'], option.label); assert.equal(option.labels['en-US'], option.label); assert.equal(option.labels['zh-TW'], option.label);
    assert.equal(option.labels['ja-JP'], option.label + ' 入力'); assert.equal(option.labels['ko-KR'], option.label + ' 입력');
  }
  const unknown = channel.options.find(option => option.value === 255); assert.equal(unknown.labels['ja-JP'], '不明な入力'); assert.equal(unknown.labels['ko-KR'], '알 수 없는 입력');
});
