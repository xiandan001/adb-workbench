const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCipheriv, createDecipheriv } = require('node:crypto');
const { createFeedbackAuth } = require('../electron/lib/feedback-auth.cjs');

const DEVICE_URL = 'https://github.com/login/device';
const wait = () => new Promise(resolve => setImmediate(resolve));
const defer = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const challenge = overrides => ({ device_code: 'private-device-code', user_code: 'ABCD-EFGH', verification_uri: DEVICE_URL, expires_in: 900, interval: 5, ...overrides });
const granted = overrides => ({ access_token: 'private-access-token', expires_in: 28800, refresh_token: 'private-refresh-token', refresh_token_expires_in: 15811200, ...overrides });
function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-feedback-auth-')); const timers = new Map(); const calls = []; let time = 100000; let nextTimer = 0;
  const key = Buffer.alloc(32, 7); const iv = Buffer.alloc(12, 11);
  const encrypt = text => { const cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([cipher.update(text), cipher.final(), cipher.getAuthTag()]); };
  const decrypt = bytes => { const cipher = createDecipheriv('aes-256-gcm', key, iv); cipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([cipher.update(bytes.subarray(0, -16)), cipher.final()]).toString('utf8'); };
  const github = {
    startDevice: async id => { calls.push(['start', id]); return challenge(); },
    pollDevice: async (...args) => { calls.push(['poll', ...args]); return granted(); },
    refresh: async (...args) => { calls.push(['refresh', ...args]); return granted({ access_token: 'rotated-access-token', refresh_token: 'rotated-refresh-token' }); },
    user: async token => { calls.push(['user', token]); return { login: 'fixture-user' }; },
    ...overrides.github,
  };
  const options = { clientId: 'Iv1.fixture', directory, canEncrypt: () => true, encrypt, decrypt,
    openExternal: async url => { calls.push(['open', url]); }, now: () => time,
    schedule: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: time + delay }); return id; }, cancelTimer: id => timers.delete(id),
    ...overrides, github };
  const auth = createFeedbackAuth(options); const instances = [auth];
  t.after(() => { instances.forEach(item => item.dispose()); fs.rmSync(directory, { recursive: true, force: true }); });
  return { auth, options, directory, file: path.join(directory, 'feedback-github-auth.enc'), timers, calls, encrypt, decrypt,
    advance: delta => { time += delta; },
    async next() { const entry = [...timers].sort((a, b) => a[1].at - b[1].at)[0]; assert.ok(entry, 'poll must be scheduled'); timers.delete(entry[0]); time = Math.max(time, entry[1].at); entry[1].fn(); await wait(); },
    now: () => time,
    reload(extra = {}) { const instance = createFeedbackAuth({ ...options, ...extra }); instances.push(instance); return instance; },
  };
}
async function login(h, guard) { await h.auth.start(guard); await h.next(); assert.equal((await h.auth.status()).authenticated, true); }
function noSecrets(value) { assert.doesNotMatch(JSON.stringify(value), /private-(?:access|refresh|device)|rotated-(?:access|refresh)|device_code|access_token|refresh_token/); }

test('main-only credential leases bind token and login and cannot survive reauthorization or logout', async t => {
  const h = fixture(t); assert.equal(h.auth.isSessionCurrent(undefined), false);
  assert.equal(h.auth.isSessionCurrent({ epoch: 0 }), false);
  await login(h); const lease = await h.auth.getAccessSession();
  assert.equal(h.auth.isSessionCurrent(lease), true); noSecrets(await h.auth.status());
  await h.auth.start(); assert.equal(h.auth.isSessionCurrent(lease), false);
  await assert.rejects(h.auth.getAccessSession(), error => error.code === 'FEEDBACK_AUTH_PENDING');
  await h.auth.cancel(); const current = await h.auth.getAccessSession(); assert.equal(h.auth.isSessionCurrent(current), true);
  await h.auth.logout(); assert.equal(h.auth.isSessionCurrent(current), false);
  await assert.rejects(h.auth.getAccessSession(), error => error.code === 'FEEDBACK_AUTH_REQUIRED');
});

test('unconfigured auth is honest, inert and never reads account tools or opens a browser', async t => {
  const h = fixture(t, { clientId: '' }); const status = await h.auth.start();
  assert.equal(status.configured, false); assert.equal(status.pending, false); assert.equal(status.authenticated, false);
  assert.deepEqual(h.calls, []); assert.equal(fs.existsSync(h.file), false); noSecrets(status);
});

