const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { createRouterConfig } = require('./ai-tools-router-config.cjs');
const { fail } = require('./ai-tools-file-safety.cjs');

function createAiToolsRouter({ getMembership, saveProvider, ...options }) {
  const config = createRouterConfig(options); let worker; let starting; let disposed = false; let port; let metrics = []; let requests = 0; let lastError = '';
  function snapshot() { return { ...config.snapshot(), running: Boolean(worker && !starting), starting: Boolean(starting), url: worker && port ? `http://127.0.0.1:${port}` : null, metrics, requests, error: lastError }; }
  function idle() { if (worker || starting) throw fail('AI_TOOLS_ROUTER_RUNNING', '请先停止路由再修改配置；不会自动打断正在执行的请求'); }
  async function start(value) {
    if (disposed) throw fail('AI_TOOLS_DISPOSED', '本地路由已退出');
    idle(); const prepared = config.prepare(value); lastError = ''; metrics = []; requests = 0;
    const workerPath = path.join(__dirname, 'ai-tools-router-worker.cjs').replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
    const instance = new Worker(workerPath, { workerData: { config: prepared }, resourceLimits: { maxOldGenerationSizeMb: 192 } }); worker = instance;
    starting = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { lastError = '本机路由启动超时'; void instance.terminate(); reject(fail('AI_TOOLS_ROUTER_TIMEOUT', lastError)); }, 15000);
      const failed = error => { clearTimeout(timeout); lastError = error.message; if (worker === instance) worker = null; reject(error); };
      instance.on('message', async message => {
        if (message.type === 'started') { clearTimeout(timeout); port = message.port; resolve(); }
        if (message.type === 'error') { failed(fail(message.code, message.message)); void instance.terminate(); }
        if (message.type === 'metrics') { metrics = message.metrics; requests = message.requests; }
        if (message.type === 'authorize') {
          let allowed = false;
          try { const status = await getMembership(); allowed = !disposed && status?.activated === true && status.scope === 'vip'; } catch { /* Fail closed; no upstream request. */ }
          if (worker === instance) instance.postMessage({ type: 'authorization', id: message.id, allowed });
        }
      });
      instance.on('error', () => failed(fail('AI_TOOLS_ROUTER_FAILED', '路由后台任务失败，请停止后重启')));
      instance.on('exit', code => { clearTimeout(timeout); if (worker === instance) worker = null; if (code) lastError = '路由后台任务意外退出'; reject(fail('AI_TOOLS_ROUTER_EXIT', '路由后台任务已退出')); });
    });
    try { await starting; } finally { starting = null; }
    return snapshot();
  }
  async function stop() {
    const instance = worker; if (!instance) return { stopped: true };
    await new Promise(resolve => { const timeout = setTimeout(() => { void instance.terminate(); }, 3000); instance.once('exit', () => { clearTimeout(timeout); resolve(); }); instance.postMessage({ type: 'stop' }); });
    if (worker === instance) worker = null; return { stopped: true };
  }
  function profile({ routeId, targetApps }) {
    if (!worker || starting) throw fail('AI_TOOLS_ROUTER_STOPPED', '请先启动本地路由');
    const route = config.snapshot().routes.find(row => row.id === routeId); if (!route) throw fail('AI_TOOLS_ROUTE_MISSING', '路由不存在');
    return saveProvider({ name: `本机路由 · ${route.name}`, protocol: route.protocol, baseUrl: `http://127.0.0.1:${port}/${route.protocol === 'gemini' ? 'v1beta' : 'v1'}`, model: route.model, apiKey: config.getKey(), targetApps });
  }
  return { snapshot, start, stop, profile, assertIdle: idle, getKey: () => config.getKey(),
    localModels(provider) {
      if (!worker || starting || provider.apiKey !== config.getKey() || provider.baseUrl !== `http://127.0.0.1:${port}/${provider.protocol === 'gemini' ? 'v1beta' : 'v1'}`) return null;
      return { models: config.snapshot().routes.filter(route => route.protocol === provider.protocol).map(route => ({ id: route.model, name: route.name })), checkedAt: Date.now(), latencyMs: 0, source: 'local-router' };
    },
    localProbe(provider) {
      if (!worker || starting || provider.apiKey !== config.getKey() || provider.baseUrl !== `http://127.0.0.1:${port}/${provider.protocol === 'gemini' ? 'v1beta' : 'v1'}`) return null;
      const route = config.snapshot().routes.find(row => row.protocol === provider.protocol && row.model === provider.model);
      if (!route) throw fail('AI_TOOLS_PROBE_LOCAL_ROUTE', '当前模型不对应已运行的同协议本地路由，未发送测试请求');
      if (route.failover !== false) throw fail('AI_TOOLS_PROBE_FAILOVER', '此本地路由启用了故障转移，无法保证只调用一次；请直接测试上游供应商，或停止路由并关闭故障转移后再测');
      return { routeId: route.id, model: route.model, protocol: route.protocol };
    },
    assertProviderMutable(id) { if (id && worker && config.snapshot().routes.some(route => route.providerIds.includes(id))) throw fail('AI_TOOLS_ROUTER_RUNNING', '该供应商正被本机路由使用，请先停止路由再修改或删除，避免旧密钥继续生效'); },
    save: value => { idle(); return config.save(value); }, remove: id => { idle(); return config.remove(id); },
    async dispose() { disposed = true; await stop(); } };
}

module.exports = { createAiToolsRouter };
