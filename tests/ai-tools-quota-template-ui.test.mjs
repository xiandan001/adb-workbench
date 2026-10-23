import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseQuotaTemplate, stringifyQuotaTemplate } from '../src/components/ai-tools/aiQuotaTemplateModel.js';

const require = createRequire(import.meta.url);
const { normalizeQuotaConfig } = require('../electron/lib/ai-tools-quota.cjs');
const template = extra => ({ kind: 'balance', request: { path: '/v1/credits', method: 'GET' }, extract: { metrics: [{ label: '余额', unit: 'USD', remaining: 'data.balance' }] }, ...extra });

test('custom quota templates round-trip only declaration fields, not adapter/origin or credentials', () => {
  const original = { adapter: 'custom', credentialOrigin: 'https://quota.invalid', ...template() };
  const text = stringifyQuotaTemplate(original); const parsed = parseQuotaTemplate(text);
  assert.deepEqual(parsed, template()); assert.equal(text.includes('credentialOrigin'), false); assert.equal(text.includes('adapter'), false);
  assert.deepEqual(normalizeQuotaConfig({ adapter: 'custom', ...parsed }), { adapter: 'custom', ...template() });
  const example = parseQuotaTemplate(stringifyQuotaTemplate()); assert.match(example.request.path, /replace/); assert.match(example.extract.metrics[0].remaining, /replace/);
});

test('valid request/extraction fixtures are accepted identically by frontend and main normalizer', () => {
  const fixtures = [template(), template({ kind: 'plan', request: { path: '/quota?period=week', method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8', 'New-Api-User': '123', 'X-Organization-Id': 'org_id', 'X-Project-Id': 'project-1' }, body: { range: ['week'], enabled: true, limit: 20 } }, extract: { metrics: [{ label: 'Week', unit: 'requests', used: '$.data.windows[0].used', total: 'data.windows[0].total', resetAt: 'data.reset' }] } }), template({ kind: undefined })];
  for (const fixture of fixtures) {
    const value = JSON.parse(JSON.stringify(fixture)); const parsed = parseQuotaTemplate(JSON.stringify(value));
    assert.deepEqual(parsed, value); assert.deepEqual(normalizeQuotaConfig({ adapter: 'custom', ...parsed }), { adapter: 'custom', ...value });
  }
});

test('credential-bearing metadata, code, forbidden extraction and GET bodies are rejected by both layers', () => {
  const invalid = [
    template({ request: { path: '/quota?api_key=fixture-secret', method: 'GET' } }), template({ request: { path: '/quota?%74oken=fixture-secret', method: 'GET' } }),
    template({ request: { path: '//other.invalid/quota', method: 'GET' } }), template({ request: { path: '/quota', method: 'DELETE' } }),
    template({ request: { path: '/quota', method: 'GET', headers: { Authorization: 'Bearer fixture-secret' } } }),
    template({ request: { path: '/quota', method: 'GET', headers: { Accept: 'fixture-secret' } } }),
    template({ request: { path: '/quota', method: 'GET', body: {} } }), template({ request: { path: '/quota', method: 'POST', body: { nested: { password: 'fixture-secret' } } } }),
    template({ extract: { metrics: [{ label: 'x', unit: 'USD', remaining: 'data.constructor.key' }] } }), template({ extract: { metrics: [{ label: 'x', unit: 'USD', remaining: 'data.amount * 2' }] } }),
    template({ extract: { metrics: [] } }), template({ script: 'return 123' }), template({ kind: 'unknown' }),
  ];
  for (const value of invalid) {
    assert.throws(() => parseQuotaTemplate(JSON.stringify(value))); assert.throws(() => normalizeQuotaConfig({ adapter: 'custom', ...value }));
  }
  for (const value of [template({ adapter: 'custom' }), template({ credentialOrigin: 'https://quota.invalid' })]) assert.throws(() => parseQuotaTemplate(JSON.stringify(value)), /外层|字段/);
});

test('JSON parser rejects executable text, duplicate/prototype keys, malformed Unicode and bounded-shape attacks', () => {
  let executed = false; globalThis.quotaTemplateExecutionProbe = () => { executed = true; };
  try {
    for (const value of ['quotaTemplateExecutionProbe()', '{"request":{},"request":{}}', '{"__proto__":{"polluted":true}}', '[]', 'null', '{bad json}', JSON.stringify(template({ request: { path: '/quota', method: 'POST', body: { text: '\ud800' } } })), JSON.stringify(template({ request: { path: '/quota', method: 'POST', body: { '__CHANNEL__:1': 'ignored' } } }))]) {
      assert.throws(() => parseQuotaTemplate(value));
    }
    assert.equal(executed, false); assert.equal({}.polluted, undefined);
  } finally { delete globalThis.quotaTemplateExecutionProbe; }
  let nested = {}; for (let index = 0; index < 25; index++) nested = { nested };
  for (const value of [template({ request: { path: '/quota', method: 'POST', body: nested } }), template({ request: { path: '/quota', method: 'POST', body: { items: Array(65).fill(1) } } }), template({ request: { path: '/quota', method: 'POST', body: { text: 'x'.repeat(16385) } } })]) assert.throws(() => parseQuotaTemplate(JSON.stringify(value)));
});

test('validation error text does not repeat pasted secrets', () => {
  const secret = 'PRIVATE-FIXTURE-NOT-FOR-LOGS';
  for (const text of [`{bad ${secret}`, JSON.stringify(template({ request: { path: `/quota?token=${secret}`, method: 'GET' } }))]) {
    assert.throws(() => parseQuotaTemplate(text), error => { assert.equal(error.message.includes(secret), false); return true; });
  }
});
