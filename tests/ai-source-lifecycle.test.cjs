const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { bindSummaryLifetime } = require('../electron/lib/ai-source-lifecycle.cjs');
const { createOutboundTransport } = require('../electron/lib/ai-outbound-transport.cjs');
const { prepareBatch } = require('../electron/lib/ai-outbound-policy.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
async function pending(gate, owner) { for (let index = 0; index < 100; index++) { if (gate.list(owner).pending.length) return; await tick(); } assert.fail('No fixture preview'); }
function loadSource(name, task, handlers) {
  const module = { exports: {} }, filename = path.join(__dirname, '../electron/lib', name);
  const variable = name === 'performance-monitor.cjs' ? 'currentReportTask' : 'currentTask';
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + `\nmodule.exports.setFixtureTask = value => { ${variable} = value; };`, {
    module, console, Buffer, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    require: id => {
      if (id === './localization.cjs') return require('../electron/lib/localization.cjs');
      if (id === './ai-source-lifecycle.cjs') return { bindSummaryLifetime };
      if (id === './app-context.cjs') return { broadcastToAllWindows() {} };
      if (id === './version.cjs') return { getAppVersion: () => 'fixture' };
      if (id === 'electron') return { app: { getPath: () => assert.fail('No real profile access') }, shell: {} };
      if (id.startsWith('.')) return {};
      return require(id);
    },
  }, { filename });
  module.exports.register({ handle: (channel, callback) => handlers.set(channel, callback) });
  module.exports.setFixtureTask(task);
  return module.exports;
}

test('source cancellation, navigation and disposal revoke optional summaries without changing evidence', () => {
  const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false }), parent = new AbortController();
  const task = { sender: owner, signal: parent.signal, evidence: ['owned unchanged evidence'] };
  let lifetime = bindSummaryLifetime(task); parent.abort(); assert.equal(lifetime.signal.aborted, true); lifetime.dispose();
  delete task.signal;
  lifetime = bindSummaryLifetime(task); owner.emit('did-start-navigation', {}, 'reload', false, true); assert.equal(lifetime.signal.aborted, true); lifetime.dispose();
  lifetime = bindSummaryLifetime(task); lifetime.dispose(); assert.equal(lifetime.signal.aborted, true);
  assert.deepEqual(task.evidence, ['owned unchanged evidence']); assert.equal(task.aiSummaryController, undefined);
  assert.equal(owner.listenerCount('destroyed'), 0); assert.equal(owner.listenerCount('did-start-navigation'), 0);
});

for (const [name, cancelChannel] of [['inspection.cjs', 'inspection:cancel'], ['troubleshooting.cjs', 'troubleshooting:cancel'], ['performance-monitor.cjs', null]]) {
  test(`actual ${name} source cancellation removes an unapproved AI request`, async t => {
    const owner = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send() {} });
    const task = { id: 'fixture-task', deviceId: 'fixture-device', sender: owner, cancelled: false, steps: [], evidence: 'keep collected source data' };
    const lifetime = bindSummaryLifetime(task); t.after(() => lifetime.dispose());
    const transport = createOutboundTransport({ getOwner: () => owner, trustedOwner: () => owner, getEndpoint: () => 'https://fixture.invalid/v1/chat',
      membership: async () => ({ activated: true, scope: 'vip' }), prepare: async bodies => prepareBatch(bodies), request: () => assert.fail('A cancelled source must not create a model request') });
    t.after(() => transport.cleanup());
    const result = new Promise((resolve, reject) => {
      const request = transport.request({ hostname: 'fixture.invalid', path: '/v1/chat', method: 'POST', signal: lifetime.signal }, resolve);
      request.on('error', reject); request.end(JSON.stringify({ model: 'fixture', stream: false, messages: [{ role: 'user', content: task.evidence }] }));
    });
    const rejected = assert.rejects(result, { code: 'AI_SEND_CANCELLED' });
    await pending(transport.gate, owner);
    const preview = transport.gate.list(owner).pending[0];
    const handlers = new Map(), source = loadSource(name, task, handlers);
    if (cancelChannel) await handlers.get(cancelChannel)(); else source.cleanup();
    await rejected;
    assert.equal(transport.gate.list(owner).pending.length, 0);
    await assert.rejects(() => transport.gate.decide(owner, { previewId: preview.id, decision: 'send' }));
    assert.equal(task.evidence, 'keep collected source data');
  });
}

test('transport cleanup rejects late source jobs instead of resurrecting approval dialogs', async () => {
  const owner = { isDestroyed: () => false, send() {} };
  const transport = createOutboundTransport({ getOwner: () => owner, trustedOwner: () => owner, getEndpoint: () => 'https://fixture.invalid', membership: async () => ({}),
    prepare: async bodies => prepareBatch(bodies), request: () => assert.fail('No late network request') });
  transport.cleanup();
  assert.throws(() => transport.request({ method: 'POST' }, () => {}), { code: 'AI_SEND_CANCELLED' });
  assert.equal(transport.gate.list(owner).pending.length, 0);
});
