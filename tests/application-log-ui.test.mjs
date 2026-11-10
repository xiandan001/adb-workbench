import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { createMessageTranslator } from '../src/shared/messageCatalog.js';
import { createApplicationLogUi, normalizeApplicationLogState } from '../src/shared/applicationLogUi.js';

const capture = extra => ({ recording: false, available: false, startedAt: null, stoppedAt: null,
  bytes: 0, records: 0, dropped: 0, reason: 'idle', error: '', ...extra });
const reply = extra => ({ success: true, state: capture(extra) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture(api) {
  const timers = new Map(), changes = []; let id = 0;
  const model = createApplicationLogUi({ api, onChange: value => changes.push(value), clock: {
    setTimeout: (callback, delay) => { assert.equal(delay, 2000); timers.set(++id, callback); return id; },
    clearTimeout: timer => timers.delete(timer)
  } });
  return { model, timers, changes, async activate() { model.activate(); await flush(); } };
}

test('state projection accepts only declared safe fields and rejects malformed counters or status', () => {
  const state = normalizeApplicationLogState(capture({ path: 'private-path', deviceId: 'private-device', token: 'private-token' }));
  assert.equal(JSON.stringify(state).includes('private'), false);
  for (const changed of [{ bytes: -1 }, { records: 1.5 }, { reason: 'unknown' }, { recording: 1 }, { startedAt: 'private-path' }]) {
    assert.throws(() => normalizeApplicationLogState(capture(changed)));
  }
});
test('start is single-flight and all application-log calls have zero arguments', async () => {
  const pending = deferred(), calls = [];
  const h = fixture({ appLogStatus: async (...args) => { calls.push(['status', args]); return reply(); },
    appLogStart: (...args) => { calls.push(['start', args]); return pending.promise; } });
  await h.activate(); const first = h.model.start(); await h.model.start();
  assert.equal(h.model.snapshot().busy, 'start'); assert.equal(calls.filter(row => row[0] === 'start').length, 1);
  pending.resolve(reply({ recording: true, startedAt: 1000 })); await first;
  assert.equal(h.model.snapshot().capture.recording, true); assert.equal(h.timers.size, 1);
  assert.ok(calls.every(row => row[1].length === 0)); h.model.deactivate();
});
test('stop is completed before export; cancelled export retains capture for a path-free retry', async () => {
  const stop = deferred(), calls = [];
  const h = fixture({ appLogStatus: async () => reply({ recording: true, available: true, startedAt: 1000 }),
    appLogStop: () => { calls.push('stop'); return stop.promise; },
    appLogExport: async () => { calls.push('export'); return { ...reply({ available: true, reason: 'manual' }), cancelled: calls.length === 2, path: 'private-export-path' }; } });
  await h.activate(); const operation = h.model.stopAndExport(); await h.model.stopAndExport();
  assert.deepEqual(calls, ['stop']);
  stop.resolve(reply({ available: true, reason: 'manual' })); await operation;
  assert.deepEqual(calls, ['stop', 'export']); assert.equal(h.model.snapshot().notice, 'cancelled');
  await h.model.export(); assert.equal(h.model.snapshot().notice, 'exported');
  assert.equal(JSON.stringify(h.model.snapshot()).includes('private'), false); h.model.deactivate();
});
test('stop failure never exports and a failed export retains the stopped state and retry action', async () => {
  let exports = 0, failStop = true;
  const h = fixture({ appLogStatus: async () => reply({ recording: true, available: true }),
    appLogStop: async () => failStop ? { success: false, state: capture({ recording: true, available: true }), error: '停止失败' } : reply({ available: true, reason: 'manual' }),
    appLogExport: async () => { exports++; return { success: false, state: capture({ available: true, reason: 'manual' }), error: '导出失败' }; } });
  await h.activate(); await h.model.stopAndExport(); assert.equal(exports, 0); assert.equal(h.model.snapshot().capture.recording, true);
  failStop = false; await h.model.stopAndExport(); assert.equal(exports, 1); assert.equal(h.model.snapshot().capture.recording, false);
  assert.equal(h.model.snapshot().capture.available, true); assert.equal(h.model.snapshot().error, '导出失败'); h.model.deactivate();
});
test('polling is serialized and a stale status reply cannot undo an explicit start', async () => {
  const old = deferred(); let reads = 0;
  const h = fixture({ appLogStatus: () => ++reads === 1 ? Promise.resolve(reply()) : old.promise,
    appLogStart: async () => reply({ recording: true, startedAt: 1000 }) });
  await h.activate(); const stale = h.model.refresh(); await h.model.refresh(); assert.equal(reads, 2);
  await h.model.start(); old.resolve(reply()); await stale;
  assert.equal(h.model.snapshot().capture.recording, true); assert.equal(h.timers.size, 1); h.model.deactivate();
});
test('unmount does not stop capture or open a late export dialog and remount reads the shared backend state', async () => {
  const stop = deferred(), calls = [];
  const api = { appLogStatus: async () => { calls.push('status'); return reply({ recording: true, available: true }); },
    appLogStop: () => { calls.push('stop'); return stop.promise; }, appLogExport: async () => { calls.push('export'); return reply({ available: true }); } };
  const h = fixture(api); await h.activate(); h.model.deactivate(); assert.deepEqual(calls, ['status']); assert.equal(h.timers.size, 0);
  await h.activate(); const pending = h.model.stopAndExport(); h.model.deactivate(); const changed = h.changes.length;
  stop.resolve(reply({ available: true, reason: 'manual' })); await pending;
  assert.equal(h.changes.length, changed); assert.ok(!calls.includes('export'));
  const restored = fixture({ appLogStatus: async () => reply({ available: true, reason: 'interrupted' }) }); await restored.activate();
  assert.equal(restored.model.snapshot().capture.reason, 'interrupted'); restored.model.deactivate();
});
test('transport exceptions never expose host error paths, and limit state is retained after polling', async () => {
  let reads = 0;
  const h = fixture({ appLogStatus: async () => ++reads === 1 ? reply({ recording: true }) : reply({ available: true, reason: 'size-limit', dropped: 3 }),
    appLogStop: async () => { throw Error('PRIVATE_TOKEN C:/Users/private'); } });
  await h.activate(); await h.model.stopAndExport(); assert.equal(JSON.stringify(h.model.snapshot()).includes('PRIVATE'), false);
  const tick = [...h.timers.values()][0]; h.timers.clear(); tick(); await flush();
  assert.equal(h.model.snapshot().capture.reason, 'size-limit'); assert.equal(h.model.snapshot().capture.dropped, 3); assert.equal(h.timers.size, 0); h.model.deactivate();
});
test('malformed successful results cannot become export success and sanitized disk errors remain visible', async () => {
  const h = fixture({ appLogStatus: async () => reply({ available: true, reason: 'manual' }), appLogExport: async () => ({ success: true }) });
  await h.activate(); await h.model.export(); assert.equal(h.model.snapshot().notice, ''); assert.match(h.model.snapshot().error, /格式/); h.model.deactivate();
  const disk = fixture({ appLogStatus: async () => reply(), appLogStart: async () => ({ success: false,
    state: capture({ reason: 'io-error', error: '应用日志写入失败，请检查磁盘空间和目录权限。' }) }) });
  await disk.activate(); await disk.model.start(); assert.match(disk.model.snapshot().error, /磁盘空间/); disk.model.deactivate();
});
test('a confirmed action clears an earlier polling error even when stopping ends further polling', async () => {
  let reads = 0;
  const h = fixture({ appLogStatus: async () => {
    if (++reads > 1) throw Error('temporary status transport failure');
    return reply({ recording: true, available: true });
  }, appLogStop: async () => reply({ available: true, reason: 'manual' }), appLogExport: async () => reply({ available: true, reason: 'manual' }) });
  await h.activate(); await h.model.refresh(); assert.ok(h.model.snapshot().readError);
  await h.model.stopAndExport(); assert.equal(h.model.snapshot().readError, ''); assert.equal(h.model.snapshot().notice, 'exported');
  assert.equal(h.timers.size, 0); h.model.deactivate();
});
test('card lives beside FeedbackSection in global preferences without any device prop or raw path output', () => {
  const app = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const component = fs.readFileSync(new URL('../src/components/ApplicationLogSection.jsx', import.meta.url), 'utf8');
  assert.match(app, /<FeedbackSection[^\n]+\n\s*<ApplicationLogSection theme=\{t\} \/>/);
  assert.doesNotMatch(component, /activeDevice|deviceId|dangerouslySetInnerHTML|result\.path/);
  assert.match(component, /useLocale\(\)/); assert.match(component, /role="alert"/); assert.match(component, /停止并导出/);
  assert.ok(component.includes('已达到 20 MiB 上限，记录已停止。'));
  assert.ok(component.includes('最多记录 15 分钟或 20 MiB；切换页面不会停止记录。'));
  assert.doesNotMatch(component, /\b4 MiB\b/);
});
test('real status renderer translates every stop reason in all languages without persisting translated state', () => {
  const source = fs.readFileSync(new URL('../src/components/ApplicationLogSection.jsx', import.meta.url), 'utf8');
  const require = createRequire(import.meta.url);
  const parsed = require('@babel/parser').parse(source, { sourceType: 'module', plugins: ['jsx'] });
  const fn = parsed.program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'captureStatus');
  const catalogs = Object.fromEntries([['en', 'en-US'], ['tw', 'zh-TW'], ['ja', 'ja-JP'], ['ko', 'ko-KR']].map(([prefix, locale]) => [locale,
    ['backend', 'tools', 'workspace', 'core'].flatMap(domain => Object.entries(JSON.parse(fs.readFileSync(new URL(`../electron/locales/${prefix}-${domain}.json`, import.meta.url), 'utf8'))))]));
  const translate = createMessageTranslator(catalogs);
  let locale = 'zh-CN';
  const render = runInNewContext('(' + source.slice(fn.start, fn.end) + ')', { tr: text => translate(text, {}, locale) });
  const cases = [null, capture(), capture({ recording: true }), ...['manual', 'time-limit', 'size-limit', 'interrupted', 'io-error'].map(reason => capture({ available: true, reason }))];
  for (const state of cases) {
    locale = 'zh-CN'; const original = render(state, false);
    for (const target of Object.keys(catalogs)) { locale = target; assert.ok(render(state, false)); assert.notEqual(render(state, false), original, target + ': ' + original); }
  }
  assert.equal(render(null, false), translate('状态未知', {}, locale));
});
test('real CTA classes prioritize export for a stopped capture and preserve idle/recording primary actions', () => {
  const source = fs.readFileSync(new URL('../src/components/ApplicationLogSection.jsx', import.meta.url), 'utf8');
  const require = createRequire(import.meta.url), classes = {};
  const parsed = require('@babel/parser').parse(source, { sourceType: 'module', plugins: ['jsx'] });
  require('@babel/traverse').default(parsed, { JSXOpeningElement({ node }) {
    if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'button') return;
    const click = node.attributes.find(item => item.name?.name === 'onClick')?.value?.expression;
    const name = click && source.slice(click.start, click.end).match(/model\.(start|stopAndExport|export)\(/)?.[1];
    const expression = node.attributes.find(item => item.name?.name === 'className')?.value?.expression;
    if (name && expression) classes[name] = source.slice(expression.start, expression.end);
  } });
  const render = (action, state) => runInNewContext(classes[action], { state, button: 'BUTTON', theme: { button: { primary: 'PRIMARY', secondary: 'SECONDARY' } } });
  assert.equal(render('start', capture()), 'BUTTON PRIMARY');
  assert.equal(render('stopAndExport', capture({ recording: true, available: true })), 'BUTTON PRIMARY');
  assert.equal(render('start', capture({ available: true, reason: 'manual' })), 'BUTTON SECONDARY');
  assert.equal(render('export', capture({ available: true, reason: 'manual' })), 'BUTTON PRIMARY');
  assert.match(source, /className=\{`mt-3 rounded-xl border p-4/);
});
