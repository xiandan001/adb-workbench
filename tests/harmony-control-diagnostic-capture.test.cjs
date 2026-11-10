const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHarmonyMediaInput } = require('../electron/lib/harmony-media-input.cjs');
const { performHarmonyInput } = require('../electron/lib/harmony-task-ui.cjs');
const { normalizeHdcResult } = require('../electron/lib/hdc-runtime.cjs');
const { createApplicationLogSession } = require('../electron/lib/application-log-session.cjs');
const { safeDiagnosticChannel } = require('../electron/lib/app-diagnostic-log.cjs');

const help = 'usage: uitest <command>\nuiInput\n click/doubleClick/longClick <x> <y>\n keyEvent <keyID>\n inputText <x> <y> <text>\n text <text>\n';
test('actual exported application capture distinguishes help failure from sent-click failure without raw device content', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awb-control-capture-'));
  const session = createApplicationLogSession({ directory, metadata: { version: '4.7.14' } });
  t.after(async () => { await session.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  await session.start();
  const calls = []; let failHelp = true;
  const ref = { generation: 1, targetKey: 'PRIVATE_DEVICE' };
  const view = { ordinal: 1, deviceId: 'hdc:PRIVATE_DEVICE', sessionId: 'PRIVATE_SESSION', ref, decoded: true, window: { isDestroyed: () => false } };
  const run = async (_device, args) => {
    calls.push(args);
    const isHelp = args[1] === 'uitest' && args[2] === 'help';
    const text = isHelp ? help : 'PRIVATE_DEVICE PRIVATE_OUTPUT PRIVATE_TOKEN';
    return normalizeHdcResult(null, `${text}\nCOMPLETION:${isHelp && !failHelp ? 0 : 1}\n`, '', 'COMPLETION', false);
  };
  const input = createHarmonyMediaInput({ getStream: () => ({ status: 'streaming', sourceWidth: 1920, sourceHeight: 1080 }),
    resolveDevice: () => ref, performInput: (device, step, point, options) => performHarmonyInput(device, step, point, options, run), record: event => session.record(event) });
  assert.equal((await input(view, { type: 'tap', x: .5, y: .5 })).code, 'INPUT_HELP');
  assert.equal(calls.some(args => args[3] === 'click'), false);
  failHelp = false;
  assert.equal((await input(view, { type: 'tap', x: .5, y: .5 })).code, 'INPUT_REMOTE_EXIT');
  assert.equal(calls.filter(args => args[3] === 'click').length, 1);
  await session.stop();
  const text = await session.text(), rows = text.trim().split('\n').map(JSON.parse);
  assert.ok(rows.some(row => row.event === 'control-stage' && row.phase === 'help' && row.outcome === 'failure' && row.remoteCode === 1));
  assert.ok(rows.some(row => row.event === 'control-stage' && row.phase === 'execute' && row.outcome === 'failure' && row.remoteCode === 1));
  assert.ok(rows.some(row => row.event === 'control-result' && row.controlCode === 'INPUT_REMOTE_EXIT' && row.operation === 'tap'));
  assert.doesNotMatch(text, /PRIVATE|"text":|"x":|"y":|deviceId|sessionId|command|stdout|stderr/);
  assert.equal(safeDiagnosticChannel('harmony-media:input'), 'harmony-media:input');
  assert.equal(safeDiagnosticChannel('harmony-media:ack'), 'harmony-media:ack');
  assert.equal(safeDiagnosticChannel('harmony-media:diagnostic'), 'harmony-media:diagnostic');
  assert.equal(safeDiagnosticChannel('private-channel-name'), 'other');
});
test('host startup or crash failure is not mislabeled as a missing remote confirmation in the exported capture', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awb-control-host-'));
  const session = createApplicationLogSession({ directory });
  t.after(async () => { await session.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  await session.start();
  const ref = { generation: 1, targetKey: 'PRIVATE_TARGET' };
  for (const code of ['ENOENT', 7, 3221225477, -1073741819]) {
    const view = { ordinal: 1, deviceId: 'hdc:PRIVATE_TARGET', sessionId: 'PRIVATE_SESSION', ref, decoded: true, window: { isDestroyed: () => false } };
    const input = createHarmonyMediaInput({ getStream: () => ({ status: 'streaming', sourceWidth: 1280, sourceHeight: 720 }), resolveDevice: () => ref,
      performInput: (device, step, point, options) => performHarmonyInput(device, step, point, options,
        async () => normalizeHdcResult(Object.assign(Error('PRIVATE_PATH'), { code }), '', '', 'COMPLETION', false)),
      record: event => session.record(event) });
    assert.equal((await input(view, { type: 'tap', x: .5, y: .5 })).code, 'INPUT_TRANSPORT');
  }
  await session.stop(); const text = await session.text(), rows = text.trim().split('\n').map(JSON.parse);
  const failed = rows.filter(row => row.event === 'control-stage' && row.outcome === 'failure');
  assert.equal(failed.length, 4); assert.ok(failed.every(row => row.reason === 'TRANSPORT_ERROR' && row.completion === 'missing'));
  assert.deepEqual(failed.slice(1).map(row => row.hostCode), [7, 3221225477, -1073741819]);
  assert.doesNotMatch(text, /PRIVATE|ENOENT|deviceId|"text":|"x":|"y":/);
});
