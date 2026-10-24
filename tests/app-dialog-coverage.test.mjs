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

test('native error boxes are limited to fatal migration or first-language persistence failures before the UI exists', () => {
  const errors = [];
  for (const file of scripts(new URL('../electron/', import.meta.url))) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\bshowErrorBox\s*\(([^\n]+)/g)) errors.push({ file: file.pathname.split('/').at(-1), text: match[1] });
  }
  assert.equal(errors.length, 2);
  assert.ok(errors.every(error => error.file === 'main.cjs'));
  assert.equal(errors.filter(error => error.text.includes('数据迁移未完成')).length, 1);
  assert.equal(errors.filter(error => error.text.includes('语言设置保存失败，请重试')).length, 1);
  const source = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const startup = source.indexOf('app.whenReady().then');
  const firstWindow = source.indexOf('createWindow();', startup);
  for (const match of source.matchAll(/dialog\.showErrorBox\([^\n]+\);/g)) {
    assert.ok(match.index > startup && match.index < firstWindow);
    assert.match(source.slice(match.index + match[0].length, match.index + match[0].length + 100), /^\s*app\.exit\(1\);\s*return;/);
  }
});

test('the shared dialog host stays mounted at app root across workspace changes', () => {
  const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(source, /<AppMessageDialogHost theme=\{t\} isDark=\{isDark\} \/>/);
  assert.equal(source.match(/<AppMessageDialogHost\b/g).length, 1);
});
