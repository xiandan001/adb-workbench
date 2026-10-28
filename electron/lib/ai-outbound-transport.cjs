const { EventEmitter } = require('node:events');
const { AsyncLocalStorage } = require('node:async_hooks');
const { StringDecoder } = require('node:string_decoder');
const { createOutboundGate, cancelled } = require('./ai-outbound-gate.cjs');
const { LIMITS, fail, readUsage } = require('./ai-outbound-policy.cjs');
const { prepareOutbound } = require('./ai-outbound-processor.cjs');
const { tr, getLocale } = require('./localization.cjs');

function createOutboundTransport({ request, getOwner, trustedOwner, getEndpoint, membership, prepare = prepareOutbound, activity = {} }) {
  const context = new AsyncLocalStorage(), watched = new WeakSet(), latest = new WeakMap();
  const gate = createOutboundGate({ prepare, membership, activity,
    publish: owner => owner.send('ai-outbound:changed', { operations: gate.list(owner).operations }) });
  function watch(owner) {
    if (!owner || owner.isDestroyed()) throw fail('AI_SEND_OWNER', tr('AI 发送窗口已关闭，未发送。'));
    if (!watched.has(owner)) {
      watched.add(owner); owner.once?.('destroyed', () => gate.discardOwner(owner));
      owner.on?.('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) gate.discardOwner(owner); });
    }
    return owner;
  }
  function operation(meta = {}, owner = getOwner()) { return gate.begin(watch(owner), { ...meta, locale: getLocale() }); }
  function withOperation(meta, action, owner) {
    const op = operation(meta, owner);
    const abort = () => gate.cancel(op);
    meta?.signal?.addEventListener('abort', abort, { once: true });
    if (meta?.signal?.aborted) abort();
    return Promise.resolve().then(() => context.run({ operation: op }, action)).then(result => {
      gate.finishProducer(op, result?.ok === false); return result;
    }, error => { gate.finishProducer(op, true); throw error; }).finally(() => meta?.signal?.removeEventListener('abort', abort));
  }
  function withBatch(title, action, concurrency = 3) {
    const current = context.getStore();
    if (!current) return withOperation({ title, kind: 'summary' }, () => withBatch(title, action, concurrency));
    const batch = gate.batch(current.operation, title, concurrency);
    return context.run({ ...current, batch }, action);
  }
  function eventOwner(event) {
    const owner = trustedOwner(event);
    if (!owner) throw fail('AI_SEND_OWNER', tr('仅允许在应用主窗口或日志窗口确认 AI 发送。'));
    return watch(owner);
  }
  async function runEvent(event, meta, action) {
    const owner = eventOwner(event);
    const group = meta.kind === 'search' ? 'search' : 'analysis';
    gate.cancelOwned(owner, group === 'search' ? ['search'] : ['analysis', 'diagnostic']);
    const op = operation(meta, owner);
    const active = latest.get(owner) || {}; active[group] = op; latest.set(owner, active);
    const sender = new Proxy(owner, { get(target, property) {
      if (property === 'send') return (channel, payload = {}) => {
        if (latest.get(owner)?.[group] !== op || owner.isDestroyed()) return;
        if (op.controller.signal.aborted && !/streamEnd|streamError|complete$/.test(channel)) return;
        owner.send(channel, { ...payload, requestId: op.id });
      };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    try {
      const result = await context.run({ operation: op }, () => action({ ...event, sender }));
      gate.finishProducer(op, result?.ok === false); return result;
    } catch (error) {
      gate.finishProducer(op, true);
      return { ok: false, code: error.code, cancelled: error.name === 'AbortError', error: error.message };
    }
  }
  class GuardedRequest extends EventEmitter {
    constructor(options, callback) {
      super(); this.options = options; this.callback = callback; this.parts = []; this.bytes = 0;
      const current = context.getStore();
      this.operation = current?.operation || operation({ title: tr('AI 总结发送预览'), kind: 'summary' });
      this.batch = current?.batch; this.implicit = !current;
      this.onAbort = () => this.destroy(cancelled());
      options.signal?.addEventListener('abort', this.onAbort, { once: true });
      this.operation.controller.signal.addEventListener('abort', this.onAbort, { once: true });
    }
    write(value) {
      if (this.destroyed || this.ended) return false;
      const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
      this.bytes += Buffer.byteLength(text);
      if (this.bytes > LIMITS.requestBytes) { this.destroy(fail('AI_SEND_LIMIT', tr('AI 请求超过 1.25 MiB，请缩小筛选范围；未发送或静默截断。'))); return false; }
      this.parts.push(text); return true;
    }
    end(value) {
      if (value !== undefined) this.write(value);
      if (this.ended) return this;
      this.ended = true;
      if (this.options.signal?.aborted || this.operation.controller.signal.aborted) this.destroy(cancelled());
      if (!this.destroyed) {
        const body = this.parts.join(''); this.parts = [];
        gate.submit(this.operation, this.batch, body, (prepared, signal) => this.start(prepared, signal))
          .catch(error => this.destroy(error)).finally(() => this.removeAbortListeners());
      }
      if (this.implicit) gate.finishProducer(this.operation, Boolean(this.destroyed));
      return this;
    }
    removeAbortListeners() {
      this.options.signal?.removeEventListener('abort', this.onAbort);
      this.operation.controller.signal.removeEventListener('abort', this.onAbort);
    }
    destroy(error = cancelled()) {
      if (this.destroyed) return this;
      this.destroyed = true; this.parts = []; this.removeAbortListeners();
      if (error.name === 'AbortError' && !this.operation.controller.signal.aborted) gate.cancel(this.operation);
      else if (error.name !== 'AbortError') { this.operation.failed = true; this.operation.error = error.message; }
      this.real?.destroy(error);
      this.stop?.(error);
      queueMicrotask(() => this.emit('error', error));
      return this;
    }
    abort() { return this.destroy(cancelled()); }
    setTimeout(milliseconds, callback) { this.timeout = milliseconds; if (callback) this.on('timeout', callback); this.real?.setTimeout(milliseconds); return this; }
    start(body, signal) {
      return new Promise((resolve, reject) => {
        if (this.destroyed || signal.aborted) { reject(cancelled()); return; }
        const endpoint = new URL(getEndpoint());
        if (endpoint.protocol !== 'https:' || this.options.hostname !== endpoint.hostname || (this.options.path || '/') !== endpoint.pathname + endpoint.search
          || this.options.method !== 'POST' || Number(this.options.port || 443) !== Number(endpoint.port || 443)) {
          reject(fail('AI_SEND_ENDPOINT', tr('AI 目标地址与内置服务不匹配，未发送。'))); return;
        }
        let settled = false, responseBytes = 0, usage = null, text = '', response;
        const decoder = new StringDecoder('utf8');
        const finish = (error, result) => {
          if (settled) return; settled = true;
          clearTimeout(timer); this.stop = null;
          if (error) { response?.destroy?.(); reject(error); } else resolve(result);
        };
        this.stop = error => finish(error);
        const timer = setTimeout(() => this.destroy(fail('AI_SEND_TIMEOUT', tr('AI 请求超时，未自动重试。'))), 120000);
        try {
          this.real = request({ ...this.options, signal,
            headers: { ...this.options.headers, 'Content-Length': Buffer.byteLength(body) } }, res => {
            response = res;
            const streaming = String(res.headers?.['content-type'] || '').includes('event-stream') || JSON.parse(body).stream;
            res.on('data', chunk => {
              responseBytes += chunk.length;
              if (responseBytes > LIMITS.responseBytes) { this.destroy(fail('AI_SEND_RESPONSE_LIMIT', tr('AI 回复超过大小限制，请缩小问题范围。'))); return; }
              text += decoder.write(chunk);
              if (streaming) {
                const lines = text.split('\n'); text = lines.pop();
                for (const line of lines) if (line.startsWith('data:')) {
                  try { usage = readUsage(JSON.parse(line.slice(5).trim()).usage) || usage; } catch { /* SSE keepalive or DONE. */ }
                }
              }
            });
            res.once('error', error => finish(error));
            res.once('end', () => {
              if (!streaming) { try { usage = readUsage(JSON.parse(text + decoder.end()).usage); } catch { /* Caller reports invalid JSON. */ } }
              finish(null, { ok: res.statusCode === 200, usage });
            });
            this.callback(res);
          });
          this.real.once('error', error => finish(error));
          this.real.on('timeout', () => this.emit('timeout'));
          if (this.timeout) this.real.setTimeout(this.timeout);
          this.emit('ai:authorized');
          if (!this.destroyed && !signal.aborted) this.real.end(body);
        } catch (error) { finish(error); }
      });
    }
  }
  const sendChannels = {
    'ai:analyzeLog': { kind: 'analysis', title: () => tr('AI 日志分析') },
    'auto-diagnose:analyze': { kind: 'diagnostic', title: () => tr('AI 异常诊断') },
    'smart-search:search': { kind: 'search', title: () => tr('AI 智能搜索') },
  };
  function protectIpc(ipcMain) {
    return new Proxy(ipcMain, { get(target, property) {
      if (property !== 'handle') { const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value; }
      return (channel, callback) => target.handle(channel, async (event, args) => {
        if (!Object.hasOwn(sendChannels, channel) && !/^ai:|^smart-search:stop$/.test(channel)) return callback(event, args);
        try {
          const owner = eventOwner(event);
          if (sendChannels[channel]) return runEvent(event, { kind: sendChannels[channel].kind, title: sendChannels[channel].title() }, wrapped => callback(wrapped, args));
          if (channel === 'ai:stopAnalyze' || channel === 'ai:clearConversation') gate.cancelOwned(owner, ['analysis', 'diagnostic']);
          if (channel === 'smart-search:stop') gate.cancelOwned(owner, ['search']);
          return callback(event, args);
        } catch (error) { return { ok: false, code: error.code, error: error.message }; }
      });
    } });
  }
  function register(ipcMain) {
    for (const [name, action] of Object.entries({ list: (owner) => ({ ok: true, ...gate.list(owner) }),
      get: (owner, args) => ({ ok: true, preview: gate.get(owner, args) }), decide: (owner, args) => gate.decide(owner, args) })) {
      ipcMain.handle(`ai-outbound:${name}`, async (event, args) => {
        try { return await action(eventOwner(event), args); }
        catch (error) { return { ok: false, code: error.code, error: error.message }; }
      });
    }
  }
  return { request: (options, callback) => new GuardedRequest(options, callback), withBatch, withOperation, protectIpc, register,
    cleanup: () => gate.cleanup(), gate };
}

let singleton;
function runtime() {
  if (!singleton) {
    const ctx = require('./app-context.cjs');
    singleton = createOutboundTransport({ request: require('node:https').request, getOwner: () => ctx.getMainWindow()?.webContents,
      trustedOwner: event => [ctx.getMainWindow(), ctx.getLogAnalyzerWindow()].find(window => window && !window.isDestroyed()
        && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame)?.webContents,
      getEndpoint: () => require('./ai-keys.cjs').AGNES_API_URL, membership: () => require('./vip.cjs').getStatusAsync(),
      activity: require('./workbench-activity.cjs') });
  }
  return singleton;
}
module.exports = { createOutboundTransport, request: (...args) => runtime().request(...args),
  withBatch: (...args) => runtime().withBatch(...args), withOperation: (...args) => runtime().withOperation(...args),
  protectIpc: (...args) => runtime().protectIpc(...args), register: (...args) => runtime().register(...args), cleanup: () => singleton?.cleanup() };
