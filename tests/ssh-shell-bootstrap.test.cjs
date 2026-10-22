const test = require('node:test');
const assert = require('node:assert/strict');
const { installBashIntegration } = require('../electron/lib/ssh-shell-bootstrap.cjs');

function fixture(overrides = {}) {
  const calls = []; const handle = Buffer.from('owned-handle');
  const sftp = {
    realpath: (name, cb) => { calls.push(['realpath', name]); cb(null, '/home/test user'); },
    open: (name, flags, attrs, cb) => { calls.push(['open', name, flags, attrs]); cb(null, handle); },
    write: (held, bytes, offset, length, position, cb) => { calls.push(['write', held, bytes.subarray(offset, offset + length).toString(), position]); cb(null); },
    close: (held, cb) => { calls.push(['close', held]); cb(null); },
    unlink: (name, cb) => { calls.push(['unlink', name]); cb(null); }, ...overrides
  };
  const controller = new AbortController();
  const args = { getSftp: async () => sftp, signal: controller.signal, assertCurrent: () => {
    if (controller.signal.aborted) throw new Error('closed');
  }, script: 'fixture-script', write: async command => { calls.push(['terminal', command]); }, waitReady: Promise.resolve(), timeoutMs: 50 };
  return { calls, sftp, args, controller };
}
test('bootstrap creates only an exclusive 0600 script, sources its quoted path and removes that exact file', async () => {
  const h = fixture(); await installBashIntegration(h.args);
  const opened = h.calls.find(call => call[0] === 'open');
  assert.match(opened[1], /^\/home\/test user\/\.adb-workbench-shell-[a-f0-9-]+\.bash$/);
  assert.equal(opened[2], 'wx'); assert.equal(opened[3].mode, 0o600);
  assert.equal(h.calls.find(call => call[0] === 'terminal')[1], ` . '${opened[1]}'\r`);
  assert.deepEqual(h.calls.find(call => call[0] === 'unlink'), ['unlink', opened[1]]);
});
test('a failed exclusive open never deletes a pre-existing file or sends terminal input', async () => {
  const h = fixture({ open: (_name, _flags, _attrs, cb) => cb(new Error('EXISTS private detail')) });
  await assert.rejects(installBashIntegration(h.args), error => !error.message.includes('private detail'));
  assert.ok(!h.calls.some(call => ['unlink', 'terminal'].includes(call[0])));
});
test('write failure closes and removes only this attempt and never sources partial content', async () => {
  const h = fixture({ write: (_h, _b, _o, _l, _p, cb) => cb(new Error('secret')) });
  await assert.rejects(installBashIntegration(h.args));
  assert.equal(h.calls.filter(call => call[0] === 'close').length, 1);
  assert.equal(h.calls.filter(call => call[0] === 'unlink').length, 1);
  assert.ok(!h.calls.some(call => call[0] === 'terminal'));
});
test('cancelled late SFTP creation is closed and cleaned without sending a source command', async () => {
  let callback; let opened;
  const h = fixture({ open: (name, _flags, _attrs, cb) => { opened = name; callback = cb; } });
  const pending = installBashIntegration(h.args); const rejected = assert.rejects(pending);
  await new Promise(resolve => setImmediate(resolve)); h.controller.abort();
  callback(null, Buffer.from('late')); await rejected;
  assert.deepEqual(h.calls.find(call => call[0] === 'unlink'), ['unlink', opened]);
  assert.ok(!h.calls.some(call => call[0] === 'terminal'));
});
test('an unresponsive exclusive open is bounded and reports the uncertain temporary path', async () => {
  const h = fixture({ open: () => {} }); h.args.cleanupTimeoutMs = 10;
  await assert.rejects(installBashIntegration(h.args), error => error.code === 'SSH_SHELL_CLEANUP_FAILED'
    && error.message.includes('可能未清理') && error.temporaryPath.startsWith('/home/test user/.adb-workbench-shell-'));
  assert.ok(!h.calls.some(call => call[0] === 'terminal'));
});
