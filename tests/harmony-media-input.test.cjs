const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarmonyMediaInput } = require('../electron/lib/harmony-media-input.cjs');

function fixture(perform) {
  let generation = 1; const calls = [], records = [];
  const ref = { generation: 1, targetKey: 'PRIVATE_TARGET' };
  const state = { status: 'streaming', sourceWidth: 1280, sourceHeight: 720 };
  const view = { ordinal: 1, deviceId: 'hdc:PRIVATE_TARGET', ref, sessionId: 'PRIVATE_SESSION', decoded: true,
    window: { isDestroyed: () => false } };
  const input = createHarmonyMediaInput({ getStream: () => state, resolveDevice: () => ({ generation, targetKey: 'PRIVATE_TARGET' }),
    record: event => records.push(event), performInput: async (...args) => { calls.push(args); return perform ? perform(...args) : { ok: true }; } });
  return { view, state, calls, records, input: args => input(view, args), replace: () => { generation++; } };
}
test('input maps visual edges to valid UITest pixels, reports action/phase and never logs raw input content', async () => {
  const h = fixture(); assert.equal((await h.input({ type: 'tap', x: 0, y: 0 })).success, true);
  assert.deepEqual(h.calls[0][2], { x: 1, y: 1 });
  assert.equal((await h.input({ type: 'input', text: 'PRIVATE_TEXT' })).success, true);
  assert.equal(h.calls[1][1].text, 'PRIVATE_TEXT');
  assert.ok(h.records.some(row => row.event === 'control-request' && row.operation === 'tap'));
  assert.ok(h.records.some(row => row.event === 'control-result' && row.outcome === 'success'));
  assert.doesNotMatch(JSON.stringify(h.records), /PRIVATE|deviceId|sessionId|"text":|"x":|"y":|stdout|stderr/);
});
test('busy inputs are explicitly refused and logged without sending a second device command or stopping video', async () => {
  let release; const h = fixture(() => new Promise(resolve => { release = resolve; }));
  const first = h.input({ type: 'tap', x: .5, y: .5 });
  const next = await h.input({ type: 'keyevent', key: 'home' });
  assert.equal(next.code, 'INPUT_BUSY'); assert.equal(h.calls.length, 1); assert.equal(h.state.status, 'streaming');
  assert.ok(h.records.some(row => row.event === 'control-result' && row.reason === 'BUSY'));
  release({ ok: true }); assert.equal((await first).success, true);
});
test('capabilities are view-local, cached only for the same generation and never serialized', async () => {
  let h; const capability = { help: 'PRIVATE_HELP click keyEvent', apiVersion: null, focusText: false };
  h = fixture(async (_id, _step, _point, options) => {
    if (!options.uitestCapabilities) options.onUiCapabilities(capability);
    return { ok: true };
  });
  await h.input({ type: 'tap', x: .2, y: .2 }); await h.input({ type: 'keyevent', key: 'back' });
  assert.equal(h.calls[0][3].uitestCapabilities, undefined); assert.equal(h.calls[1][3].uitestCapabilities, capability);
  h.replace(); const result = await h.input({ type: 'tap', x: .2, y: .2 });
  assert.equal(result.code, 'INPUT_DEVICE_CHANGED'); assert.equal(h.calls.length, 2);
  assert.doesNotMatch(JSON.stringify(h.records), /PRIVATE|apiVersion|focusText|help:/);
});
test('a stale in-flight completion never changes lastPoint or becomes a successful result', async () => {
  let release; const h = fixture(() => new Promise(resolve => { release = resolve; }));
  const pending = h.input({ type: 'tap', x: .4, y: .4 }); h.replace(); release({ ok: true });
  assert.equal((await pending).code, 'INPUT_DEVICE_CHANGED'); assert.equal(h.view.lastPoint, undefined); assert.equal(h.view.inputBusy, false);
});
test('failed help trace carries exit metadata and cannot collapse to a raw unclassified UI error', async () => {
  const h = fixture(async (_id, _step, _point, options) => {
    options.onControlTrace({ phase: 'help', outcome: 'failure', reason: 'REMOTE_EXIT', hostCode: 0, remoteCode: 1, completion: 'confirmed', durationMs: 1500 });
    throw Error('PRIVATE_STDOUT token=PRIVATE_TOKEN');
  });
  const result = await h.input({ type: 'tap', x: .5, y: .5 }); assert.equal(result.code, 'INPUT_HELP');
  const row = h.records.find(event => event.event === 'control-stage'); assert.equal(row.remoteCode, 1); assert.equal(row.phase, 'help');
  assert.doesNotMatch(JSON.stringify({ result, records: h.records }), /PRIVATE|token|stdout/);
});
test('closed, unpainted, unsupported and malformed requests fail before probing any device', async () => {
  const h = fixture(); h.view.decoded = false;
  assert.equal((await h.input({ type: 'tap', x: .5, y: .5 })).code, 'INPUT_SESSION'); h.view.decoded = true;
  assert.equal((await h.input({ type: 'keyevent', key: 'power' })).code, 'INPUT_UNSUPPORTED');
  assert.equal((await h.input({ type: 'tap', x: 2, y: .5 })).code, 'INPUT_ARGUMENT');
  assert.equal((await h.input({ type: 'tap', x: .5, y: .5, command: 'PRIVATE' })).code, 'INPUT_ARGUMENT');
  assert.equal(h.calls.length, 0);
});
