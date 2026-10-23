import test from 'node:test';
import assert from 'node:assert/strict';
import { providerFingerprint, providerFeedbackToken, providerFeedbackCurrent, connectionFeedback, providerHomeTool, providerStatusRows } from '../src/components/ai-tools/aiProviderHomeModel.js';

const provider = { id: 'one', name: 'Saved', protocol: 'anthropic', baseUrl: 'https://fixture.invalid', model: 'manual', targetApps: ['claude'], hasCredential: true };
test('connection feedback distinguishes readable model discovery from partial response without claiming key/inference verification', () => {
  const verified = connectionFeedback({ reachable: true, status: 'verified', modelsSupported: true, authentication: 'unverified', modelCount: 0, latencyMs: 12 });
  assert.equal(verified.status, 'verified'); assert.match(verified.message, /模型列表读取成功/); assert.match(verified.message, /未验证密钥权限或模型调用/);
  const partial = connectionFeedback({ reachable: true, status: 'partial', modelsSupported: false, authentication: 'unverified' });
  assert.equal(partial.status, 'partial'); assert.match(partial.message, /尚未验证密钥或模型/);
  assert.throws(() => connectionFeedback({ reachable: true, status: 'verified', modelsSupported: false }), /确认/);
  assert.throws(() => connectionFeedback({ reachable: false, status: 'partial' }), /确认/);
});
test('feedback fingerprint and epoch invalidate old keys even when public credential flags are unchanged', () => {
  const token = providerFeedbackToken(provider, 1);
  assert.equal(providerFeedbackCurrent(token, provider, 1), true);
  assert.equal(providerFeedbackCurrent(token, { ...provider }, 2), false);
  assert.equal(providerFeedbackCurrent(token, { ...provider, model: 'changed' }, 1), false);
  assert.equal(providerFeedbackCurrent(token, null, 1), false);
  assert.equal(providerFingerprint({ ...provider, apiKey: 'never-store-this', quotaKey: 'private' }).includes('private'), false);
  assert.equal(providerFingerprint({ ...provider, apiKey: 'never-store-this' }).includes('never-store-this'), false);
});
test('tool defaults are compatible and an explicit selection survives other-provider saves', () => {
  const tools = [{ id: 'codex', configSupported: true, protocols: ['openai-responses'] }, { id: 'claude', configSupported: true, protocols: ['anthropic'] }];
  assert.equal(providerHomeTool(tools, [provider], '').id, 'claude');
  assert.equal(providerHomeTool(tools, [provider, { ...provider, id: 'two' }], 'codex').id, 'codex');
  assert.equal(providerHomeTool(tools, [], '').id, 'codex');
});
test('native active/configured state is accepted only for the current completed read, never after failure, refresh or context round trip', () => {
  const context = { active: true, ready: true, key: 'claude:revision-1' };
  const native = { context, value: { providers: [{ providerId: 'one', state: 'active' }, { providerId: 'two', state: 'configured' }] } };
  assert.equal(providerStatusRows(native, context, false).length, 2);
  assert.deepEqual(providerStatusRows(native, context, true), []);
  assert.deepEqual(providerStatusRows(null, context, false), []);
  assert.deepEqual(providerStatusRows(native, { ...context }, false), []);
  assert.deepEqual(providerStatusRows(native, { ...context, key: 'claude:revision-2' }, false), []);
});
