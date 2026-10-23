const test = require('node:test'); const assert = require('node:assert/strict');
const { createFeedbackGithub, githubRequest, requestAllowed } = require('../electron/lib/feedback-github.cjs');
test('GitHub transport allows only fixed authentication and repository endpoints', async () => {
  assert.ok(requestAllowed('https://github.com/login/device/code'));
  for (const url of ['http://github.com/login/device/code', 'https://evil.invalid/', 'https://api.github.com/repos/other/repo/issues', 'https://github.com/login/device/code?secret=x']) assert.equal(requestAllowed(url), false);
  await assert.rejects(githubRequest('https://evil.invalid/'), /不允许/);
});
test('device flow and refresh use a public client ID without a client secret', async () => {
  const calls = []; const github = createFeedbackGithub({ request: async (url, options) => { calls.push({ url, options }); return { status: 200, data: { error: 'authorization_pending' } }; } });
  await github.startDevice('public-id'); await github.pollDevice('public-id', 'private-device'); await github.refresh('public-id', 'private-refresh');
  assert.equal(calls[1].options.body.grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
  assert.ok(calls.every(call => !Object.hasOwn(call.options.body, 'client_secret')));
});
test('issue creation sends only title/body and validates the returned fixed-repository link', async () => {
  const calls = []; const github = createFeedbackGithub({ request: async (url, options) => { calls.push({ url, options }); return { status: 201, data: { number: 5, html_url: 'https://github.com/xiandan001/adb-workbench/issues/5' } }; } });
  assert.equal((await github.createIssue({ accessToken: 'private-token', title: 'title', body: 'body' })).number, 5);
  assert.deepEqual(Object.keys(calls[0].options.body), ['title', 'body']); assert.equal(calls[0].options.headers.Authorization, 'Bearer private-token');
  const invalid = createFeedbackGithub({ request: async () => ({ status: 201, data: { number: 5, html_url: 'https://evil.invalid/5' } }) });
  await assert.rejects(invalid.createIssue({}), error => error.uncertain === true);
});
test('ambiguous request failure is distinguished from definite authorization rejection', async () => {
  for (const request of [async () => { throw Error('private network body'); }, async () => ({ status: 503, data: {} })]) {
    const github = createFeedbackGithub({ request }); await assert.rejects(github.createIssue({}), error => error.uncertain === true && !error.message.includes('private'));
  }
  const denied = createFeedbackGithub({ request: async () => ({ status: 401, data: { message: 'private-token' } }) });
  await assert.rejects(denied.createIssue({}), error => error.code === 'FEEDBACK_AUTH_REQUIRED' && !error.uncertain && !error.message.includes('private'));
});
test('ambiguous-result lookup restricts author/repository and recognizes only this report marker', async () => {
  const id = '00000000-0000-4000-8000-000000000001'; const calls = [];
  const github = createFeedbackGithub({ request: async (url, options) => { calls.push({ url, options }); return { status: 200, data: [
    { number: 1, user: { login: 'other' }, body: `<!-- workbench-report:${id} -->` },
    { number: 9, user: { login: 'author' }, body: `<!-- workbench-report:${id} -->`, html_url: 'https://github.com/xiandan001/adb-workbench/issues/9' },
  ] }; } });
  assert.equal((await github.findIssue({ accessToken: 'private-token', login: 'author', reportId: id, since: '2026-10-23T00:00:00Z' })).number, 9);
  assert.ok(calls[0].url.includes('creator=author')); assert.ok(!calls[0].options.body);
});
