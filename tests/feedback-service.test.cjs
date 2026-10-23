const test = require('node:test'); const assert = require('node:assert/strict');
const { createFeedbackService } = require('../electron/lib/feedback-service.cjs');
const form = changes => ({ title: '标题', category: 'startup', description: '启动时的问题', steps: '', expected: '', includeEnvironment: true, includeLogs: false, ...changes });
function harness() {
  const calls = { logs: 0, posts: [], finds: 0, opened: [] }; let next = 0; let clock = Date.now();
  const github = { createIssue: async args => { calls.posts.push(args); return { number: 7, url: 'https://github.com/xiandan001/adb-workbench/issues/7' }; }, findIssue: async () => { calls.finds++; return null; } };
  const auth = { status: async () => ({ configured: true, authenticated: true, login: 'author' }),
    getAccessSession: async () => ({ accessToken: 'secret-token', login: 'author', epoch: 1 }), isSessionCurrent: () => true, logout: async () => {} };
  const service = createFeedbackService({ now: () => clock, uuid: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`,
    diagnostics: { collect: async () => ({ app: { version: '4.7.0' }, computer: { model: 'Model' } }) },
    logger: { snapshot: async () => { calls.logs++; return { text: 'safe app event\n', bytes: 15, lines: 1, truncated: false }; } },
    auth,
    github, openExternal: async url => calls.opened.push(url) });
  return { service, github, auth, calls, advance: ms => { clock += ms; } };
}
test('log opt-out never snapshots application logs; preview and submit use exact frozen content', async () => {
  const h = harness(); const p = (await h.service.preview(form(), () => true)).preview;
  assert.equal(h.calls.logs, 0); assert.equal(p.log.included, false);
  const result = await h.service.submit({ token: p.token, includeLogs: false, includeEnvironment: true }, () => true);
  assert.equal(result.issue.number, 7); assert.equal(h.calls.posts[0].body, p.body); assert.equal(h.calls.logs, 0);
});
test('explicit log selection takes one bounded snapshot and consent changes require a new preview', async () => {
  const h = harness(); const p = (await h.service.preview(form({ includeLogs: true }), () => true)).preview;
  assert.equal(h.calls.logs, 1); assert.ok(p.body.includes('safe app event'));
  await assert.rejects(h.service.submit({ token: p.token, includeLogs: false, includeEnvironment: true }, () => true), /选择已变化/);
  assert.equal(h.calls.posts.length, 0);
  await h.service.submit({ token: p.token, includeLogs: true, includeEnvironment: true }, () => true); assert.equal(h.calls.logs, 1);
});
test('repeated and concurrent submits share one network write and reuse its receipt', async () => {
  const h = harness(); let complete; let writes = 0;
  h.github.createIssue = () => { writes++; return new Promise(resolve => { complete = resolve; }); };
  const p = (await h.service.preview(form(), () => true)).preview; const input = { token: p.token, includeLogs: false, includeEnvironment: true };
  const a = h.service.submit(input, () => true); const b = h.service.submit(input, () => true);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(writes, 1);
  complete({ number: 8, url: 'https://github.com/xiandan001/adb-workbench/issues/8' }); await Promise.all([a, b]);
  assert.equal((await h.service.submit(input, () => true)).reused, true); assert.equal(writes, 1);
});
test('ambiguous result retries only query, never repeat the POST', async () => {
  const h = harness(); let writes = 0;
  h.github.createIssue = async () => { writes++; throw Object.assign(Error('unconfirmed'), { uncertain: true }); };
  const p = (await h.service.preview(form(), () => true)).preview; const input = { token: p.token, includeLogs: false, includeEnvironment: true };
  await assert.rejects(h.service.submit(input, () => true));
  await assert.rejects(h.service.submit(input, () => true), error => error.uncertain === true);
  assert.equal(writes, 1); assert.equal(h.calls.finds, 1);
  h.github.findIssue = async () => ({ number: 9, url: 'https://github.com/xiandan001/adb-workbench/issues/9' });
  assert.equal((await h.service.submit(input, () => true)).issue.number, 9); assert.equal(writes, 1);
});
test('creating another preview cannot expire an unresolved submission receipt', async () => {
  const h = harness(); let posts = 0;
  h.github.createIssue = async () => { posts++; throw Object.assign(Error('unconfirmed'), { uncertain: true }); };
  const p = (await h.service.preview(form(), () => true)).preview; const input = { token: p.token, includeLogs: false, includeEnvironment: true };
  await assert.rejects(h.service.submit(input, () => true)); h.advance(16 * 60000);
  await h.service.preview(form({ title: '另一个问题' }), () => true);
  await assert.rejects(h.service.submit(input, () => true), error => error.uncertain === true);
  assert.equal(h.calls.finds, 1); assert.equal(posts, 1);
});
test('expired, disposed, foreign and oversized parameters cannot cause a submission', async () => {
  const h = harness(); const p = (await h.service.preview(form(), () => true)).preview;
  h.advance(16 * 60000); await assert.rejects(h.service.submit({ token: p.token, includeLogs: false, includeEnvironment: true }, () => true), /过期/);
  await assert.rejects(h.service.preview(form(), () => false), /取消/);
  h.service.dispose(); await assert.rejects(h.service.context(() => true), /取消/); assert.equal(h.calls.posts.length, 0);
});
test('changing the main owner during collection cannot create a preview or read logs', async () => {
  const h = harness(); let calls = 0;
  await assert.rejects(h.service.preview(form({ includeLogs: true }), () => ++calls < 3), /取消/); assert.equal(h.calls.logs, 0);
});
test('changed credential generation cannot combine another account login with an old access token', async () => {
  const h = harness(); const p = (await h.service.preview(form(), () => true)).preview;
  h.auth.isSessionCurrent = () => false;
  await assert.rejects(h.service.submit({ token: p.token, includeLogs: false, includeEnvironment: true }, () => true), error => error.code === 'FEEDBACK_AUTH_CHANGED');
  assert.equal(h.calls.posts.length, 0);
});
test('a late authorization rejection never logs out a newer session', async () => {
  const h = harness(); let logouts = 0; h.auth.logout = async () => { logouts++; };
  h.github.createIssue = async () => { throw Object.assign(Error('reauthorize'), { code: 'FEEDBACK_AUTH_REQUIRED' }); };
  const p = (await h.service.preview(form(), () => true)).preview;
  await assert.rejects(h.service.submit({ token: p.token, includeLogs: false, includeEnvironment: true }, () => true)); assert.equal(logouts, 0);
});
test('issue opening is limited to the fixed repository and performs no issue writes', async () => {
  const h = harness(); await assert.rejects(h.service.openIssue({ url: 'https://evil.invalid' }, () => true));
  await h.service.openIssue({ url: 'https://github.com/xiandan001/adb-workbench/issues/7' }, () => true);
  assert.equal(h.calls.opened.length, 1); assert.equal(h.calls.posts.length, 0);
});
