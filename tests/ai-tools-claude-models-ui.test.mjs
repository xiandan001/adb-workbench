import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { CLAUDE_MODEL_ROLES, claudeRoleSupports1m, cloneClaudeModels, fillClaudeRoles, modelCatalogOptions, modelConfigurationInput, modelReadFeedback, providerModelReadBlockReason, updateClaudeRole } from '../src/components/ai-tools/aiClaudeModelsModel.js';
import { providerDraft, providerInput } from '../src/components/ai-tools/aiToolsModel.js';
import { AI_PROVIDER_PRESETS, applyProviderPreset } from '../src/components/ai-tools/aiProviderPresets.js';

const require = createRequire(import.meta.url);
const { normalizeClaudeModels } = require('../electron/lib/ai-tools-claude-models.cjs');
const { validateProvider } = require('../electron/lib/ai-tools-store.cjs');
const { getAiToolsCatalog } = require('../electron/lib/ai-tools-catalog.cjs');
const saved = { id: '036cb930-9814-4fba-9c83-b8d5fa643f65', name: 'Fixture', protocol: 'anthropic', baseUrl: 'https://fixture.invalid/anthropic', model: 'fixture-default', hasCredential: true, targetApps: ['claude'] };
const mapping = () => ({ sonnet: { model: 'fixture-sonnet', displayName: 'Daily', supports1m: false }, subagent: { model: 'fixture-subagent' } });

test('model drafts round-trip existing role definitions without secrets or unintended native clears', () => {
  const legacy = providerInput(providerDraft(saved), saved);
  assert.equal(Object.hasOwn(legacy, 'claudeModels'), false); assert.equal(Object.hasOwn(legacy, 'apiKey'), false);
  const original = { ...saved, claudeModels: mapping() }; const draft = providerDraft(original);
  assert.deepEqual(providerInput(draft, original).claudeModels, mapping());
  draft.claudeModels.sonnet.model = 'changed'; assert.equal(original.claudeModels.sonnet.model, 'fixture-sonnet');
  const changedProtocol = providerInput({ ...providerDraft(original), baseUrl: 'https://fixture.invalid/v1', protocol: 'openai-responses', targetApps: ['codex'] }, original);
  assert.deepEqual(changedProtocol.claudeModels, mapping());
  assert.deepEqual(modelConfigurationInput({ model: 'manual', claudeModels: {} }), { model: 'manual', claudeModels: {} });
});

test('editing only one role leaves all unedited legacy roles absent and allows an explicit clear', () => {
  const changed = updateClaudeRole(undefined, 'haiku', { model: 'fast' });
  assert.deepEqual(Object.keys(changed), ['haiku']); assert.deepEqual(changed.haiku, { model: 'fast', displayName: '', supports1m: false });
  const cleared = updateClaudeRole(changed, 'haiku', { model: '' });
  assert.equal(modelConfigurationInput({ model: 'default', claudeModels: cleared }).claudeModels.haiku.model, '');
  assert.equal(changed.haiku.model, 'fast');
  const subagent = updateClaudeRole(undefined, 'subagent', { model: 'worker' });
  assert.equal(Object.hasOwn(subagent.subagent, 'displayName'), false);
  assert.throws(() => updateClaudeRole(undefined, 'unknown', { model: 'm' }), /角色/);
});

test('one-click fill covers four visible aliases, preserves subagent and never opts into 1M', () => {
  const original = mapping(); original.sonnet.supports1m = true;
  const result = fillClaudeRoles(original, 'new-model[1m]');
  for (const { id } of CLAUDE_MODEL_ROLES.filter(row => row.id !== 'subagent')) {
    assert.equal(result[id].model, 'new-model'); assert.equal(result[id].supports1m, false);
  }
  assert.equal(result.sonnet.displayName, 'Daily'); assert.deepEqual(result.subagent, original.subagent);
  assert.equal(original.sonnet.model, 'fixture-sonnet'); assert.equal(original.sonnet.supports1m, true);
  assert.equal(Object.hasOwn(fillClaudeRoles(undefined, 'default'), 'subagent'), false);
  assert.throws(() => fillClaudeRoles(undefined, '  '), /默认模型/);
});

