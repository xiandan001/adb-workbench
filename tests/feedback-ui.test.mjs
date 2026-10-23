import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeedbackState, feedbackInput, createFeedbackReportSession, publicFeedbackAuth, pollFeedbackAuthorization, feedbackEnvironmentRows, canSubmitFeedback, feedbackResponse } from '../src/shared/feedbackUi.js';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const input = { title: '  Fixture issue  ', category: 'serial', description: 'What happened', steps: 'First step', expected: 'Expected result', includeEnvironment: true, includeLogs: false };
const preview = (token = 'preview-one') => ({ token, reportId: 'report-one', title: 'Fixture issue', body: '<script>not HTML</script>\nExact redacted body', environment: {}, log: { included: false, bytes: 0, lines: 0, truncated: false }, expiresAt: 10000 });
const auth = changes => ({ configured: true, authenticated: false, persistent: true, pending: true, login: null, userCode: 'ABCD-EFGH', expiresAt: 10000, ...changes });
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
test('feedback icons exist in the installed icon library', async () => {
  const source = readFileSync(new URL('../src/components/FeedbackSection.jsx', import.meta.url), 'utf8');
  const names = source.match(/import \{([^}]+)\} from 'lucide-react'/)[1].split(',').map(name => name.trim());
  const icons = await import('lucide-react');
  for (const name of names) assert.ok(icons[name], `Missing installed icon: ${name}`);
});
function session(api, onChange = () => {}, now = () => 100) {
  return createFeedbackReportSession({ api, onChange, now, initialState: { ...createFeedbackState('serial'), draft: { ...input } } });
}

test('each new report uses explicit categories, includes environment but never remembers log opt-in', () => {
  const a = createFeedbackState('serial'); a.draft.includeLogs = true;
  const b = createFeedbackState('serial'); assert.equal(b.draft.includeLogs, false); assert.equal(b.draft.includeEnvironment, true);
  assert.equal(b.draft.category, 'serial'); assert.equal(createFeedbackState('settings').draft.category, 'general');
  assert.equal(feedbackInput(input).title, 'Fixture issue');
  for (const bad of [{ ...input, title: '' }, { ...input, title: 'x'.repeat(121) }, { ...input, description: ' ' }, { ...input, description: 'x'.repeat(4001) }, { ...input, steps: 'x'.repeat(4001) }, { ...input, expected: 'x'.repeat(2001) }, { ...input, category: 'private' }, { ...input, includeLogs: 'yes' }]) assert.throws(() => feedbackInput(bad));
});

test('preview sends only bounded explicit form values, preserves exact escaped text and does not submit automatically', async () => {
  const calls = [];
  const s = session({ feedbackPreview: async value => { calls.push(value); return { ok: true, preview: preview() }; } });
  await s.preview(); assert.deepEqual(calls, [{ ...input, title: 'Fixture issue' }]);
  assert.equal(s.snapshot().view, 'preview'); assert.equal(s.snapshot().preview.body, preview().body); assert.equal(s.snapshot().draft.title, input.title);
  s.change('description', 'Edited'); assert.equal(s.snapshot().preview, null); assert.equal(s.snapshot().view, 'edit');
});

test('editing or closing rejects an old preview response without erasing the current form', async () => {
  const pending = deferred(); const changes = [];
  const s = session({ feedbackPreview: () => pending.promise }, value => changes.push(value));
  const work = s.preview(); s.change('includeLogs', true); pending.resolve({ ok: true, preview: preview() }); await work;
  assert.equal(s.snapshot().preview, null); assert.equal(s.snapshot().draft.includeLogs, true); assert.equal(s.snapshot().busy, '');
  const next = deferred(); const closed = session({ feedbackPreview: () => next.promise }, value => changes.push(value));
  const old = closed.preview(); closed.deactivate(); const count = changes.length; next.resolve({ ok: true, preview: preview() }); await old;
  assert.equal(changes.length, count);
});

test('preview errors retain input and invalid/mismatched log metadata cannot be submitted', async () => {
  const s = session({ feedbackPreview: async () => ({ ok: false, error: { code: 'INVALID', message: '请检查报告' } }) });
  await s.preview(); assert.equal(s.snapshot().error, '请检查报告'); assert.equal(s.snapshot().draft.description, input.description);
  const invalid = session({ feedbackPreview: async () => ({ ok: true, preview: { ...preview(), log: { included: true, bytes: 1, lines: 1, truncated: false } } }) });
  await invalid.preview(); assert.equal(invalid.snapshot().preview, null); assert.match(invalid.snapshot().error, /日志/);
});

