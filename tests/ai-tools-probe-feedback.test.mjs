import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { connectionCompletionNotice, connectionFeedback, providerFeedbackCurrent, providerFeedbackToken, retainProviderFeedback } from '../src/components/ai-tools/aiProviderHomeModel.js';

const provider = { id: 'fixture', name: 'Fixture', protocol: 'anthropic', baseUrl: 'https://fixture.invalid/anthropic', model: 'fixture-model', targetApps: ['claude'], hasCredential: true };
test('focus and quota snapshot refreshes retain an in-flight token and the eventual successful result', async () => {
  const epoch = 7; const token = providerFeedbackToken(provider, epoch); let records = { [provider.id]: { token, value: { status: 'pending', message: 'Waiting or testing' } } };
  let resolve; const request = new Promise(done => { resolve = done; });
  for (let i = 0; i < 3; i++) records = retainProviderFeedback(records, [structuredClone(provider)], epoch, true);
  assert.equal(records[provider.id].value.status, 'pending'); assert.equal(providerFeedbackCurrent(token, provider, epoch), true);
  resolve({ reachable: true, status: 'verified', mode: 'inference', inferenceVerified: true, model: provider.model, hasTextResponse: true });
  const value = connectionFeedback(await request); records[provider.id] = { token, value };
  records = retainProviderFeedback(records, [structuredClone(provider)], epoch, true); assert.match(records[provider.id].value.message, /模型调用成功/);
});
test('configuration change, provider removal and membership loss invalidate saved or pending feedback', () => {
  const epoch = 1; const records = { fixture: { token: providerFeedbackToken(provider, epoch), value: { status: 'verified' } } };
  assert.deepEqual(retainProviderFeedback(records, [{ ...provider, model: 'changed' }], epoch, true), {});
  assert.deepEqual(retainProviderFeedback(records, [provider], epoch + 1, true), {});
  assert.deepEqual(retainProviderFeedback(records, [], epoch, true), {});
  assert.deepEqual(retainProviderFeedback(records, [provider], epoch, false), {});
});
test('cancel, partial read-only, verified inference and failures have truthful distinct completion notices', () => {
  assert.equal(connectionCompletionNotice({ cancelled: true }), '已取消连接测试');
  const partial = connectionFeedback({ reachable: true, status: 'partial', modelsSupported: false }); assert.match(connectionCompletionNotice({}, partial), /尚未验证/);
  assert.match(connectionCompletionNotice({ mode: 'inference' }, { status: 'verified' }), /成功/);
  assert.match(connectionCompletionNotice({}, { status: 'verified' }), /只读.*尚未验证/);
  assert.match(connectionCompletionNotice(null, { status: 'error', message: 'Fixture rejected' }), /失败/);
});
test('ordinary refresh does not invalidate feedback and the UI announces pending and durable result states', () => {
  const source = fs.readFileSync(new URL('../src/components/ai-tools/AiToolsWorkspace.jsx', import.meta.url), 'utf8');
  const refresh = source.slice(source.indexOf('const refresh ='), source.indexOf('useEffect(() => { alive.current'));
  assert.doesNotMatch(refresh, /invalidateFeedback\(/); assert.match(source, /retainProviderFeedback\(previous/); assert.match(source, /showToast\?\.\(connectionCompletionNotice/);
  const home = fs.readFileSync(new URL('../src/components/ai-tools/AiProviderHome.jsx', import.meta.url), 'utf8');
  for (const label of ['连接测试反馈', '连接测试失败', '连接测试进行中', '连接检查成功']) assert.ok(home.includes(label));
  assert.match(home, /connection\.status === 'cancelled'/);
});