test('explicit start opens only the fixed GitHub URL and concurrent starts share the pending challenge', async t => {
  const response = defer(); const h = fixture(t, { github: { startDevice: () => response.promise } });
  assert.equal((await h.auth.status()).pending, false); assert.deepEqual(h.calls, []);
  const first = h.auth.start(); assert.equal((await h.auth.start()).pending, true); response.resolve(challenge());
  const pending = await first; assert.equal(pending.userCode, 'ABCD-EFGH'); assert.equal(pending.verificationUrl, DEVICE_URL);
  assert.deepEqual(h.calls, [['open', DEVICE_URL]]); assert.equal(h.timers.size, 1); noSecrets(pending);
  await h.auth.start(); assert.equal(h.calls.length, 1);
});

test('pending polling honors intervals, slow_down adds five seconds and auth becomes public only after /user', async t => {
  const user = defer(); const responses = [{ error: 'authorization_pending' }, { error: 'slow_down' }, granted()];
  const h = fixture(t, { github: { pollDevice: async () => responses.shift(), user: () => user.promise } });
  await h.auth.start(); assert.equal([...h.timers.values()][0].at - h.now(), 5000);
  await h.next(); assert.equal([...h.timers.values()][0].at - h.now(), 5000);
  await h.next(); assert.equal([...h.timers.values()][0].at - h.now(), 10000);
  await h.next(); assert.equal((await h.auth.status()).authenticated, false); assert.equal(fs.existsSync(h.file), false);
  user.resolve({ login: 'fixture-user' }); await wait(); const status = await h.auth.status();
  assert.equal(status.authenticated, true); assert.equal(status.pending, false); assert.equal(status.login, 'fixture-user'); assert.equal(status.persistent, true);
  noSecrets(status); assert.equal(h.timers.size, 0);
});

test('whole auth record is encrypted and reload restores it without network or renderer secrets', async t => {
  const h = fixture(t); await login(h); const bytes = fs.readFileSync(h.file);
  assert.equal(bytes.includes(Buffer.from('private-access-token')), false); assert.equal(bytes.includes(Buffer.from('private-refresh-token')), false);
  const before = h.calls.length; const reloaded = h.reload(); const status = await reloaded.status();
  assert.equal(status.authenticated, true); assert.equal(status.persistent, true); assert.equal(h.calls.length, before);
  assert.equal(await reloaded.getAccessToken(), 'private-access-token'); noSecrets(status);
});

test('explicit reauthorization starts a new challenge while cancel preserves the prior verified account', async t => {
  const h = fixture(t); await login(h); const saved = fs.readFileSync(h.file);
  h.options.github.startDevice = async () => challenge({ user_code: 'WXYZ-IJKL' });
  const pending = await h.auth.start(); assert.equal(pending.pending, true); assert.equal(pending.userCode, 'WXYZ-IJKL');
  assert.equal(pending.authenticated, true); assert.equal(pending.login, 'fixture-user'); assert.equal(h.calls.filter(row => row[0] === 'open').length, 2);
  await h.auth.start(); assert.equal(h.calls.filter(row => row[0] === 'open').length, 2); assert.deepEqual(fs.readFileSync(h.file), saved);
  const cancelled = await h.auth.cancel(); assert.equal(cancelled.authenticated, true); assert.equal(cancelled.pending, false);
  assert.equal(await h.auth.getAccessToken(), 'private-access-token'); assert.deepEqual(fs.readFileSync(h.file), saved);
});

test('explicit reauthorization replaces stored credentials only after the new account is verified', async t => {
  const h = fixture(t); await login(h); const saved = fs.readFileSync(h.file); const user = defer();
  h.options.github.pollDevice = async () => granted({ access_token: 'new-account-token' }); h.options.github.user = () => user.promise;
  await h.auth.start(); await h.next(); assert.deepEqual(fs.readFileSync(h.file), saved); assert.equal((await h.auth.status()).login, 'fixture-user');
  user.resolve({ login: 'another-user' }); await wait(); assert.equal((await h.auth.status()).login, 'another-user');
  assert.equal(await h.auth.getAccessToken(), 'new-account-token'); assert.notDeepEqual(fs.readFileSync(h.file), saved);
});

test('encryption unavailable means session only, with no plaintext file and no persistent login after restart', async t => {
  const h = fixture(t, { canEncrypt: () => false, encrypt: () => { throw Error('must not run'); } }); await login(h);
  const status = await h.auth.status(); assert.equal(status.persistent, false); assert.equal(fs.existsSync(h.file), false);
  assert.equal((await h.reload().status()).authenticated, false); assert.equal(await h.auth.getAccessToken(), 'private-access-token');
});

