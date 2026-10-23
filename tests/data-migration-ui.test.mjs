import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migrationPasswordProblem, migrationAiRows, readMigrationPreview } from '../src/components/dataMigrationUi.js';

test('migration passwords use UTF-8 byte limits and export requires exact confirmation', () => {
  assert.ok(migrationPasswordProblem('1234567', '1234567', true));
  assert.equal(migrationPasswordProblem('密码测试', '密码测试', true), '');
  assert.ok(migrationPasswordProblem('12345678', 'different', true));
  assert.equal(migrationPasswordProblem('12345678', '', false), '');
  assert.ok(migrationPasswordProblem('a'.repeat(1025), '', false));
  assert.ok(migrationPasswordProblem('12345678\0', '', false));
  assert.ok(migrationPasswordProblem('12345678\ud800', '', false));
});
test('AI summaries distinguish source totals, merged conflicts, omitted sessions and legacy absence', () => {
  assert.deepEqual(migrationAiRows({ encrypted: false }), []);
  assert.deepEqual(migrationAiRows({ encrypted: true }), []);
  const rows = migrationAiRows({ encrypted: true, includesAiSessions: false, ai: { providers: { count: 2 }, mcpServers: { added: 1, skipped: 3 }, sessions: { count: 0 } } });
  assert.equal(rows.find(row => row.key === 'providers').count, 2);
  assert.equal(rows.find(row => row.key === 'mcpServers').count, 4);
  assert.equal(rows.find(row => row.key === 'skills').count, null);
  assert.equal(rows.find(row => row.key === 'sessions').omitted, true);
  assert.equal(rows.find(row => row.key === 'providers').added, null);
});
test('encrypted selection never becomes an import token until a valid decrypted preview exists', () => {
  assert.deepEqual(readMigrationPreview({ ok: true, passwordRequired: true, selectionToken: 'source-lease', fileName: 'test.adbbackup' }), { kind: 'password', selectionToken: 'source-lease', fileName: 'test.adbbackup' });
  assert.throws(() => readMigrationPreview({ ok: false, error: '密码不正确' }), /密码/);
  assert.throws(() => readMigrationPreview({ ok: true, passwordRequired: true }), /选择/);
  assert.throws(() => readMigrationPreview({ ok: true, token: 'stale' }), /预览/);
  const value = { ok: true, token: 'verified', summary: { encrypted: false } };
  assert.deepEqual(readMigrationPreview(value), { kind: 'preview', value });
});
test('sidebar preferences immediately follow membership without removing background task stack', () => {
  const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const nav = source.slice(source.indexOf('<nav'), source.indexOf('</nav>'));
  assert.ok(nav.indexOf('AI 日志助手') < nav.indexOf('会员中心'));
  assert.ok(nav.indexOf('会员中心') < nav.indexOf('偏好设置'));
  assert.ok(source.includes('<BackgroundTaskStack'));
});
