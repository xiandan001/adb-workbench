const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const { createAppDiagnosticLog } = require('../electron/lib/app-diagnostic-log.cjs');
const { normalizeApplicationLogEvent } = require('../electron/lib/application-log-policy.cjs');
const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');

function callback(object, event) {
  let result;
  traverse(parse(source, { sourceType: 'script' }), { CallExpression({ node }) {
    if (node.callee.object?.name === object && node.callee.property?.name === 'on' && node.arguments[0]?.value === event) {
      result = source.slice(node.arguments[1].start, node.arguments[1].end);
    }
  } });
  assert.ok(result, `${object}.${event}`); return result;
}

function fixture({ launch, proceed = true, restart = false } = {}) {
  const calls = [], dialogs = []; const owner = { isDestroyed: () => false };
  const context = {
    ctx: { getMainWindow: () => owner }, createWindow: () => assert.fail('main window must be preserved'),
    serial: { needsQuitConfirmation: () => false, saveAll() {} }, ssh: { needsQuitConfirmation: () => false, confirmQuit: async () => true },
    screenRecording: { listUnresolved: () => [] }, reproduction: { hasActive: () => false, confirmQuit: async () => { calls.push('confirm'); return proceed; } },
    confirmSerialQuit: async () => true, confirmRecordingQuit: async () => true,
    dataMigration: { isRestartRequested: () => restart }, tr: value => value, console: { warn() {} },
    appMessageDialog: { ask: async value => { dialogs.push(value); return { response: 0 }; } },
    cleanupBeforeQuit: async () => { calls.push('cleanup'); },
    updater: { isQuitAndInstallInProgress: () => false, shouldInstallDownloadedUpdateOnQuit: () => true,
      beginUpdateInstall: async () => { calls.push('launch'); return launch ? launch() : { ok: true, code: 'READY' }; },
      noteUpdateInstallQuitting: () => calls.push('quitting-record'), quitAndInstallPreparedUpdate: () => { calls.push('acknowledged-quit'); return true; } },
    app: { quit: () => calls.push('quit-request') },
  };
  const state = vm.runInNewContext(`(() => { let quitCleanupFinished = false, quitCleanupRunning = false;
    return { before: ${callback('app', 'before-quit')}, close: ${callback('mainWindow', 'close')},
      flags: () => ({ finished: quitCleanupFinished, running: quitCleanupRunning }) }; })()`, context);
  let prevented = 0;
  return { calls, dialogs, state, event: () => ({ preventDefault: () => { prevented++; } }), prevented: () => prevented };
}

test('main waits for acknowledged launch before stopping any resource or diagnostic capture', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const f = fixture({ launch: () => pending });
  const quit = f.state.before(f.event()); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, ['confirm', 'launch']); assert.equal(f.state.flags().running, true);
  await f.state.before(f.event()); assert.deepEqual(f.calls, ['confirm', 'launch']);
  release({ ok: true, code: 'READY' }); await quit;
  assert.deepEqual(f.calls, ['confirm', 'launch', 'quitting-record', 'cleanup', 'acknowledged-quit']);
  assert.equal(f.state.flags().finished, true);
});

test('UAC cancellation and launch failure preserve the window, services and retry state with a custom prompt', async () => {
  for (const code of ['UAC_CANCELLED', 'READY_TIMEOUT', 'START_FAILED', 'INSTALLER_EXITED']) {
    const f = fixture({ launch: async () => ({ ok: false, code, error: 'safe fixture failure' }) });
    f.state.close(f.event()); assert.equal(f.prevented(), 1); assert.deepEqual(f.calls, ['quit-request']);
    await f.state.before(f.event());
    assert.deepEqual(f.calls, ['quit-request', 'confirm', 'launch']); assert.equal(f.dialogs.length, 1);
    assert.equal(f.dialogs[0].title, '未能启动安装器'); assert.equal(f.state.flags().running, false); assert.equal(f.state.flags().finished, false);
    await f.state.before(f.event()); assert.equal(f.dialogs.length, 2);
  }
});

test('save cancellation never launches, while a migration restart never starts an updater installer', async () => {
  const cancel = fixture({ proceed: false }); await cancel.state.before(cancel.event());
  assert.deepEqual(cancel.calls, ['confirm']); assert.equal(cancel.state.flags().running, false);
  const restart = fixture({ restart: true }); await restart.state.before(restart.event());
  assert.deepEqual(restart.calls, ['confirm', 'cleanup', 'quit-request']);
});

test('handoff phases and typed failures persist in bounded diagnostics and optional capture without tokens or paths', async () => {
  const parent = fs.realpathSync.native(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, 'veylo-handoff-diagnostics-'));
  const logger = createAppDiagnosticLog({ directory, version: '4.7.22' });
  try {
    for (const installPhase of ['launching', 'ready', 'failed', 'quitting']) {
      const event = { module: 'updater', operation: 'install', outcome: installPhase === 'failed' ? 'failure' : 'started',
        installPhase, installCode: installPhase === 'failed' ? 'UAC_CANCELLED' : 'READY', installerPid: 1234,
        path: 'C:\\PRIVATE', token: 'PRIVATE_TOKEN', commandLine: 'PRIVATE_COMMAND' };
      assert.equal(logger.record(event), true);
      const captured = normalizeApplicationLogEvent({ ...event, source: 'updater', event: 'install' });
      assert.equal(captured.installCode, event.installCode); assert.equal(captured.installPhase, installPhase);
      assert.doesNotMatch(JSON.stringify(captured), /PRIVATE/);
    }
    await logger.flush(); const snapshot = await logger.snapshot();
    assert.equal(snapshot.lines, 4); assert.doesNotMatch(snapshot.text, /PRIVATE/);
    const restored = createAppDiagnosticLog({ directory, version: '4.7.22' });
    assert.equal((await restored.snapshot()).text, snapshot.text); await restored.dispose();
  } finally {
    await logger.dispose();
    const relative = path.relative(parent, fs.realpathSync.native(directory));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(directory, { recursive: true });
  }
});
