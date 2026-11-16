const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { parse } = require('@babel/parser'), traverse = require('@babel/traverse').default;
const captureHarness = require('./helpers/log-capture-harness.cjs');
const file = path.join(__dirname, '../electron/lib/auto-diagnose.cjs');
test('production capture, file scan and rule-test callbacks never call main-thread arbitrary regex matching', () => {
  const source = fs.readFileSync(file, 'utf8'), bodies = {};
  traverse(parse(source, { sourceType: 'script' }), { FunctionDeclaration({ node }) {
    if (['autoDiagnoseOnLine', 'autoDiagnoseScanFile'].includes(node.id.name)) bodies[node.id.name] = source.slice(node.start, node.end);
  }, CallExpression({ node }) {
    if (node.arguments[0]?.value === 'auto-diagnose:rules:test') bodies.test = source.slice(node.arguments[1].start, node.arguments[1].end);
  } });
  for (const [name, body] of Object.entries(bodies)) assert.doesNotMatch(body, /detectIssue\(|\.test\(/, name);
});
test('actual production capture advances while a bad custom rule times out and never reports clean', async t => {
  const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'veylo-diagnostic-prod-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), base); assert.ok(path.basename(root).startsWith('veylo-diagnostic-prod-')); fs.rmSync(root, { recursive: true, force: false }); });
  fs.writeFileSync(path.join(root, 'auto-diagnose-rules.json'), JSON.stringify({ version: 1, builtinEnabled: {}, customRules: [
    { id: 'custom-bad', type: 'custom_bad', label: 'Bad fixture', pattern: '^(a+)+$', flags: 'i', keywords: [], enabled: true }
  ] }));
  let capture; const events = [], handlers = new Map(), module = { exports: {} }, realRequire = createRequire(file);
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, Buffer, console, setTimeout, clearTimeout, setImmediate,
    require(name) {
      if (name === 'electron') return { app: { getPath: () => root } };
      if (name === './ai-analyze.cjs') return { aiKeys: {} };
      if (name === './vip.cjs') return { getStatusAsync: async () => ({ activated: true }) };
      if (name === './app-context.cjs') return { broadcastToAllWindows: (channel, payload) => events.push({ channel, payload }) };
      if (name === './ai-outbound-transport.cjs') return { protectIpc: value => value };
      if (name === './log-analyzer.cjs') return { getLogStore: () => capture.api.getLogStore() };
      return realRequire(name);
    } }, { filename: file });
  module.exports.register({ handle: (name, callback) => handlers.set(name, callback) });
  capture = captureHarness({ './auto-diagnose.cjs': module.exports });
  let beats = 0; const timer = setInterval(() => beats++, 5);
  try {
    await capture.api.startLogCapture({ deviceId: 'A' });
    capture.children[0].stdout.write('a'.repeat(10000) + '!\n');
    for (let i = 0; i < 30; i++) { capture.children[0].stdout.write(`still-capturing-${i}\n`); await new Promise(resolve => setTimeout(resolve, 10)); }
    const deadline = Date.now() + 5000;
    while (!events.some(event => event.channel === 'auto-diagnose:incomplete' && event.payload.reason === 'timeout')) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(capture.api.getLogStore().realtime.length, 31); assert.ok(beats > 3);
    const notice = events.find(event => event.channel === 'auto-diagnose:incomplete' && event.payload.reason === 'timeout'); assert.equal(notice.payload.partial, true); assert.equal(notice.payload.reason, 'timeout');
    await module.exports.autoDiagnoseScanFile([{ raw: 'ordinary' }], 'file');
    assert.equal(events.some(event => event.channel === 'auto-diagnose:scan-complete' && event.payload.issueCount === 0), false);
    const result = await handlers.get('auto-diagnose:rules:test')({ sender: capture.owner }, { line: 'a'.repeat(10000) + '!', rule: { id: 'test-bad', label: 'Test', pattern: '^(a+)+$', flags: 'i' } });
    assert.equal(result.ok, false); assert.ok(result.error);
    const cancelled = handlers.get('auto-diagnose:rules:test')({ sender: capture.owner }, { line: 'a'.repeat(10000) + '!', rule: { id: 'test-cancel', label: 'Test', pattern: '^(a+)+$', flags: 'i' } });
    capture.owner.emit('did-start-navigation', {}, 'about:blank', false, true);
    assert.equal((await cancelled).cancelled, true);
    module.exports.resetAutoDiagnoseLastFire(); events.length = 0;
    const original = { id: 'evicted-entry', raw: 'FATAL EXCEPTION: original-A', deviceId: 'A' };
    module.exports.autoDiagnoseOnLine(original.raw, 0, 'realtime', null, original);
    original.raw = 'changed'; original.deviceId = 'B';
    const contextDeadline = Date.now() + 5000;
    while (!events.some(event => event.channel === 'auto-diagnose:detected')) { assert.ok(Date.now() < contextDeadline); await new Promise(resolve => setTimeout(resolve, 5)); }
    const found = events.find(event => event.channel === 'auto-diagnose:detected').payload.issues[0];
    assert.equal(found.deviceId, 'A'); assert.ok(found.context.includes('original-A')); assert.equal(found.contextPartial, true); assert.ok(!found.context.includes('changed'));
  } finally { clearInterval(timer); await capture.api.stopLogCapture(); module.exports.resetAutoDiagnoseLastFire(); module.exports.disposeDiagnostics?.(); }
});
