import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { AI_CLI_CONFIG_FIELDS, cliConfigDraft, cliConfigInput, cliEndpointError, updateCliOption } from '../src/components/ai-tools/aiCliConfigModel.js';
import { providerDraft, providerInput } from '../src/components/ai-tools/aiToolsModel.js';
import { applyProviderPreset } from '../src/components/ai-tools/aiProviderPresets.js';
const require = createRequire(import.meta.url); const { normalizeCliConfig } = require('../electron/lib/ai-tools-cli-config.cjs');
const saved = { id: 'df3c50a3-d321-4cf7-92b1-76a90c381ead', name: 'Fixture', protocol: 'openai-responses', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', targetApps: ['codex'], hasCredential: true };

test('native CLI drafts preserve absent settings and round-trip explicit values without metadata credentials', () => {
  assert.equal(Object.hasOwn(providerInput(providerDraft(saved), saved), 'cliConfig'), false);
  const original = { ...saved, cliConfig: { claude: { agentTeams: false, timeoutMs: null }, codex: { contextWindow: 128000, httpHeaders: { 'User-Agent': 'fixture-client' }, extraToml: '[tui]\nanimations=true' } } };
  const draft = providerDraft(original); assert.equal(typeof draft.cliConfig.codex.httpHeadersText, 'string'); assert.equal(Object.hasOwn(draft.cliConfig.codex, 'httpHeaders'), false);
  assert.deepEqual(providerInput(draft, original).cliConfig, original.cliConfig);
  draft.cliConfig.codex.contextWindow = '256000'; assert.equal(original.cliConfig.codex.contextWindow, 128000);
  assert.equal(providerInput(draft, original).cliConfig.codex.contextWindow, 256000);
});
test('structured native controls represent unchanged, explicit false and null independently', () => {
  const enabled = updateCliOption(undefined, 'claude', 'agentTeams', true); assert.deepEqual(enabled, { claude: { agentTeams: true } });
  const disabled = updateCliOption(enabled, 'claude', 'agentTeams', false); assert.equal(disabled.claude.agentTeams, false);
  const removed = updateCliOption(disabled, 'claude', 'agentTeams', null); assert.equal(removed.claude.agentTeams, null);
  const untouched = updateCliOption(removed, 'claude', 'agentTeams', undefined); assert.equal(Object.hasOwn(untouched.claude, 'agentTeams'), false);
  assert.equal(enabled.claude.agentTeams, true);
  assert.doesNotThrow(() => normalizeCliConfig(cliConfigInput(removed)));
});
test('numeric native drafts validate bounds and never convert invalid input to a silent null', () => {
  for (const field of AI_CLI_CONFIG_FIELDS.claude.filter(row => row.type === 'integer')) {
    assert.equal(cliConfigInput({ claude: { [field.key]: String(field.min) } }).claude[field.key], field.min);
    for (const value of ['bad', '-1', '1.5', '1e6', String(field.max + 1)]) assert.throws(() => cliConfigInput({ claude: { [field.key]: value } }));
  }
});
test('header editor validates duplicate keys, preserves null deletion and passes only explicit parsed static values', () => {
  assert.deepEqual(cliConfigInput({ codex: { httpHeadersText: '{"User-Agent":"fixture"}' } }), { codex: { httpHeaders: { 'User-Agent': 'fixture' } } });
  assert.deepEqual(cliConfigInput({ codex: { httpHeadersText: 'null' } }), { codex: { httpHeaders: null } });
  assert.deepEqual(cliConfigInput({ codex: { httpHeadersText: '' } }), { codex: {} });
  for (const value of ['[]', '{broken', '{"User-Agent":"one","user-agent":"two"}']) assert.throws(() => cliConfigInput({ codex: { httpHeadersText: value } }));
  assert.throws(() => normalizeCliConfig(cliConfigInput({ codex: { httpHeadersText: '{"Authorization":"secret"}' } })), /认证头/);
  assert.deepEqual(cliConfigInput(cliConfigDraft({ codex: { httpHeaders: null } })), { codex: { httpHeaders: null } });
});
test('endpoint warnings block known cross-protocol mistakes without guessing arbitrary gateway support', () => {
  assert.match(cliEndpointError('openai-responses', 'https://fixture.invalid/api/anthropic', ['codex']), /Responses/);
  assert.match(cliEndpointError('anthropic', 'https://fixture.invalid/v1/responses', ['claude']), /Messages/);
  assert.equal(cliEndpointError('openai-responses', 'https://fixture.invalid/custom', ['codex']), '');
  assert.throws(() => providerInput({ ...providerDraft(saved), baseUrl: 'https://fixture.invalid/anthropic' }, saved), /Responses/);
});
test('provider templates do not accidentally carry advanced defaults or headers to a different service', () => {
  const draft = providerDraft({ ...saved, cliConfig: { codex: { reasoningEffort: 'high', httpHeaders: { 'OpenAI-Project': 'old-project' } } } });
  const reset = applyProviderPreset(draft, 'zhipu-claude'); assert.equal(Object.hasOwn(reset, 'cliConfig'), false); assert.equal(draft.cliConfig.codex.reasoningEffort, 'high');
});