test('submit is single-flight, binds the frozen token and consent, and blocks form edits during submission', async () => {
  const pending = deferred(); const calls = []; const s = session({ feedbackPreview: async () => ({ ok: true, preview: preview() }), feedbackSubmit: value => { calls.push(value); return pending.promise; } });
  await s.preview(); const work = s.submit(); await s.submit(); assert.equal(s.change('title', 'changed'), false);
  assert.deepEqual(calls, [{ token: 'preview-one', includeLogs: false, includeEnvironment: true }]);
  pending.resolve({ ok: true, issue: { number: 23, url: 'https://github.com/xiandan001/adb-workbench/issues/23' } }); await work;
  assert.equal(s.snapshot().view, 'success'); assert.equal(s.snapshot().issue.number, 23); assert.equal(s.snapshot().draft.title, input.title);
});

test('uncertain submit retries only the same token and never silently generates another preview, even after expiry', async () => {
  let clock = 100; let previews = 0; const calls = []; const s = session({ feedbackPreview: async () => { previews++; return { ok: true, preview: preview() }; }, feedbackSubmit: async value => {
    calls.push(value); return calls.length === 1 ? { ok: false, uncertain: true, error: { code: 'UNCERTAIN', message: '结果待确认' } } : { ok: true, reused: true, issue: { number: 24, url: 'https://github.com/xiandan001/adb-workbench/issues/24' } };
  } }, () => {}, () => clock);
  await s.preview(); await s.submit(); assert.equal(s.snapshot().uncertain, true); assert.equal(s.back(), false); assert.equal(s.change('includeLogs', true), false);
  await s.preview(); clock = 20000; await s.submit(); assert.equal(previews, 1); assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]); assert.equal(s.snapshot().view, 'success');
});

test('transport exceptions during submit are uncertain rather than permission to create a new report', async () => {
  const s = session({ feedbackPreview: async () => ({ ok: true, preview: preview() }), feedbackSubmit: async () => { throw new Error('transport dropped'); } });
  await s.preview(); await s.submit(); assert.equal(s.snapshot().uncertain, true); assert.equal(s.snapshot().preview.token, 'preview-one'); assert.match(s.snapshot().error, /确认|检查/);
});

test('a missing or malformed submission reply is uncertain rather than a safe-to-repeat rejection', async () => {
  for (const response of [undefined, null, {}, { ok: 'yes', issue: { number: 1, url: 'https://github.com/xiandan001/adb-workbench/issues/1' } }]) {
    const s = session({ feedbackPreview: async () => ({ ok: true, preview: preview() }), feedbackSubmit: async () => response });
    await s.preview(); await s.submit(); assert.equal(s.snapshot().uncertain, true); assert.equal(s.snapshot().preview.token, 'preview-one'); assert.notEqual(s.snapshot().view, 'success');
  }
});

test('expired unsent preview is not posted and invalid success URLs cannot become clickable success', async () => {
  let clock = 100; let calls = 0; const s = session({ feedbackPreview: async () => ({ ok: true, preview: preview() }), feedbackSubmit: async () => { calls++; return { ok: true, issue: { number: 1, url: 'https://untrusted.invalid/1' } }; } }, () => {}, () => clock);
  await s.preview(); clock = 20000; await s.submit(); assert.equal(calls, 0); assert.match(s.snapshot().error, /过期/);
  clock = 100; await s.submit(); assert.equal(calls, 1); assert.notEqual(s.snapshot().view, 'success'); assert.equal(s.snapshot().uncertain, true);
});

test('public auth projection never carries device/access/refresh tokens and validates required state', () => {
  const state = publicFeedbackAuth({ ...auth({}), access_token: 'never expose', device_code: 'never expose', refresh_token: 'never expose' });
  assert.equal(state.userCode, 'ABCD-EFGH'); assert.ok(!JSON.stringify(state).includes('never expose'));
  assert.equal(publicFeedbackAuth(auth({ pending: false })).userCode, '');
  assert.throws(() => publicFeedbackAuth({ configured: true }), /授权状态/);
});

test('choosing a new GitHub account blocks submission even while the old credentials remain authenticated', () => {
  assert.equal(canSubmitFeedback(auth({ authenticated: true, pending: false })), true);
  assert.equal(canSubmitFeedback(auth({ authenticated: true, pending: true })), false);
  for (const busy of ['start', 'cancel', 'logout']) assert.equal(canSubmitFeedback(auth({ authenticated: true, pending: false }), busy), false);
  assert.equal(canSubmitFeedback(auth({ configured: false, authenticated: true, pending: false })), false);
});

