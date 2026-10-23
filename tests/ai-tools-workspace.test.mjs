import test from 'node:test';
import assert from 'node:assert/strict';
import { providerDraft, providerInput, quotaValue, quotaView, previewValue, aiToolsCan, sessionDetailFor, routeDraft, routeInput, moveRouteProvider } from '../src/components/ai-tools/aiToolsModel.js';

const saved = { id: 'p1', name: 'Saved', protocol: 'openai-chat', baseUrl: 'https://api.example.test/v1', model: 'model-a', targetApps: ['claude'], hasCredential: true, quota: { adapter: 'openrouter' } };
test('AI provider editing never reads an existing secret and an empty key field preserves it', () => {
  const draft = providerDraft(saved); assert.equal(draft.apiKey, '');
  const input = providerInput(draft, saved);
  assert.equal(Object.hasOwn(input, 'apiKey'), false); assert.equal(Object.hasOwn(input, 'hasCredential'), false);
  assert.deepEqual(input.targetApps, ['claude']); assert.deepEqual(input.quota, saved.quota);
  input.targetApps.push('codex'); assert.deepEqual(saved.targetApps, ['claude']);
  assert.equal(providerInput({ ...draft, clearKey: true }, saved).apiKey, null);
  assert.equal(providerInput({ ...draft, apiKey: 'new-user-key' }, saved).apiKey, 'new-user-key');
});
test('AI endpoint origin changes require an explicit new key instead of forwarding an old credential', () => {
  const changed = { ...providerDraft(saved), baseUrl: 'https://different.test/v1' };
  assert.throws(() => providerInput(changed, saved), /新密钥/);
  assert.equal(providerInput({ ...changed, apiKey: 'replacement' }, saved).baseUrl, changed.baseUrl);
  assert.doesNotThrow(() => providerInput({ ...providerDraft(saved), baseUrl: 'https://api.example.test/other' }, saved));
});
test('AI quota view distinguishes unavailable, stale, errors and real zero without inventing balances', () => {
  assert.equal(quotaValue(undefined), '—'); assert.equal(quotaValue(null), '—'); assert.equal(quotaValue(0), '0');
  assert.equal(quotaView(undefined, 'p1').status, 'unavailable');
  assert.deepEqual(quotaView({ providerId: 'other', status: 'fresh', metrics: [{ remaining: 9 }] }, 'p1').metrics, []);
  const stale = { providerId: 'p1', kind: 'plan', status: 'stale', observedAt: 10, metrics: [{ label: 'window', remaining: 0, unit: 'tokens' }] };
  assert.equal(quotaView(stale, 'p1').observedAt, 10); assert.equal(quotaView(stale, 'p1').status, 'stale');
  assert.deepEqual(quotaView({ ...stale, status: 'error' }, 'p1').metrics, []);
});
test('AI preview hides secret fields even if backend accidentally returned a raw value', () => {
  assert.equal(previewValue({ secret: true, before: 'private-old', after: 'private-new' }, 'after'), '******');
  assert.equal(previewValue({ secret: false, before: 'old' }, 'before'), 'old');
  assert.equal(previewValue({ secret: false, before: undefined }, 'before'), '（未设置）');
});
test('AI management requires current membership and an actual implemented capability', () => {
  assert.equal(aiToolsCan({ membership: { activated: false }, capabilities: ['provider_save'] }, 'provider_save'), false);
  assert.equal(aiToolsCan({ membership: { activated: true }, capabilities: [] }, 'provider_save'), false);
  assert.equal(aiToolsCan({ membership: { activated: true }, capabilities: ['provider_save'] }, 'provider_save'), true);
});
test('expired membership permits restoring owned backups, not new provider/config operations', () => {
  const snapshot = { membership: { activated: false }, capabilities: ['backups_list', 'backup_preview_restore', 'config_apply', 'provider_save', 'config_preview'] };
  assert.equal(aiToolsCan(snapshot, 'backups_list'), true);
  assert.equal(aiToolsCan(snapshot, 'backup_preview_restore'), true);
  assert.equal(aiToolsCan(snapshot, 'config_apply'), false);
  assert.equal(aiToolsCan(snapshot, 'config_apply', { restoring: true }), true);
  assert.equal(aiToolsCan(snapshot, 'provider_save', { restoring: true }), false);
  assert.equal(aiToolsCan(snapshot, 'config_preview'), false);
});
test('AI quota identity changes cannot reuse an old quota key and disabling sends explicit null', () => {
  const provider = { ...saved, hasQuotaCredential: true, quota: { adapter: 'openrouter', credentialOrigin: 'https://openrouter.ai' } };
  const changed = { ...providerDraft(provider), quota: { adapter: 'deepseek', credentialOrigin: 'https://api.deepseek.com' } };
  assert.throws(() => providerInput(changed, provider), /额度密钥/);
  assert.equal(providerInput({ ...changed, quotaKey: 'new-quota-key' }, provider).quotaKey, 'new-quota-key');
  const cleared = providerInput({ ...providerDraft(provider), quota: null, clearQuotaKey: true }, provider);
  assert.equal(cleared.quota, null); assert.equal(cleared.quotaKey, null);
  assert.equal(Object.hasOwn(cleared, 'hasQuotaCredential'), false);
});
test('AI context window is explicit, bounded, preserved for other tools and removable with null', () => {
  const original = { ...saved, contextWindow: 131072 };
  assert.equal(providerInput(providerDraft(original), original).contextWindow, 131072);
  assert.equal(providerInput({ ...providerDraft(original), contextWindow: '' }, original).contextWindow, null);
  assert.equal(Object.hasOwn(providerInput(providerDraft(saved), saved), 'contextWindow'), false);
  for (const value of ['0', '-1', '2.5', '2147483648', 'not-a-number']) assert.throws(() => providerInput({ ...providerDraft(saved), contextWindow: value }, saved), /上下文/);
  assert.equal(providerInput({ ...providerDraft(saved), contextWindow: '200000' }, saved).contextWindow, 200000);
});
test('AI session details accept only the currently selected opaque id and retain plain text', () => {
  const detail = { id: 'A', messages: [{ role: 'user', text: '<script>not executable</script>', timestamp: null }], offset: 0, messageCount: 1 };
  assert.equal(sessionDetailFor(detail, 'B'), null);
  assert.equal(sessionDetailFor(detail, 'A'), detail);
  assert.equal(sessionDetailFor({ ...detail, messages: null }, 'A'), null);
  assert.equal(sessionDetailFor(detail, 'A').messages[0].text, '<script>not executable</script>');
});
test('AI routes are same-protocol ordered references with explicit failover and no copied secrets', () => {
  const providers = [saved, { ...saved, id: 'p2' }, { ...saved, id: 'p3', protocol: 'anthropic' }, { ...saved, id: 'empty', hasCredential: false }];
  const draft = { ...routeDraft(), name: 'Route', providerIds: ['p1', 'p2'] };
  assert.equal(draft.failover, false);
  assert.deepEqual(routeInput(draft, providers), { name: 'Route', protocol: 'openai-chat', providerIds: ['p1', 'p2'], failover: false });
  assert.throws(() => routeInput({ ...draft, providerIds: ['p1', 'p3'] }, providers), /同协议/);
  assert.throws(() => routeInput({ ...draft, providerIds: ['empty'] }, providers), /密钥/);
  assert.throws(() => routeInput({ ...draft, providerIds: ['p1', 'p1'] }, providers), /1–6/);
  const moved = moveRouteProvider(draft.providerIds, 0, 1);
  assert.deepEqual(moved, ['p2', 'p1']); assert.deepEqual(draft.providerIds, ['p1', 'p2']);
  assert.equal(aiToolsCan({ membership: { activated: false }, capabilities: ['router_stop', 'router_start'] }, 'router_stop'), true);
  assert.equal(aiToolsCan({ membership: { activated: false }, capabilities: ['router_stop', 'router_start'] }, 'router_start'), false);
});
test('expired membership keeps Skills and interrupted import recovery without allowing new installations or imports', () => {
  const capabilities = ['skills_backups_list', 'skills_backup_preview_restore', 'skills_apply', 'skills_import', 'portable_recoveries_list', 'portable_recovery_preview', 'portable_recovery_apply', 'portable_preview', 'portable_apply'];
  const snapshot = { membership: { activated: false }, capabilities };
  for (const command of ['skills_backups_list', 'skills_backup_preview_restore', 'portable_recoveries_list', 'portable_recovery_preview', 'portable_recovery_apply']) assert.equal(aiToolsCan(snapshot, command), true, command);
  assert.equal(aiToolsCan(snapshot, 'skills_apply', { restoring: true }), true);
  for (const command of ['skills_apply', 'skills_import', 'portable_preview', 'portable_apply']) assert.equal(aiToolsCan(snapshot, command), false, command);
  assert.equal(aiToolsCan(snapshot, 'portable_apply', { restoring: true }), false);
});
test('custom quota save parses current JSON draft and never silently reuses an old template after invalid edits', () => {
  const original = { ...saved, quota: { adapter: 'custom', credentialOrigin: 'https://api.example.test', request: { path: '/balance', method: 'GET' }, extract: { metrics: [{ label: 'Balance', unit: 'USD', remaining: 'data.balance' }] } } };
  const draft = providerDraft(original);
  assert.equal(JSON.parse(draft.quotaTemplate).request.path, '/balance');
  assert.throws(() => providerInput({ ...draft, quotaTemplate: '{broken' }, original), /JSON/);
  const changed = JSON.parse(draft.quotaTemplate); changed.request.path = '/new-balance';
  const result = providerInput({ ...draft, quotaTemplate: JSON.stringify(changed) }, original);
  assert.equal(result.quota.request.path, '/new-balance'); assert.equal(result.quota.credentialOrigin, 'https://api.example.test');
  assert.equal(Object.hasOwn(result, 'quotaTemplate'), false);
});
