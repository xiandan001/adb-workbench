import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createElement, Fragment, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'rolldown/utils';
import * as model from '../src/components/ai-tools/aiToolsModel.js';

const saved = { id: 'saved-fixture', name: 'Fixture', model: 'fixture-model', targetApps: [], protocol: 'openai-chat',
  baseUrl: 'https://provider.invalid/v1', hasCredential: true, hasQuotaCredential: true, quota: { adapter: 'deepseek' } };
const draft = model.providerDraft(saved);
const check = (changes, original = saved) => model.providerCredentialContext({ ...draft, ...changes }, original);

test('editing paths or returning to the original origin preserves credentials; changing origins does not', () => {
  assert.equal(check({ baseUrl: ' https://PROVIDER.invalid:443/other ' }).apiScopeChanged, false);
  const moved = { ...draft, baseUrl: 'https://different.invalid/v1' };
  assert.equal(check(moved).apiScopeChanged, true);
  assert.throws(() => model.providerInput(moved, saved), /新密钥/);
  assert.throws(() => model.providerInput({ ...moved, clearKey: true }, saved), /新的额度密钥/);
  const payload = model.providerInput({ ...moved, clearKey: true, clearQuotaKey: true, apiKey: 'fixture-draft-only' }, saved);
  assert.equal(payload.apiKey, null);
  assert.equal(payload.quotaKey, null);
  const unchanged = model.providerInput({ ...moved, baseUrl: 'https://provider.invalid/v2' }, saved);
  assert.equal(Object.hasOwn(unchanged, 'apiKey'), false);
  assert.equal(Object.hasOwn(unchanged, 'quotaKey'), false);
});

test('quota changes follow the same adapter and effective origin check as saving', () => {
  assert.equal(check({ quota: { adapter: 'deepseek', credentialOrigin: 'https://provider.invalid' } }).quotaScopeChanged, false);
  assert.equal(check({ quota: { adapter: 'novita' } }).quotaScopeChanged, true);
  assert.equal(check({ quota: null }).quotaScopeChanged, true);
  const quota = { adapter: 'deepseek', credentialOrigin: 'https://quota.invalid' };
  assert.equal(check({ quota }).quotaScopeChanged, true);
  assert.equal(check({ quota }).crossOriginQuota, true);
  const scoped = { ...saved, quota };
  assert.equal(check({ quota, baseUrl: 'https://elsewhere.invalid/v1' }, scoped).quotaScopeChanged, false);
  assert.throws(() => model.providerInput({ ...draft, quota }, saved), /新的额度密钥/);
  assert.equal(model.providerInput({ ...draft, quota, quotaKey: 'fixture-quota-key' }, saved).quotaKey, 'fixture-quota-key');
  const noSavedQuota = { ...saved, hasQuotaCredential: false };
  assert.equal(check({ quota }, noSavedQuota).quotaScopeChanged, false);
  assert.equal(Object.hasOwn(model.providerInput({ ...draft, quota }, noSavedQuota), 'quotaKey'), false);
});

test('unfinished or invalid addresses do not crash form hints or bypass normal URL validation', () => {
  for (const baseUrl of ['', 'https://', 'ssh://provider.invalid', 'https://provider.invalid/v1?arg=1']) {
    const state = check({ baseUrl });
    assert.equal(state.url, null);
    assert.equal(state.apiScopeChanged, false);
    assert.equal(state.quotaScopeChanged, false);
    assert.throws(() => model.providerInput({ ...draft, baseUrl }, saved), /服务地址/);
  }
  assert.equal(check({ quota: { adapter: 'deepseek', credentialOrigin: 'https://quota.invalid/v1' } }).crossOriginQuota, false);
});

const source = readFileSync(new URL('../src/components/ai-tools/AiProviderForm.jsx', import.meta.url), 'utf8')
  .replace(/^import .+;\r?\n/gm, '').replace('export default function AiProviderForm', 'function AiProviderForm');
const formCode = transformSync('AiProviderForm.jsx', source, { jsx: { runtime: 'classic', pragma: 'jsx', pragmaFrag: 'Fragment' } }).code;
const descendants = node => isValidElement(node) ? [node, ...[node.props.children].flat(Infinity).flatMap(descendants)] : [];
function formScenario(changes, provider = saved) {
  const render = runInNewContext(`${formCode}\nAiProviderForm`, {
    ...model, jsx: createElement, Fragment, tr: label => label, useLocale() {}, useId: () => 'provider-form',
    useState(initial) { return [typeof initial === 'function' ? { ...initial(), ...changes } : initial, () => {}]; },
    AiToolsDialog: ({ children }) => children, AiClaudeModelsEditor: () => null, AiCliConfigEditor: () => null,
    AiQuotaTemplateEditor: () => null, SelectMenu: () => null, providerModelReadBlockReason: () => '',
  });
  const tree = render({ provider, tools: [], theme: { button: {}, input: 'input' } });
  return { html: renderToStaticMarkup(tree), field: label => descendants(tree).find(node => node.props['aria-label'] === label)?.props };
}

test('provider form renders saved, moved, removed and deferred-quota guidance next to the affected fields', () => {
  const unchanged = formScenario({});
  assert.equal(unchanged.field('AI API 密钥').placeholder, '已保存密钥，留空保持不变');
  assert.equal(unchanged.field('AI 额度查询密钥').placeholder, '已保存，留空保持不变');
  const changed = formScenario({ baseUrl: 'https://other.invalid' });
  assert.equal(changed.field('AI API 密钥').placeholder, undefined);
  assert.equal(changed.field('AI API 密钥')['aria-required'], true);
  assert.equal(changed.field('AI 额度查询密钥')['aria-required'], true);
  assert.match(changed.html, /服务地址已变化，请填写新密钥/);
  assert.match(changed.html, /额度查询身份已变化，请填写新的额度密钥/);
  assert.match(changed.html, /<summary[^>]*>额度查询设置[^<]*<span[^>]*>需要处理/);
  assert.doesNotMatch(changed.html, /额度查询设置（可选）/);
  const clear = formScenario({ clearKey: true, clearQuotaKey: true, apiKey: 'fixture-not-submitted', quotaKey: 'fixture-not-submitted' });
  assert.equal(clear.field('AI API 密钥').disabled, true);
  assert.equal(clear.field('AI 额度查询密钥').disabled, true);
  assert.doesNotMatch(clear.html, /fixture-not-submitted|留空保持不变/);
  assert.match(clear.html, /保存后移除已保存的密钥/);
  const off = formScenario({ quota: null });
  assert.equal(off.field('AI 额度查询密钥'), undefined);
  assert.match(off.html, /额度查询已关闭：请移除原额度密钥/);
  assert.match(off.html, /同时移除已保存的额度查询密钥/);
  const cross = formScenario({ quota: { adapter: 'deepseek', credentialOrigin: 'https://quota.invalid' } }, { ...saved, hasQuotaCredential: false });
  assert.equal(cross.field('AI 额度查询密钥')['aria-required'], false);
  assert.match(cross.html, /可先保存，跨域查询前必须填写独立额度密钥/);
  const invalid = formScenario({ baseUrl: 'https://' });
  assert.equal(invalid.field('AI API 密钥').placeholder, undefined);
  assert.doesNotMatch(invalid.html, /留空保持不变|服务地址已变化/);
});
