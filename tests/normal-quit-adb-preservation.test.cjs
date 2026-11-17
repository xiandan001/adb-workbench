const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const functions = new Map();
traverse(parse(source, { sourceType: 'script' }), { FunctionDeclaration({ node }) {
  if (['cleanupBeforeQuit', 'cleanupRuntimeResources'].includes(node.id?.name)) functions.set(node.id.name, source.slice(node.start, node.end));
} });

function fixture({ serialFailure = false, preparationFailure = false } = {}) {
  const calls = [], forbidden = [], transports = new Map([['USB-owned-by-server', 'device'], ['192.0.2.10:5555', 'device'], ['192.0.2.11:5555', 'device']]);
  const shared = { serverAlive: true, externalClientAlive: true }, owned = { logCapture: true, shell: true };
  const remember = name => () => { calls.push(name); };
  const asynchronous = name => async () => { calls.push(name); };
  const logWindow = { isDestroyed: () => !owned.logCapture, destroy() { calls.push('log-window'); owned.logCapture = false; } };
  const context = {
    startupPresentation: { dispose: remember('startup') }, startupSettings: { cleanup: remember('startup-settings') },
    appMessageDialog: { cleanup: remember('app-dialog') }, feedback: { record: remember('shutdown-record'), cleanup: asynchronous('feedback') },
    aiTools: { cleanup: asynchronous('ai-tools') }, reproduction: { cleanup: asynchronous('reproduction') },
    serial: { cleanup: async () => { calls.push('serial'); if (serialFailure) throw Error('fixture serial driver failure'); } },
    ssh: { cleanup: asynchronous('ssh') }, applicationLog: { cleanup: asynchronous('application-log') },
    aiAnalyze: { resetAiState: remember('ai-state') }, aiWorkspace: { cleanup: remember('ai-workspace') },
    aiHandoff: { cleanup: remember('ai-handoff') }, aiOutbound: { cleanup: remember('ai-outbound') },
    workbenchActivity: { cleanup: remember('activity') }, mcp: { closeMcpServer: remember('mcp') },
    ctx: { getLogAnalyzerWindow: () => logWindow }, performanceMonitor: { cleanup: remember('performance') },
    taskCenter: { cleanup: remember('tasks') }, deviceGuard: { cleanup: remember('device-guard') },
    adb: {
      stopAllShellProcs() { calls.push('owned-shell'); owned.shell = false; },
      disconnect: () => forbidden.push('disconnect'), runAdb: args => forbidden.push(args),
    },
    cleanupAndroidToolProcesses: async options => {
      forbidden.push({ operation: 'global-tool-path-sweep', options });
      // The real sweep's default target is bundled adb.exe, including the shared server.
      shared.serverAlive = false; shared.externalClientAlive = false;
      for (const id of transports.keys()) transports.set(id, 'disconnected');
    },
    updater: { prepareForUpdateInstall: async () => { calls.push('prepare-update'); if (preparationFailure) throw Error('UPDATE_TOOL_CLEANUP_FAILED'); } },
    require(name) { assert.equal(name, './lib/harmony-media-window.cjs'); return { shutdownAll: asynchronous('owned-hdc-media') }; },
    console: { warn() {} }, setTimeout, clearTimeout,
  };
  for (const name of ['cleanupBeforeQuit', 'cleanupRuntimeResources']) assert.ok(functions.has(name), 'Execute actual main cleanup functions');
  const cleanup = vm.runInNewContext([...functions.values()].join('\n') + '\ncleanupBeforeQuit', context, { filename: 'actual-main-quit-cleanup' });
  return { cleanup, calls, forbidden, transports, shared, owned };
}

test('actual normal quit preserves the shared ADB server, USB/Wi-Fi transports and other clients while cleaning owned resources', async () => {
  const f = fixture(); await f.cleanup();
  assert.deepEqual(f.forbidden, [], 'Normal quit must not sweep bundled executable paths, kill-server or disconnect');
  assert.equal(f.shared.serverAlive, true); assert.equal(f.shared.externalClientAlive, true);
  assert.deepEqual([...f.transports.values()], ['device', 'device', 'device']);
  assert.deepEqual(f.owned, { logCapture: false, shell: false });
  assert.deepEqual([...f.calls].sort(), ['startup', 'startup-settings', 'app-dialog', 'shutdown-record', 'feedback', 'ai-tools', 'reproduction', 'serial', 'ssh',
    'application-log', 'ai-state', 'ai-workspace', 'ai-handoff', 'ai-outbound', 'activity', 'mcp', 'log-window', 'performance', 'tasks', 'device-guard', 'owned-shell', 'owned-hdc-media'].sort());
});

test('a failed owned serial cleanup does not fall back to killing the ADB server or skip the other owned cleanup', async () => {
  const f = fixture({ serialFailure: true }); await f.cleanup({ forUpdateInstall: false });
  assert.deepEqual(f.forbidden, []); assert.equal(f.shared.serverAlive, true); assert.equal(f.shared.externalClientAlive, true);
  assert.deepEqual([...f.transports.values()], ['device', 'device', 'device']);
  assert.equal(f.owned.logCapture, false); assert.equal(f.owned.shell, false); assert.ok(f.calls.includes('owned-hdc-media'));
});

test('acknowledged installation retains its separate awaited updater preparation path', async () => {
  const f = fixture(); await f.cleanup({ forUpdateInstall: true });
  assert.deepEqual(f.forbidden, []); assert.equal(f.calls.filter(value => value === 'prepare-update').length, 1);
  assert.ok(f.calls.indexOf('prepare-update') > f.calls.indexOf('owned-shell')); assert.equal(f.owned.logCapture, false); assert.equal(f.owned.shell, false);
});

test('update preparation failure is propagated rather than invoking a normal-exit process sweep', async () => {
  const f = fixture({ preparationFailure: true }); await assert.rejects(f.cleanup({ forUpdateInstall: true }), /UPDATE_TOOL_CLEANUP_FAILED/);
  assert.deepEqual(f.forbidden, []); assert.equal(f.calls.filter(value => value === 'prepare-update').length, 1);
});
