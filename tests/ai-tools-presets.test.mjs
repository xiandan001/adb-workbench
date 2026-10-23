import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_PROVIDER_PRESETS, applyProviderPreset } from '../src/components/ai-tools/aiProviderPresets.js';
import { providerDraft, providerInput } from '../src/components/ai-tools/aiToolsModel.js';

test('provider templates only fill known endpoints/protocol and never invent a model or carry typed credentials', () => {
  const old = { ...providerDraft(), name: 'custom', model: 'old-model', apiKey: 'typed-secret', quotaKey: 'typed-quota', contextWindow: '200000', targetApps: ['kimi'] };
  for (const preset of AI_PROVIDER_PRESETS) {
    const draft = applyProviderPreset(old, preset.value);
    assert.equal(draft.baseUrl, preset.baseUrl); assert.equal(draft.protocol, preset.protocol);
    assert.equal(draft.model, ''); assert.equal(draft.apiKey, ''); assert.equal(draft.quotaKey, ''); assert.equal(draft.contextWindow, '');
    assert.deepEqual(draft.targetApps, preset.targetApps);
  }
  assert.equal(old.apiKey, 'typed-secret'); assert.equal(old.model, 'old-model');
  assert.throws(() => applyProviderPreset(old, 'not-known'), /模板/);
});
test('template selection does not bypass saved credential cross-origin protection', () => {
  const original = { id: 'one', name: 'Saved', baseUrl: 'https://old.example/v1', protocol: 'openai-chat', model: 'model', hasCredential: true };
  const next = applyProviderPreset(providerDraft(original), 'deepseek');
  assert.throws(() => providerInput(next, original), /新密钥/);
  assert.equal(providerInput({ ...next, apiKey: 'new-key' }, original).apiKey, 'new-key');
});
