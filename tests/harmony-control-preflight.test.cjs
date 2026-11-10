const test = require('node:test');
const assert = require('node:assert/strict');
const { performHarmonyInput } = require('../electron/lib/harmony-task-ui.cjs');
const { normalizeHdcResult } = require('../electron/lib/hdc-runtime.cjs');

const help = 'usage: uitest <command> [options]\nuiInput inject UI operations\n  click/doubleClick/longClick <x> <y>\n  swipe/drag <from_x> <from_y> <to_x> <to_y> [velocity]\n  keyEvent <keyID/Back/Home/Power>\n  inputText <x> <y> <text>\n  text <text>\n--version print current tool version\n';
const success = stdout => ({ ok: true, code: 0, hostCode: 0, remoteCode: 0, completion: 'confirmed', transportFailure: false, stdout, stderr: '' });
const tap = { type: 'tap' }, point = { x: 100, y: 200 };
function fixture(overrides = {}) {
  const calls = [], traces = [], caps = [];
  const run = async (_id, args) => {
    calls.push(args);
    const kind = args[1] === 'param' ? 'api' : args[2] === 'help' || args[3] === 'help' ? 'help' : 'execute';
    if (overrides[kind]) return overrides[kind](args);
    return success(kind === 'help' ? help : kind === 'api' ? '18' : '');
  };
  const options = { onControlTrace: event => traces.push(event), onUiCapabilities: cap => caps.push(cap) };
  return { calls, traces, caps, run, options };
}
test('official subcommand-help exit 1 no longer prevents click: general help is queried and API is not', async () => {
  const f = fixture({ help: args => args[3] === 'help'
    ? normalizeHdcResult(null, 'Missing parameter.\n' + help + '\nMARKER:1\n', '', 'MARKER', false) : success(help) });
  const result = await performHarmonyInput('hdc:private-target', tap, point, f.options, f.run);
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls, [['shell', 'uitest', 'help'], ['shell', 'uitest', 'uiInput', 'click', '100', '200']]);
  assert.deepEqual(f.traces.map(event => [event.phase, event.outcome]), [['help', 'started'], ['help', 'success'], ['execute', 'started'], ['execute', 'success']]);
});
test('help must positively advertise actions and a nonzero or unconfirmed help never becomes success', async () => {
  for (const result of [success('The click capability is unavailable.'), { ...success(help), ok: false, remoteCode: 1, code: 1 },
    { ...success(help), ok: false, remoteCode: null, completion: 'missing' }]) {
    const f = fixture({ help: () => result });
    await assert.rejects(performHarmonyInput('hdc:A', tap, point, f.options, f.run));
    assert.equal(f.calls.length, 1); assert.equal(f.caps.length, 0); assert.equal(f.traces.at(-1).outcome, 'failure');
  }
});
test('cached positive help is reused and only focus text queries API once, including a negative API version', async () => {
  const f = fixture({ api: () => success('17') });
  await performHarmonyInput('hdc:A', tap, point, f.options, f.run);
  let cached = f.caps.at(-1);
  await performHarmonyInput('hdc:A', tap, point, { ...f.options, uitestCapabilities: cached }, f.run);
  await assert.rejects(performHarmonyInput('hdc:A', { type: 'input', text: 'PRIVATE_TEXT' }, null, { ...f.options, uitestCapabilities: cached }, f.run), /API 18/);
  cached = f.caps.at(-1); assert.equal(cached.apiVersion, 17);
  await assert.rejects(performHarmonyInput('hdc:A', { type: 'input', text: 'PRIVATE_TEXT' }, null, { ...f.options, uitestCapabilities: cached }, f.run), /API 18/);
  assert.equal(f.calls.filter(args => args[2] === 'help').length, 1); assert.equal(f.calls.filter(args => args[1] === 'param').length, 1);
  assert.equal(f.calls.filter(args => args[3] === 'text').length, 0);
});
test('failed API query does not discard cached help and is never treated as a successful text input', async () => {
  const f = fixture({ api: () => ({ ...success(''), ok: false, remoteCode: 1, code: 1 }) });
  await performHarmonyInput('hdc:A', tap, point, f.options, f.run); const cached = f.caps.at(-1);
  await assert.rejects(performHarmonyInput('hdc:A', { type: 'input', text: 'PRIVATE_TEXT' }, null, { ...f.options, uitestCapabilities: cached }, f.run),
    error => error.controlReason === 'API_UNAVAILABLE' && error.controlPhase === 'api');
  assert.equal(f.calls.filter(args => args[2] === 'help').length, 1); assert.equal(f.traces.at(-1).phase, 'api');
  await performHarmonyInput('hdc:A', tap, point, { ...f.options, uitestCapabilities: cached }, f.run);
  assert.equal(f.calls.filter(args => args[2] === 'help').length, 1);
});
test('official zero-exit exceptions fail, while ordinary input text containing error words is not an error', async () => {
  for (const output of ['Invalid display id.', 'Set pasteBoard data failed.']) {
    const f = fixture({ execute: () => success(output) }); const result = await performHarmonyInput('hdc:A', tap, point, f.options, f.run);
    assert.equal(result.ok, false); assert.equal(f.traces.at(-1).reason, 'UITEST_ERROR');
  }
  const f = fixture({ execute: () => success('ordinary input mentions error and permission in a sentence') });
  assert.equal((await performHarmonyInput('hdc:A', { type: 'input', text: 'error' }, point, f.options, f.run)).ok, true);
});
test('execute completion metadata remains diagnostic-only and missing completion is rejected', async () => {
  const f = fixture({ execute: () => ({ ...success('PRIVATE_OUTPUT'), ok: false, code: 1, remoteCode: null, completion: 'missing', error: 'PRIVATE_ERROR' }) });
  const result = await performHarmonyInput('hdc:PRIVATE_ID', tap, point, f.options, f.run);
  assert.equal(result.ok, false); const trace = f.traces.at(-1);
  assert.equal(trace.reason, 'REMOTE_UNCONFIRMED'); assert.equal(trace.hostCode, 0); assert.equal(trace.completion, 'missing');
  assert.doesNotMatch(JSON.stringify(f.traces), /PRIVATE_|stdout|stderr|command|"x"|"y"/);
  for (const event of f.traces) assert.ok(Object.keys(event).every(key => ['phase', 'outcome', 'reason', 'durationMs', 'hostCode', 'remoteCode', 'completion', 'transportFailure'].includes(key)));
});
test('capability and trace callbacks cannot break successful input even when they throw or reject', async () => {
  const f = fixture();
  const options = { onUiCapabilities: () => { throw Error('callback'); }, onControlTrace: async () => { throw Error('callback'); } };
  assert.equal((await performHarmonyInput('hdc:A', tap, point, options, f.run)).ok, true);
  await new Promise(resolve => setImmediate(resolve));
});
test('cancel and generation changes after awaited preflight cannot send an input or publish stale capabilities', async () => {
  const abort = new AbortController(); const f = fixture({ help: () => { abort.abort(); return success(help); } });
  await assert.rejects(performHarmonyInput('hdc:A', tap, point, { ...f.options, signal: abort.signal }, f.run), { code: 'CANCELLED' });
  assert.equal(f.calls.length, 1); assert.equal(f.caps.length, 0);
  let current = true; const g = fixture({ help: () => { current = false; return success(help); } });
  await assert.rejects(performHarmonyInput('hdc:A', tap, point, { ...g.options, assertCurrent: () => { if (!current) throw Object.assign(Error('changed'), { code: 'STALE_CONNECTION' }); } }, g.run), { code: 'STALE_CONNECTION' });
  assert.equal(g.calls.length, 1); assert.equal(g.caps.length, 0);
});
test('explicit zero coordinates are rejected before querying the device rather than silently adjusted', async () => {
  const f = fixture(); await assert.rejects(performHarmonyInput('hdc:A', tap, { x: 0, y: 200 }, f.options, f.run),
    error => /大于 0/.test(error.message) && error.controlReason === 'INVALID_INPUT' && error.controlPhase === 'validation');
  assert.equal(f.calls.length, 0);
});
test('positive focus-text version is cached without repeating help or API and input values never enter traces', async () => {
  const f = fixture(), text = 'PRIVATE_TEXT with error words';
  assert.equal((await performHarmonyInput('hdc:PRIVATE_ID', { type: 'input', text }, null, f.options, f.run)).ok, true);
  const cached = f.caps.at(-1); assert.equal(cached.apiVersion, 18);
  assert.equal((await performHarmonyInput('hdc:PRIVATE_ID', { type: 'input', text }, null, { ...f.options, uitestCapabilities: cached }, f.run)).ok, true);
  assert.equal(f.calls.filter(args => args[2] === 'help').length, 1); assert.equal(f.calls.filter(args => args[1] === 'param').length, 1);
  assert.equal(f.calls.filter(args => args[3] === 'text').length, 2); assert.doesNotMatch(JSON.stringify(f.traces), /PRIVATE_|error words/);
});
test('unsupported advertised operation is rejected with typed flags before executing', async () => {
  const f = fixture({ help: () => success('uiInput\n  click <x> <y>\n') });
  await assert.rejects(performHarmonyInput('hdc:A', { type: 'keyevent', keyCode: 'Home' }, null, f.options, f.run),
    error => error.controlReason === 'UNSUPPORTED' && error.controlPhase === 'help');
  assert.equal(f.calls.length, 1);
});
test('timeouts, transport failures, remote exits and cancellation retain distinct safe trace reasons', async () => {
  for (const [changes, reason] of [[{ timedOut: true }, 'TIMEOUT'], [{ transportFailure: true }, 'TRANSPORT_ERROR'],
    [{ remoteCode: 7, code: 7 }, 'REMOTE_EXIT'], [{ cancelled: true }, 'CANCELLED'], [{ stdout: 'Permission denied.' }, 'PERMISSION_DENIED']]) {
    const f = fixture({ execute: () => ({ ...success('PRIVATE_OUTPUT'), ok: false, ...changes }) });
    const result = await performHarmonyInput('hdc:A', tap, point, f.options, f.run);
    assert.equal(result.ok, false); assert.equal(result.controlReason, reason); assert.equal(f.traces.at(-1).reason, reason);
    assert.equal(f.traces.at(-1).outcome, reason === 'CANCELLED' ? 'cancelled' : 'failure');
  }
});
test('real HDC normalization preserves signed and unsigned Windows host exits in help, API and execute traces', async () => {
  for (const hostCode of [3221225477, -1073741819, -2147483648, 4294967295]) {
    const normalized = normalizeHdcResult(Object.assign(Error('PRIVATE_HOST_ERROR'), { code: hostCode }), '', '', 'MARKER', false);
    assert.equal(normalized.ok, false); assert.equal(normalized.code, hostCode); assert.equal(normalized.hostCode, hostCode);
    for (const phase of ['help', 'api', 'execute']) {
      const f = fixture({ [phase]: () => normalized });
      const job = performHarmonyInput('hdc:PRIVATE_ID', phase === 'api' ? { type: 'input', text: 'PRIVATE_TEXT' } : tap,
        phase === 'api' ? null : point, f.options, f.run);
      if (phase === 'execute') { const result = await job; assert.equal(result.ok, false); assert.equal(result.code, hostCode); }
      else await assert.rejects(job);
      const trace = f.traces.at(-1);
      assert.equal(trace.phase, phase); assert.equal(trace.hostCode, hostCode); assert.equal(trace.completion, 'missing');
      assert.equal(trace.reason, 'TRANSPORT_ERROR'); assert.equal(trace.remoteCode, undefined);
      assert.doesNotMatch(JSON.stringify(f.traces), /PRIVATE_/);
    }
  }
});
test('control metadata rejects host exits outside the signed-int32 to uint32 range and non-byte remote exits', async () => {
  for (const hostCode of [-2147483649, 4294967296, 1.5]) {
    const f = fixture({ execute: () => ({ ...success(''), hostCode, remoteCode: 255 }) });
    await performHarmonyInput('hdc:A', tap, point, f.options, f.run);
    assert.equal(f.traces.at(-1).hostCode, undefined); assert.equal(f.traces.at(-1).remoteCode, 255);
  }
  for (const remoteCode of [-1, 256, 1.5]) {
    const f = fixture({ execute: () => ({ ...success(''), remoteCode }) });
    await performHarmonyInput('hdc:A', tap, point, f.options, f.run);
    assert.equal(f.traces.at(-1).hostCode, 0); assert.equal(f.traces.at(-1).remoteCode, undefined);
  }
});
