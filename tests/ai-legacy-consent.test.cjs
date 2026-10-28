const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createOutboundTransport } = require('../electron/lib/ai-outbound-transport.cjs');
const { prepareBatch } = require('../electron/lib/ai-outbound-policy.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let index = 0; index < 200; index++) { if (predicate()) return; await tick(); } assert.fail('Legacy fixture did not settle'); }
function fixture({ map = false, status = 200 } = {}) {
  const events = [], calls = [], handlers = new Map();
  const owner = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send: (channel, payload) => events.push({ channel, payload }) });
  const entries = Array.from({ length: 1203 }, (_, index) => ({ id: `row-${index}`, raw: `log ${index} password=raw-private`, message: `log ${index} password=raw-private`, ts: 1, level: 'E', tag: 'Fixture' }));
  const transport = createOutboundTransport({ getOwner: () => owner,
    trustedOwner: event => event.sender === owner && event.senderFrame === owner.mainFrame ? owner : null,
    getEndpoint: () => 'https://builtin.fixture/v1/chat', membership: async () => ({ activated: true, scope: 'vip' }), prepare: async bodies => prepareBatch(bodies),
    request: (options, callback) => {
      const req = new EventEmitter(); req.setTimeout = () => req;
      req.destroy = error => queueMicrotask(() => req.emit('error', error));
      req.end = body => {
        const payload = JSON.parse(body); calls.push(payload);
        setImmediate(() => {
          const response = new EventEmitter(); response.statusCode = status; response.headers = {}; response.destroy = () => {}; response.resume = () => {};
          callback(response);
          const usage = { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 };
          if (payload.stream) {
            response.emit('data', Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: 'fixture streamed answer' } }] }) + '\n\n'));
            response.emit('data', Buffer.from('data: ' + JSON.stringify({ usage }) + '\n\ndata: [DONE]\n\n'));
          } else {
            const content = JSON.stringify({ keywords: ['log'], matchedLines: [0], explanation: 'fixture match', summary: 'password=derived-private' });
            response.emit('data', Buffer.from(JSON.stringify({ choices: [{ message: { content } }], usage })));
          }
          response.emit('end');
        });
      };
      return req;
    } });
  const keys = { AGNES_API_URL: 'https://builtin.fixture/v1/chat', AGNES_API_KEY: 'fixture-key', AGNES_API_KEYS: ['fixture-key'], AGNES_MODEL: 'fixture-model',
    AI_MAX_LOG_LINES: 100000, AI_MAX_CONTEXT_MESSAGES: 10, AI_MAX_CONTEXT_BYTES: 2 * 1024 * 1024, AI_BYTES_PER_TOKEN: 3,
    AI_CHUNK_LINES: 2, AI_MAPREDUCE_THRESHOLD_BYTES: map ? 1 : 1024 * 1024, AI_MAPREDUCE_MAX_CHUNKS: 4,
    AI_CONTEXT_COMPRESS_THRESHOLD: 2 * 1024 * 1024, AI_COMPRESSED_MSG_MAX_BYTES: 8192, AI_MODEL_MAX_CONTEXT_TOKENS: 524288,
    getAgnesKeyIndex: () => 0, getNextApiKey: () => { assert.fail('Automatic retry must not run'); } };
  const modules = new Map();
  function load(name, expose = '') {
    if (modules.has(name)) return modules.get(name);
    const module = { exports: {} }; modules.set(name, module.exports);
    const file = path.join(__dirname, '../electron/lib', name);
    vm.runInNewContext(fs.readFileSync(file, 'utf8') + expose, { module, Buffer, AbortController, URL, setTimeout, clearTimeout, setInterval, clearInterval,
      console: { log() {}, warn() {}, error() {} }, require: request => {
        if (request === './ai-outbound-transport.cjs') return transport;
        if (request === './ai-keys.cjs') return keys;
        if (request === './ai-analyze.cjs') return load('ai-analyze.cjs');
        if (request === './localization.cjs') return require('../electron/lib/localization.cjs');
        if (request === './analysis-language.cjs') return require('../electron/lib/analysis-language.cjs');
        if (request.includes('/shared/filter')) return { filterEntries: rows => rows };
        if (request === './log-analyzer.cjs') return { getLogStore: () => ({ realtime: entries }), getCurrentLogSource: () => 'realtime', getLogcatProc: () => null };
        if (request === './version.cjs') return { getAppVersion: () => 'fixture' };
        if (request === './vip.cjs') return { getStatusAsync: async () => ({ activated: true, scope: 'vip' }) };
        if (request === './app-context.cjs') return {};
        if (request === 'electron') return { app: { getPath: () => assert.fail('No real profile access') }, dialog: {} };
        if (request.startsWith('.')) return {};
        return require(request);
      } }, { filename: file });
    modules.set(name, module.exports); return module.exports;
  }
  const api = load('ai-analyze.cjs'); api.register({ handle: (name, fn) => handlers.set(name, fn) });
  const event = { sender: owner, senderFrame: owner.mainFrame };
  async function pending() { await until(() => transport.gate.list(owner).pending.length > 0); return transport.gate.list(owner).pending[0]; }
  async function decide(value, decision = 'send') {
    if (decision === 'send') for (let index = 0; index < value.requestCount; index++) transport.gate.get(owner, { previewId: value.id, index });
    return transport.gate.decide(owner, { previewId: value.id, decision });
  }
  return { api, load, entries, transport, owner, calls, handlers, event, events, pending, decide };
}