test('literal 1M model suffixes are visibly declared and an explicit uncheck removes their suffix', () => {
  assert.equal(claudeRoleSupports1m({ model: 'm' }), false);
  assert.equal(claudeRoleSupports1m({ model: 'm', supports1m: true }), true);
  assert.equal(claudeRoleSupports1m({ model: 'm[1m]', supports1m: false }), true);
  const value = { sonnet: { model: 'm[1m][1m]', displayName: 'Name' } };
  const changed = updateClaudeRole(value, 'sonnet', { supports1m: false });
  assert.deepEqual(changed.sonnet, { model: 'm', displayName: 'Name', supports1m: false });
  assert.equal(value.sonnet.model, 'm[1m][1m]');
});

test('frontend and main role validators agree on strict keys, lengths, controls and reserved model names', () => {
  for (const value of [mapping(), {}, { fable: { model: '', displayName: '', supports1m: false } }, { opus: { model: 'm'.repeat(256), displayName: 'n'.repeat(120), supports1m: true } }]) assert.deepEqual(cloneClaudeModels(value), normalizeClaudeModels(value));
  const invalid = [null, [], { unsupported: { model: 'm' } }, { sonnet: {} }, { sonnet: { model: 1 } }, { sonnet: { model: 'm', unknown: true } },
    { subagent: { model: 'm', displayName: '' } }, { haiku: { model: 'm', supports1m: 'true' } }, { opus: { model: 'm', displayName: false } },
    { sonnet: { model: 'm'.repeat(257) } }, { sonnet: { model: 'm', displayName: 'n'.repeat(121) } }, { sonnet: { model: 'bad\nmodel' } }, { sonnet: { model: 'm', displayName: 'bad\u0085name' } },
    ...['constructor', '__proto__', 'prototype[1m]'].map(model => ({ sonnet: { model } })), JSON.parse('{"__proto__":{"model":"m"}}')];
  for (const value of invalid) { assert.throws(() => cloneClaudeModels(value)); assert.throws(() => normalizeClaudeModels(value)); }
  assert.deepEqual(modelConfigurationInput({ model: 'manual-unlisted-model' }, { requireModel: true }), { model: 'manual-unlisted-model' });
  assert.throws(() => modelConfigurationInput({ model: '' }, { requireModel: true }), /默认模型/);
  const input = providerInput({ ...providerDraft(saved), claudeModels: mapping() }, saved);
  assert.deepEqual(validateProvider(input).claudeModels, mapping());
});

test('catalog reads require saved matching endpoint/protocol/credentials, not just the same origin', () => {
  const draft = providerDraft(saved);
  assert.equal(providerModelReadBlockReason(draft, saved), '');
  assert.equal(providerModelReadBlockReason({ ...draft, name: 'Edited name', model: 'new-model', claudeModels: mapping() }, saved), '');
  assert.equal(providerModelReadBlockReason({ ...draft, baseUrl: `${saved.baseUrl}/` }, saved), '');
  for (const change of [{ baseUrl: 'https://another.invalid/v1' }, { baseUrl: 'https://fixture.invalid/other' }, { protocol: 'openai-chat' }, { apiKey: 'new-draft-secret' }, { clearKey: true }]) assert.match(providerModelReadBlockReason({ ...draft, ...change }, saved), /先保存/);
  assert.match(providerModelReadBlockReason(providerDraft(), null), /先保存供应商/);
  assert.match(providerModelReadBlockReason(draft, { ...saved, hasCredential: false }), /API 密钥/);
});

test('searchable catalog choices are bounded and optional without guessing manual model availability', () => {
  const rows = [{ id: 'model-a', name: 'Daily model' }, { id: 'model-b', name: 'Reasoner' }, { id: 'model-a', name: 'Daily model' }, { id: 'constructor' }, { id: 'bad\nmodel' }, { id: 42 }];
  assert.deepEqual(modelCatalogOptions(rows, 'daily'), { options: [{ value: 'model-a', label: 'Daily model · model-a' }], count: 1 });
  assert.equal(modelCatalogOptions(rows).count, 2);
  assert.deepEqual(modelCatalogOptions([], 'anything'), { options: [], count: 0 });
  const large = Array.from({ length: 700 }, (_, index) => ({ id: `model-${index}` }));
  const all = modelCatalogOptions(large); assert.equal(all.count, 700); assert.equal(all.options.length, 200);
  assert.equal(modelCatalogOptions(large, 'model-699').options[0].value, 'model-699');
});