test('encryption failure keeps an authenticated session without writing plaintext or leaking crypto errors', async t => {
  const h = fixture(t, { encrypt: () => { throw Error('private-access-token'); } }); await login(h);
  const status = await h.auth.status(); assert.equal(status.authenticated, true); assert.equal(status.persistent, false);
  assert.equal(fs.existsSync(h.file), false); assert.ok(status.error); noSecrets(status);
});

test('missing token lifetime uses the eight-hour short-lived default, never an unbounded session', async t => {
  const h = fixture(t, { github: { pollDevice: async () => granted({ expires_in: undefined }) } }); await login(h);
  const saved = JSON.parse(h.decrypt(fs.readFileSync(h.file))); assert.equal(saved.expiresAt - h.now(), 28800000);
});

for (const response of [{ error: 'access_denied', error_description: 'private-access-token' }, { error: 'expired_token' }, { error: 'unknown', access_token: 'private-access-token' }]) {
  test(`device rejection ${response.error} terminates polling with sanitized status`, async t => {
    const h = fixture(t, { github: { pollDevice: async () => response } }); await h.auth.start(); await h.next();
    const status = await h.auth.status(); assert.equal(status.pending, false); assert.equal(status.authenticated, false); assert.equal(h.timers.size, 0); assert.ok(status.error); noSecrets(status);
  });
}

test('device expiry is a hard bound and never starts another poll after expiration', async t => {
  let polls = 0; const h = fixture(t, { github: { startDevice: async () => challenge({ expires_in: 6 }), pollDevice: async () => { polls++; return { error: 'authorization_pending' }; } } });
  await h.auth.start(); await h.next(); assert.equal(polls, 1); await h.next(); assert.equal(polls, 1);
  assert.match((await h.auth.status()).error, /过期/); assert.equal(h.timers.size, 0);
});

test('a token response arriving after device-code expiration is rejected before account lookup', async t => {
  const response = defer(); const h = fixture(t, { github: { startDevice: async () => challenge({ expires_in: 6 }), pollDevice: () => response.promise } });
  await h.auth.start(); await h.next(); h.advance(2000); response.resolve(granted()); await wait();
  assert.equal((await h.auth.status()).authenticated, false); assert.equal(h.calls.some(row => row[0] === 'user'), false); assert.equal(fs.existsSync(h.file), false);
});

for (const action of ['cancel', 'logout', 'dispose']) {
  test(`${action} rejects late poll credentials and cannot write auth storage`, async t => {
    const response = defer(); const h = fixture(t, { github: { pollDevice: () => response.promise } }); await h.auth.start(); await h.next();
    await h.auth[action](); response.resolve(granted()); await wait(); const status = await h.auth.status();
    assert.equal(status.pending, false); assert.equal(status.authenticated, false); assert.equal(fs.existsSync(h.file), false); assert.equal(h.calls.some(row => row[0] === 'user'), false); noSecrets(status);
  });
}

test('owner guard becoming invalid after /user prevents all state and disk changes', async t => {
  let allowed = true; const user = defer(); const h = fixture(t, { github: { user: () => user.promise } });
  await h.auth.start(() => allowed); await h.next(); allowed = false; user.resolve({ login: 'fixture-user' }); await wait();
  assert.equal((await h.auth.status()).authenticated, false); assert.equal(fs.existsSync(h.file), false);
});

test('cancelled start cannot open a browser or expose a later challenge', async t => {
  const response = defer(); const h = fixture(t, { github: { startDevice: () => response.promise } }); const pending = h.auth.start();
  await h.auth.cancel(); response.resolve(challenge()); await assert.rejects(pending, { code: 'FEEDBACK_AUTH_CANCELLED' });
  assert.deepEqual(h.calls, []); assert.equal((await h.auth.status()).pending, false); assert.equal(h.timers.size, 0);
});

test('adapter errors cannot leak raw text even when they reuse the cancellation error code', async t => {
  const error = Object.assign(new Error('private-access-token'), { code: 'FEEDBACK_AUTH_CANCELLED' });
  const h = fixture(t, { github: { startDevice: async () => { throw error; } } });
  await assert.rejects(h.auth.start(), caught => caught.code === 'FEEDBACK_AUTH_CANCELLED' && !caught.message.includes('private'));
  h.options.github.startDevice = async () => challenge(); await login(h); h.advance(28800000);
  h.options.github.refresh = async () => { throw error; };
  await assert.rejects(h.auth.getAccessToken(), caught => caught.code === 'FEEDBACK_AUTH_CANCELLED' && !caught.message.includes('private'));
  noSecrets(await h.auth.status());
});