test('actual legacy streamed analysis cannot send before consent and emits request-bound events', async t => {
  const f = fixture(); t.after(() => f.transport.cleanup());
  assert.equal((await f.handlers.get('ai:analyzeLog')({ sender: f.owner, senderFrame: {} }, { lines: ['forged'] })).ok, false);
  const result = await f.handlers.get('ai:analyzeLog')(f.event, { lines: ['password=raw-private'], customPrompt: 'token=question-private' });
  assert.equal(result.ok, true); const preview = await f.pending(); assert.equal(f.calls.length, 0);
  await f.decide(preview); await until(() => f.events.some(event => event.channel === 'ai:streamEnd'));
  assert.equal(f.calls.length, 1); assert.ok(!JSON.stringify(f.calls).includes('raw-private'));
  assert.ok(!JSON.stringify(f.calls).includes('question-private'));
  assert.ok(f.events.find(event => event.channel === 'ai:streamChunk').payload.requestId);
});

test('actual legacy Map-Reduce keeps chunks but derived summary waits for its own complete preview', async t => {
  const f = fixture({ map: true }); t.after(() => f.transport.cleanup());
  const started = f.handlers.get('ai:analyzeLog')(f.event, { lines: ['one password=raw-private', 'two', 'three', 'four', 'five'] });
  const maps = await f.pending(); assert.equal(maps.requestCount, 3); assert.equal(f.calls.length, 0);
  await f.decide(maps);
  await until(() => f.transport.gate.list(f.owner).pending.some(item => item.id !== maps.id));
  const reduce = f.transport.gate.list(f.owner).pending[0];
  assert.equal(f.calls.length, 3);
  assert.ok(!JSON.stringify(f.transport.gate.get(f.owner, { previewId: reduce.id })).includes('derived-private'));
  await f.decide(reduce); await started;
  await until(() => f.events.some(event => event.channel === 'ai:streamEnd'));
  assert.equal(f.calls.length, 4);
});

test('actual smart search separately previews keywords, then a fixed bounded concurrent chunk batch', async t => {
  const f = fixture(); t.after(() => f.transport.cleanup());
  f.load('smart-search.cjs').register({ handle: (name, fn) => f.handlers.set(name, fn) });
  const result = f.handlers.get('smart-search:search')(f.event, { query: 'log token=query-private', source: 'realtime', entryIds: f.entries.map(entry => entry.id) });
  const keywords = await f.pending(); assert.equal(f.calls.length, 0); await f.decide(keywords);
  await until(() => f.transport.gate.list(f.owner).pending.some(item => item.id !== keywords.id));
  const chunks = f.transport.gate.list(f.owner).pending[0]; assert.equal(chunks.requestCount, 3); assert.equal(f.calls.length, 1);
  await f.decide(chunks); assert.equal((await result).ok, true);
  assert.equal(f.calls.length, 4); assert.ok(!JSON.stringify(f.calls).includes('raw-private'));
});

test('actual diagnostic and generic job summary cancellation perform no model call and preserve callers result flow', async t => {
  const f = fixture(); t.after(() => f.transport.cleanup());
  f.load('auto-diagnose.cjs').register({ handle: (name, fn) => f.handlers.set(name, fn) });
  await f.handlers.get('auto-diagnose:analyze')(f.event, { issues: [{ label: 'Crash', severity: 'fatal', context: 'password=raw-private' }] });
  await f.decide(await f.pending(), 'cancel'); await tick(); assert.equal(f.calls.length, 0);
  const original = { report: 'synthetic completed evidence' };
  const summary = f.api.generateAiSummary({ systemPrompt: 'fixture report summary', userContent: original.report });
  await f.decide(await f.pending(), 'cancel');
  assert.equal((await summary).cancelled, true); assert.equal(original.report, 'synthetic completed evidence'); assert.equal(f.calls.length, 0);
});

test('actual MCP AI tool is independently gated and cannot authorize itself or retry server errors', async t => {
  const f = fixture({ status: 500 }); t.after(() => f.transport.cleanup());
  const mcp = f.load('mcp-server.cjs', '\nmodule.exports.callMcpTool = callMcpTool;');
  const response = mcp.callMcpTool('ai_analyze', { source: 'realtime' });
  const preview = await f.pending(); assert.equal(f.calls.length, 0);
  await f.decide(preview); const result = await response;
  assert.ok(result); assert.equal(f.calls.length, 1);
});
