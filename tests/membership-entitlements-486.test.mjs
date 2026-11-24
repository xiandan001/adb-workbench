import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import { canUseMembershipFeature as rendererCheck } from '../src/shared/membershipEntitlements.js';

const require = createRequire(import.meta.url);
const { canUseMembershipFeature: mainCheck } = require('../electron/lib/membership-entitlements.cjs');
const legacy = { activated: true, scope: 'free', type: 'lifetime' };
const member = { activated: true, scope: 'vip', type: 'lifetime' };

test('renderer and main preserve historically activated grants and agree on AI and recovery', () => {
  const activatedOnly = ['devices', 'connection-history', 'packages', 'inspection', 'performance', 'log-rules', 'mcp'];
  const vipOnly = ['ai-analysis', 'ai-workspace', 'ai-tools'];
  for (const check of [rendererCheck, mainCheck]) {
    for (const capability of [...activatedOnly, ...vipOnly]) {
      for (const reason of ['no_token', 'expired', 'vip_status_failed', 'loading']) {
        assert.equal(check({ activated: false, scope: 'vip', reason }, capability), false);
      }
      assert.equal(check(legacy, capability), activatedOnly.includes(capability));
      assert.equal(check(member, capability), true);
    }
    assert.equal(check(null, 'recovery'), true);
    assert.equal(check(member, '__proto__'), false);
  }
});

test('the renderer refreshes on focus and the exact subscription boundary without polling', async () => {
  const now = 100_015;
  let current;
  let status = { ...member, type: 'subscription', expiresAt: 100 };
  let reads = 0;
  const revision = { current: 0 };
  const effects = [];
  const listeners = new Map();
  const timers = [];
  const source = readFileSync(new URL('../src/shared/useMembershipStatus.js', import.meta.url), 'utf8')
    .replace(/^import .+;\r?\n/gm, '').replace('export default function', 'function');
  const hook = runInNewContext(source + '\nuseMembershipStatus;', {
    Date: { now: () => now },
    useState: initial => [current ?? initial, next => { current = next; }],
    useRef: () => revision,
    useCallback: callback => callback,
    useEffect: callback => effects.push(callback),
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); },
    clearTimeout() {},
    window: {
      electronAPI: { async vipGetStatus() { reads += 1; return status; } },
      addEventListener: (name, callback) => listeners.set(name, callback),
      removeEventListener: name => listeners.delete(name),
    },
  });
  hook();
  const cleanup = effects.shift()();
  effects.shift()();
  await new Promise(setImmediate);
  assert.equal(current.scope, 'vip');
  assert.equal(reads, 1);
  await listeners.get('focus')();
  assert.equal(reads, 2);
  hook();
  effects.pop()();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 985);
  status = { activated: false, scope: 'free', reason: 'expired' };
  await timers[0].callback();
  assert.equal(reads, 3);
  assert.equal(current.reason, 'expired');
  cleanup();
  assert.equal(listeners.has('focus'), false);
});

function mcpFixture(initial) {
  let status = initial;
  const servers = [];
  const handlers = new Map();
  const timers = new Map();
  const filename = new URL('../electron/lib/mcp-server.cjs', import.meta.url);
  const module = { exports: {} };
  const requireModule = createRequire(filename);
  const later = callback => {
    const timer = { unref() {} };
    timers.set(timer, callback);
    return timer;
  };
  runInNewContext(readFileSync(filename, 'utf8'), {
    module, console: { log() {}, error() {} },
    setTimeout: later, clearTimeout: timer => timers.delete(timer),
    setInterval: () => ({ unref() {} }), clearInterval() {},
    require: name => {
      if (name === 'http') return { createServer() {
        const server = new EventEmitter();
        server.listen = (_port, _host, ready) => queueMicrotask(() => {
          if (!server.closed) { server.listening = true; ready(); }
        });
        server.close = () => { server.closed = true; server.listening = false; server.emit('close'); };
        server.closeAllConnections = () => { server.disconnected = true; };
        servers.push(server);
        return server;
      } };
      if (name === './vip.cjs') return { getStatusAsync: async () => status };
      if (name === './localization.cjs') return { tr: value => value };
      if (name === './ai-analyze.cjs') return { aiKeys: {} };
      if (name === './version.cjs') return { getAppVersion: () => 'fixture' };
      if (name === './membership-entitlements.cjs' || !name.startsWith('.')) return requireModule(name);
      return {};
    },
  }, { filename: filename.pathname });
  module.exports.register({ handle: (name, callback) => handlers.set(name, callback) });
  return { ...module.exports, servers, timers,
    status(next) { status = next; },
    invoke: name => handlers.get('mcp:' + name)(),
  };
}

test('MCP never listens at launch without authorization and activation alone does not start it', async () => {
  const f = mcpFixture({ activated: false, reason: 'no_token' });
  assert.equal(await f.initMcpServer(), false);
  assert.equal(f.servers.length, 0);
  f.status(legacy);
  assert.equal(f.synchronizeMcpMembership(legacy), false);
  assert.equal(f.servers.length, 0);
  assert.equal((await f.invoke('start')).running, true);
  assert.equal((await f.invoke('getInfo')).running, true);
  assert.equal(f.servers.length, 1);
  await f.invoke('stop');
  assert.equal(f.synchronizeMcpMembership(legacy), false);
  assert.equal((await f.invoke('getInfo')).running, false);
  assert.equal(f.servers.length, 1);
});

test('existing grants still start MCP at launch and the service stops when the signed term expires', async () => {
  const f = mcpFixture({ ...legacy, type: 'subscription', expiresAt: Math.floor(Date.now() / 1000) + 30 });
  assert.equal(await f.initMcpServer(), true);
  assert.equal(f.timers.size, 1);
  f.status({ activated: false, reason: 'expired' });
  await [...f.timers.values()][0]();
  assert.equal((await f.invoke('getInfo')).running, false);
  assert.equal(f.servers[0].disconnected, true);
  assert.equal(f.timers.size, 0);
  assert.equal((await f.invoke('start')).code, 'vip_required');
});

test('manual stop wins over an authorization check still in flight at startup', async () => {
  const f = mcpFixture(member);
  const startup = f.initMcpServer();
  await f.invoke('stop');
  assert.equal(await startup, false);
  assert.equal(f.servers.length, 0);
});
