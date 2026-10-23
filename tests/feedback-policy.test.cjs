const test = require('node:test'); const assert = require('node:assert/strict');
const { normalizeForm, redactText, environmentForReport, buildReport, issueUrl } = require('../electron/lib/feedback-policy.cjs');
const form = changes => ({ title: '界面显示问题', category: 'ui', description: '打开时出现异常', steps: '打开软件', expected: '正常显示', includeEnvironment: true, includeLogs: false, ...changes });
const id = '00000000-0000-4000-8000-000000000001';
test('report form requires explicit booleans and bounded exact fields', () => {
  assert.equal(normalizeForm(form()).includeLogs, false);
  for (const value of [form({ token: 'secret' }), form({ includeLogs: 'true' }), form({ title: '' }), form({ category: '__proto__' }), form({ title: 'x\ny' }), form({ description: 'x'.repeat(4001) })]) assert.throws(() => normalizeForm(value));
  assert.throws(() => normalizeForm(form({ description: 'bad\x00input' })));
  assert.doesNotThrow(() => normalizeForm(form({ description: 'line one\r\n\tline two' })));
});
test('common credentials, paths and identifying text are removed from report text', () => {
  const input = 'ghp_1234567890abcdefghijk sk-1234567890abcdef Bearer privatevalue123 password=hello api_key=world C:\\Users\\Someone\\secret.txt 192.168.1.33 alice@example.com';
  const output = redactText(input);
  for (const secret of ['1234567890abcdefghijk', '1234567890abcdef', 'privatevalue123', 'hello', 'world', 'Someone', '192.168.1.33', 'alice@example.com']) assert.ok(!output.includes(secret));
});
test('quoted JSON and environment credentials with spaces are also redacted', () => {
  const result = redactText('{"password": "private secret", "ANTHROPIC_AUTH_TOKEN":"secret123"}\nclient_secret=\'secret with spaces\'');
  for (const secret of ['private secret', 'secret123', 'secret with spaces']) assert.ok(!result.includes(secret));
});
test('environment export uses fixed metadata only and log opt-out never includes provided text', () => {
  const env = environmentForReport({ app: { name: '卓控台', version: '4.7.0', secret: 'PRIVATE' }, computer: { model: 'Model', serial: 'PRIVATE' }, password: 'PRIVATE' });
  assert.ok(!JSON.stringify(env).includes('PRIVATE'));
  const report = buildReport(normalizeForm(form()), env, { text: 'PRIVATE_LOG' }, id);
  assert.ok(!report.body.includes('PRIVATE_LOG')); assert.equal(report.log.included, false);
  assert.match(report.body, /workbench-report:00000000/);
});
test('only the selected bounded log tail appears, and fences cannot escape into executable markup', () => {
  const report = buildReport(normalizeForm(form({ includeLogs: true, description: '```\n<script>alert(1)</script>' })), null, { text: 'safe record\n', truncated: true }, id);
  assert.match(report.body, /<details>/); assert.match(report.body, /safe record/); assert.equal(report.log.truncated, true);
  assert.match(report.body, /````text/);
  assert.throws(() => buildReport(normalizeForm(form({ includeLogs: true })), null, { text: 'x'.repeat(16385) }, id));
});
test('only real fixed-repository HTTPS issue links can be opened', () => {
  assert.equal(issueUrl('https://github.com/xiandan001/adb-workbench/issues/123'), 'https://github.com/xiandan001/adb-workbench/issues/123');
  for (const value of ['javascript:alert(1)', 'https://evil.invalid/', 'https://github.com/other/repo/issues/1', 'https://github.com/xiandan001/adb-workbench/issues/1?token=secret']) assert.throws(() => issueUrl(value));
});
