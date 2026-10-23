import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

function scripts(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
    if (entry.isDirectory()) return scripts(target);
    return /\.(?:cjs|mjs|js|jsx)$/.test(entry.name) && entry.name !== 'api-keys.cjs' ? [target] : [];
  });
}

test('application confirmation and message flows do not regress to system or browser default dialogs', () => {
  const offenders = [];
  for (const directory of ['src/', 'electron/']) {
    for (const file of scripts(new URL(`../${directory}`, import.meta.url))) {
      const source = readFileSync(file, 'utf8');
      if (/\bshowMessageBox(?:Sync)?\s*\(|\b(?:window|globalThis)\.(?:confirm|prompt|alert)\s*\(/.test(source)) offenders.push(file.pathname);
    }
  }
  assert.deepEqual(offenders, [], 'Route user confirmations through the themed app dialog host');
});

test('the only native error box is the fatal startup failure before the app UI is available', () => {
  const errors = [];
  for (const file of scripts(new URL('../electron/', import.meta.url))) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\bshowErrorBox\s*\(([^\n]+)/g)) errors.push({ file: file.pathname.split('/').at(-1), text: match[1] });
  }
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, 'main.cjs');
  assert.match(errors[0].text, /数据迁移未完成/);
});

test('the shared dialog host stays mounted at app root across workspace changes', () => {
  const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(source, /<AppMessageDialogHost theme=\{t\} isDark=\{isDark\} \/>/);
  assert.equal(source.match(/<AppMessageDialogHost\b/g).length, 1);
});