test('unsupported model discovery is an amber capability notice and does not prevent manual saving', () => {
  const feedback = modelReadFeedback({ code: 'AI_TOOLS_MODELS_UNSUPPORTED', message: 'unsupported' });
  assert.equal(feedback.kind, 'warning'); assert.match(feedback.message, /不代表密钥无效/);
  assert.doesNotThrow(() => providerInput({ ...providerDraft(saved), model: 'manual-model', claudeModels: mapping() }, saved));
  assert.equal(modelReadFeedback({ code: 'AI_TOOLS_PROVIDER_AUTH', message: '认证失败' }).kind, 'error');
});

test('new provider forms preselect a real target tool without changing an existing provider', () => {
  const tools = getAiToolsCatalog();
  const claude = providerDraft(null, { defaultToolId: 'claude', tools }); assert.equal(claude.protocol, 'anthropic'); assert.deepEqual(claude.targetApps, ['claude']);
  const codex = providerDraft(null, { defaultToolId: 'codex', tools }); assert.equal(codex.protocol, 'openai-responses'); assert.deepEqual(codex.targetApps, ['codex']);
  assert.deepEqual(providerDraft(null, { defaultToolId: 'missing', tools }).targetApps, []);
  assert.deepEqual(providerDraft(saved, { defaultToolId: 'codex', tools }).targetApps, ['claude']);
  assert.equal(Object.hasOwn(claude, 'claudeModels'), false);
});

test('GLM and common presets set compatible tools but reset all typed credentials and model mappings', () => {
  const original = { ...providerDraft(), apiKey: 'fixture-private-key', quotaKey: 'fixture-quota-key', quotaTemplate: 'old-private-template', model: 'old-model', claudeModels: mapping() };
  const glm = AI_PROVIDER_PRESETS.find(row => row.value === 'zhipu-claude');
  assert.equal(glm.baseUrl, 'https://open.bigmodel.cn/api/anthropic'); assert.equal(glm.protocol, 'anthropic'); assert.deepEqual(glm.targetApps, ['claude']); assert.equal(glm.quota, 'zhipu');
  const tools = getAiToolsCatalog();
  for (const preset of AI_PROVIDER_PRESETS) {
    const next = applyProviderPreset(original, preset.value);
    assert.equal(next.apiKey, ''); assert.equal(next.quotaKey, ''); assert.equal(next.quotaTemplate, ''); assert.equal(next.model, ''); assert.equal(Object.hasOwn(next, 'claudeModels'), false);
    assert.ok(next.targetApps.every(id => tools.find(row => row.id === id)?.protocols.includes(next.protocol)));
    assert.doesNotThrow(() => validateProvider(providerInput({ ...next, name: 'Preset' })));
  }
  assert.equal(original.apiKey, 'fixture-private-key'); assert.deepEqual(original.claudeModels, mapping());
});

test('shared model editor and dialogs use manual inputs/custom menus without mount-time model requests', () => {
  const editor = fs.readFileSync(new URL('../src/components/ai-tools/AiClaudeModelsEditor.jsx', import.meta.url), 'utf8');
  const form = fs.readFileSync(new URL('../src/components/ai-tools/AiProviderForm.jsx', import.meta.url), 'utf8');
  const dialog = fs.readFileSync(new URL('../src/components/ai-tools/AiModelsDialog.jsx', import.meta.url), 'utf8');
  assert.match(editor, /<SelectMenu/); assert.doesNotMatch(editor, /<select[\s>]/);
  assert.match(editor, /onClick=\{readModels\}/); assert.match(editor, /if \(!onReadModels \|\| readBlockedReason/);
  assert.match(editor, /useState\(focusModels\)/); assert.match(editor, /仅是向客户端声明上下文能力/);
  assert.match(form, /providerModelReadBlockReason\(draft, provider\)/); assert.match(form, /<AiClaudeModelsEditor/);
  assert.match(dialog, /models = \[\]/); assert.match(dialog, /onSave\(modelConfigurationInput\(value/);
  assert.match(dialog, /保存模型配置/); assert.match(editor, /label="AI 默认模型"/);
});