test('hostile verification URL and malformed tokens never reach browser or auth storage', async t => {
  const h = fixture(t, { github: { startDevice: async () => challenge({ verification_uri: 'https://github.com.evil.invalid/login/device' }) } });
  assert.equal((await h.auth.start()).pending, false); assert.deepEqual(h.calls, []);
  h.options.github.startDevice = async () => challenge(); h.options.github.pollDevice = async () => granted({ access_token: 'token\r\nsecret' });
  await h.auth.start(); await h.next(); assert.equal((await h.auth.status()).authenticated, false); assert.equal(fs.existsSync(h.file), false);
});

test('refresh is single-flight, rotates both tokens and persists only verified same-account credentials', async t => {
  const response = defer(); let refreshes = 0; const h = fixture(t, { github: { refresh: () => { refreshes++; return response.promise; } } }); await login(h);
  h.advance(28800000); const first = h.auth.getAccessToken(); const second = h.auth.getAccessToken(); assert.equal(refreshes, 1);
  response.resolve(granted({ access_token: 'rotated-access-token', refresh_token: 'rotated-refresh-token' }));
  assert.equal(await first, 'rotated-access-token'); assert.equal(await second, 'rotated-access-token');
  const saved = JSON.parse(h.decrypt(fs.readFileSync(h.file))); assert.equal(saved.refreshToken, 'rotated-refresh-token');
  assert.equal(await h.reload().getAccessToken(), 'rotated-access-token'); noSecrets(await h.auth.status());
});

test('official GitHub 15897600-second refresh lifetime works for both initial grant and rotation', async t => {
  const h = fixture(t, { github: {
    pollDevice: async () => granted({ refresh_token_expires_in: 15897600 }),
    refresh: async () => granted({ access_token: 'rotated-access-token', refresh_token_expires_in: 15897600 }),
  } });
  await login(h); assert.equal(JSON.parse(h.decrypt(fs.readFileSync(h.file))).refreshExpiresAt - h.now(), 15897600000);
  h.advance(28800000); assert.equal(await h.auth.getAccessToken(), 'rotated-access-token');
  assert.equal(JSON.parse(h.decrypt(fs.readFileSync(h.file))).refreshExpiresAt - h.now(), 15897600000);
});

test('refresh lifetime stays bounded and rejects malformed or greater-than-one-year response values', async t => {
  const h = fixture(t);
  for (const duration of [0, -1, 366 * 86400 + 1, Number.MAX_SAFE_INTEGER, '15897600']) {
    h.options.github.pollDevice = async () => granted({ refresh_token_expires_in: duration });
    await h.auth.start(); await h.next(); assert.equal((await h.auth.status()).authenticated, false); assert.equal(fs.existsSync(h.file), false);
  }
});

test('a live late refresh joiner may finish, but a cancelled first caller cannot receive its token', async t => {
  const response = defer(); let firstAllowed = true; const h = fixture(t, { github: { refresh: () => response.promise } }); await login(h); h.advance(28800000);
  const first = h.auth.getAccessToken(() => firstAllowed); const firstRejected = assert.rejects(first, { code: 'FEEDBACK_AUTH_CANCELLED' });
  firstAllowed = false; const second = h.auth.getAccessToken(() => true); response.resolve(granted({ access_token: 'rotated-access-token' }));
  await firstRejected; assert.equal(await second, 'rotated-access-token'); assert.equal((await h.auth.status()).authenticated, true);
});

test('logout during refresh clears only local auth and late responses cannot recreate the file', async t => {
  const response = defer(); const h = fixture(t, { github: { refresh: () => response.promise } }); await login(h); h.advance(28800000);
  const access = h.auth.getAccessToken(); const rejected = assert.rejects(access, { code: 'FEEDBACK_AUTH_CANCELLED' });
  await h.auth.logout(); response.resolve(granted({ access_token: 'rotated-access-token' })); await rejected;
  assert.equal(fs.existsSync(h.file), false); assert.equal((await h.auth.status()).authenticated, false); assert.equal(h.timers.size, 0);
});

test('cancelled refresh owner cannot persist rotation when no authorized caller remains', async t => {
  let allowed = true; const response = defer(); const h = fixture(t, { github: { refresh: () => response.promise } }); await login(h); h.advance(28800000); const previous = fs.readFileSync(h.file);
  const access = h.auth.getAccessToken(() => allowed); const rejected = assert.rejects(access, { code: 'FEEDBACK_AUTH_CANCELLED' }); allowed = false;
  response.resolve(granted({ access_token: 'rotated-access-token' })); await rejected; assert.deepEqual(fs.readFileSync(h.file), previous);
});