test('authorization polling is local-status-only, serial, stops after completion and ignores late replies after close', async () => {
  let timer; let reads = 0; const pending = deferred(); const seen = [];
  const clock = { setTimeout: (fn, ms) => { assert.equal(ms, 1500); timer = fn; return 1; }, clearTimeout: () => { timer = null; } };
  const stop = pollFeedbackAuthorization({ read: () => { reads++; return pending.promise; }, onAuth: value => seen.push(value), onError: () => {}, clock });
  const tick = timer; timer = null; tick(); await flush(); assert.equal(reads, 1); assert.equal(timer, null);
  stop(); pending.resolve({ ok: true, auth: auth({ authenticated: true, pending: false, login: 'fixture' }) }); await flush(); assert.equal(seen.length, 0); assert.equal(timer, null);
  pollFeedbackAuthorization({ read: async () => ({ ok: true, auth: auth({ pending: false }) }), onAuth: value => seen.push(value), onError: () => {}, clock });
  const finalTick = timer; timer = null; finalTick(); await flush(); assert.equal(seen.length, 1); assert.equal(timer, null);
});

test('environment summary shows only the declared safe metadata and treats missing values as unavailable', () => {
  const rows = feedbackEnvironmentRows({ app: { name: '卓控台', version: '4.7.0' }, os: { name: 'Windows', architecture: 'x64' }, computer: { manufacturer: null, model: null, cpu: null, logicalCores: null, memoryBytes: null }, displays: [], hostname: 'DO_NOT_RENDER_HOST' });
  const rendered = JSON.stringify(rows); assert.match(rendered, /4.7.0/); assert.match(rendered, /不可用/); assert.ok(!rendered.includes('DO_NOT_RENDER_HOST'));
});

const component = readFileSync(new URL('../src/components/FeedbackSection.jsx', import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
function componentHandler(name, bindings) {
  let found;
  require('@babel/traverse').default(require('@babel/parser').parse(component, { sourceType: 'module', plugins: ['jsx'] }), {
    VariableDeclarator({ node }) { if (node.id.name === name) found = node.init.type === 'CallExpression' ? node.init.arguments[0] : node.init; },
  });
  assert.ok(found, `handler ${name} exists`); return runInNewContext('(' + component.slice(found.start, found.end) + ')', bindings);
}

test('real dialog close handler blocks a pending submit and cancels only pending device authorization, not an existing login', () => {
  let calls = 0; const refs = { closeCancelled: { current: false }, authRef: { current: auth({ authenticated: true, pending: false }) }, authAction: { current: '' } };
  const cancelPendingAuth = componentHandler('cancelPendingAuth', { ...refs, api: { feedbackAuthCancel: async () => { calls++; } }, Promise });
  cancelPendingAuth(); assert.equal(calls, 0);
  refs.authRef.current = auth({}); cancelPendingAuth(); cancelPendingAuth(); assert.equal(calls, 1);
  let busy = 'submit'; let closed = 0; let deactivated = 0;
  const bindings = { session: { snapshot: () => ({ busy }), deactivate: () => { deactivated++; } }, alive: { current: true }, contextTicket: { current: 0 }, authTicket: { current: 0 }, cancelPendingAuth: () => {}, onClose: () => { closed++; } };
  const close = componentHandler('close', bindings); close(); assert.equal(closed, 0); assert.equal(deactivated, 0);
  busy = ''; close(); assert.equal(closed, 1); assert.equal(deactivated, 1); assert.equal(bindings.alive.current, false);
});

test('real auth action supports explicit reauthorization but ignores a response after the modal was closed', async () => {
  const pending = deferred(); let accepted = 0; let starts = 0;
  const bindings = { api: { feedbackAuthStart: () => { starts++; return pending.promise; } }, session: { snapshot: () => ({ busy: '' }) }, authAction: { current: '' }, authTicket: { current: 0 }, closeCancelled: { current: false }, alive: { current: true },
    setAuthBusy() {}, setAuthError() {}, setCopied() {}, acceptAuth: () => { accepted++; }, feedbackResponse };
  const action = componentHandler('authorization', bindings); const running = action('start'); assert.equal(starts, 1); await action('start'); assert.equal(starts, 1);
  bindings.alive.current = false; pending.resolve({ ok: true, auth: auth({}) }); await running; assert.equal(accepted, 0);
  assert.match(component, /重新授权 GitHub/); assert.match(component, /canSubmitFeedback\(auth, authBusy\)/);
});

test('dialog contract renders exact preview as text and has no file picker, persistent draft or raw credential UI', () => {
  assert.match(component, /<pre[^>]*aria-label="反馈报告预览"[\s\S]*?\{report\.preview\.body\}/);
  assert.match(component, /onKeyDown=\{trapAppMessageFocus\}/);
  assert.match(component, /aria-label="关闭反馈问题" disabled=\{submitting\}/);
  assert.doesNotMatch(component, /dangerouslySetInnerHTML|type="file"|localStorage|sessionStorage|console\./);
});
