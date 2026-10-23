import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { connectionCompletionNotice, connectionFeedback, providerFeedbackCurrent, providerFeedbackToken } from '../src/components/ai-tools/aiProviderHomeModel.js';

const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const provider = { id: 'fixture', name: 'Fixture', protocol: 'anthropic', baseUrl: 'https://fixture.invalid/anthropic', model: 'fixture-model', targetApps: ['claude'], hasCredential: true };
const source = fs.readFileSync(new URL('../src/components/ai-tools/AiToolsWorkspace.jsx', import.meta.url), 'utf8');
let networkNode;
traverse(parse(source, { sourceType: 'module', plugins: ['jsx'] }), { VariableDeclarator({ node }) { if (node.id.name === 'networkAction') networkNode = node.init; } });
function harness(request) {
  const notices = []; const state = { busy: {}, quotaBusy: {}, quota: {}, errors: {} };
  const update = key => next => { state[key] = next(state[key]); };
  const scope = { request, alive: { current: true }, pending: { current: new Set() }, feedbackEpoch: { current: 1 },
    snapshotRef: { current: { providers: [provider] } }, providerFeedbackToken, providerFeedbackCurrent, connectionFeedback, connectionCompletionNotice,
    setBusy: update('busy'), setQuotaBusy: update('quotaBusy'), setQuotaResults: update('quota'), setQuotaErrors: update('errors'), showToast: message => notices.push(message) };
  const action = runInNewContext('(' + source.slice(networkNode.start, networkNode.end) + ')', scope);
  return { notices, state, scope, action: (command = 'provider_probe') => action(provider, command) };
}
const verified = { reachable: true, status: 'verified', mode: 'inference', inferenceVerified: true, model: provider.model, hasTextResponse: true, latencyMs: 1554, outputTokens: 16 };

test('actual test handler keeps busy and context guards, then emits only a concise completion notice', async () => {
  let done; let calls = 0;
  const h = harness(() => { calls++; return new Promise(resolve => { done = resolve; }); });
  const pending = h.action(); assert.equal(h.state.busy.fixture, 'provider_probe'); assert.equal(h.notices.length, 0);
  await h.action(); assert.equal(calls, 1);
  h.scope.snapshotRef.current = { providers: [structuredClone(provider)] };
  done(verified); await pending;
  assert.equal(h.notices.length, 1); assert.match(h.notices[0], /成功/);
  assert.doesNotMatch(h.notices[0], /1554|tokens|fixture-model|完成于/);
  assert.equal(h.state.busy.fixture, undefined);
});

test('cancel, partial response, rejected request and invalid success envelope stay distinct', async () => {
  for (const [result, expected] of [[{ cancelled: true }, /取消/], [{ reachable: true, status: 'partial', modelsSupported: false }, /尚未验证/], [{ reachable: true, status: 'unrecognized' }, /失败/]]) {
    const h = harness(async () => result); await h.action();
    assert.equal(h.notices.length, 1); assert.match(h.notices[0], expected); assert.equal(h.state.busy.fixture, undefined);
  }
  const h = harness(async () => { throw new Error('Fixture rejected'); }); await h.action();
  assert.match(h.notices[0], /失败.*Fixture rejected/);
});

test('late test completions do not show a stale toast after configuration, permission or owner changes', async () => {
  for (const change of [
    h => { h.scope.feedbackEpoch.current++; },
    h => { h.scope.snapshotRef.current = { providers: [{ ...provider, model: 'changed' }] }; },
    h => { h.scope.snapshotRef.current = { providers: [] }; },
    h => { h.scope.alive.current = false; },
  ]) {
    let done; const h = harness(() => new Promise(resolve => { done = resolve; }));
    const pending = h.action(); change(h); done(verified); await pending;
    assert.equal(h.notices.length, 0); assert.equal(h.scope.pending.current.size, 0);
  }
});

test('quota queries remain independent and never produce test completion notices', async () => {
  const h = harness(async () => ({ providerId: provider.id, status: 'fresh', remaining: 12 }));
  await h.action('quota_query'); assert.equal(h.state.quota.fixture.remaining, 12); assert.equal(h.notices.length, 0);
  assert.deepEqual(h.state.busy, {}); assert.equal(h.state.quotaBusy.fixture, undefined);
});

test('provider cards have no persistent test output while the busy button and quota remain', () => {
  const home = fs.readFileSync(new URL('../src/components/ai-tools/AiProviderHome.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(home, /连接测试反馈|连接检查成功|connection\.message|connection\.completedAt|完成于/);
  assert.match(home, /测试中…/); assert.match(home, /AiCompactQuota/);
  assert.doesNotMatch(source, /feedbackRecords|completedAt|feedback=\{/);
  const refresh = source.slice(source.indexOf('const refresh ='), source.indexOf('useEffect(() => { alive.current'));
  assert.doesNotMatch(refresh, /invalidateFeedback\(/);
  assert.match(source, /membership\.activated !== state\.membership\.activated/);
});