test('refresh errors and changed accounts cannot replace the previous record or disclose raw errors', async t => {
  const h = fixture(t); await login(h); h.advance(28800000); const previous = fs.readFileSync(h.file);
  h.options.github.refresh = async () => { throw Error('private-access-token'); };
  await assert.rejects(h.auth.getAccessToken(), error => error.code === 'FEEDBACK_AUTH_REFRESH' && !error.message.includes('private'));
  h.options.github.refresh = async () => granted({ access_token: 'rotated-access-token' }); h.options.github.user = async () => ({ login: 'another-user' });
  await assert.rejects(h.auth.getAccessToken(), { code: 'FEEDBACK_AUTH_REFRESH' }); assert.deepEqual(fs.readFileSync(h.file), previous); noSecrets(await h.auth.status());
});

test('hardlinked auth file is refused for reading, overwriting and deleting without touching its target', async t => {
  const h = fixture(t); const target = path.join(h.directory, 'keep'); fs.writeFileSync(target, 'foreign-private-content'); fs.linkSync(target, h.file);
  assert.equal((await h.auth.status()).authenticated, false); await login(h); assert.equal((await h.auth.status()).persistent, false);
  await h.auth.logout(); assert.equal(fs.readFileSync(target, 'utf8'), 'foreign-private-content'); assert.equal(fs.readFileSync(h.file, 'utf8'), 'foreign-private-content');
});

test('directory junctions cannot redirect auth writes or logout into another directory', async t => {
  const h = fixture(t); const target = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-feedback-target-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true })); const junction = path.join(h.directory, 'redirect');
  fs.symlinkSync(target, junction, process.platform === 'win32' ? 'junction' : 'dir'); const redirected = h.reload({ directory: junction });
  assert.match((await redirected.status()).error, /安全/); await redirected.start(); await h.next(); assert.equal((await redirected.status()).persistent, false);
  await redirected.logout(); assert.deepEqual(fs.readdirSync(target), []);
});

test('corrupt or oversized ciphertext is preserved and cannot cause plaintext fallback', async t => {
  const h = fixture(t); fs.writeFileSync(h.file, Buffer.alloc(65537, 1));
  assert.equal((await h.auth.status()).authenticated, false); const previous = fs.readFileSync(h.file); await login(h);
  assert.equal((await h.auth.status()).persistent, false); assert.deepEqual(fs.readFileSync(h.file), previous);
});

test('explicit logout safely clears an unreadable ordinary auth file and permits a new encrypted login', async t => {
  const h = fixture(t); fs.writeFileSync(h.file, 'invalid-encrypted-fixture'); assert.ok((await h.auth.status()).error);
  assert.equal((await h.auth.logout()).error, undefined); assert.equal(fs.existsSync(h.file), false);
  await login(h); assert.equal((await h.auth.status()).persistent, true);
});

test('an externally replaced auth file is not overwritten or deleted by stale operations', async t => {
  const h = fixture(t); await login(h); fs.writeFileSync(h.file, Buffer.from('replacement-not-ours')); h.advance(28800000);
  assert.equal(await h.auth.getAccessToken(), 'rotated-access-token'); assert.equal((await h.auth.status()).persistent, false);
  assert.match((await h.auth.logout()).error, /清除/); assert.equal(fs.readFileSync(h.file, 'utf8'), 'replacement-not-ours');
});

test('logout can remove its encrypted record when safeStorage later becomes unavailable', async t => {
  const h = fixture(t); await login(h); const sessionOnly = h.reload({ canEncrypt: () => false });
  assert.equal((await sessionOnly.status()).authenticated, false); await sessionOnly.logout(); assert.equal(fs.existsSync(h.file), false);
});

test('disposed auth is inert, keeps existing persistent login and rejects further token access', async t => {
  const h = fixture(t); await login(h); const previous = fs.readFileSync(h.file); h.auth.dispose();
  await h.auth.logout(); await assert.rejects(h.auth.start(), { code: 'FEEDBACK_AUTH_CANCELLED' }); await assert.rejects(h.auth.getAccessToken(), { code: 'FEEDBACK_AUTH_CANCELLED' });
  assert.deepEqual(fs.readFileSync(h.file), previous); assert.equal((await h.auth.status()).authenticated, false);
});
