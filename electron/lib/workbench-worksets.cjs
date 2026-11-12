const fs = require('node:fs/promises'), path = require('node:path'), { randomUUID } = require('node:crypto');
const policy = require('./workbench-worksets-policy.cjs');
const { atomicWriteAsync } = require('./ai-workspace-store-async.cjs');
const { tr } = require('./localization.cjs');

function createWorksetStore({ directory, io = fs, persist = atomicWriteAsync, uuid = randomUUID, now = Date.now }) {
  const root = path.resolve(directory), file = path.join(root, policy.FILE_NAME);
  let queue = Promise.resolve();
  async function read() {
    let stat;
    try { stat = await io.lstat(file); } catch (error) { if (error.code === 'ENOENT') return policy.emptyStore(); throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > policy.MAX_BYTES) throw new Error(tr('工作集数据无效，原文件已保留。'));
    const handle = await io.open(file, 'r');
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > policy.MAX_BYTES) throw new Error(tr('工作集数据无效，原文件已保留。'));
      const content = await handle.readFile('utf8');
      if (Buffer.byteLength(content, 'utf8') > policy.MAX_BYTES) throw new Error(tr('工作集数据无效，原文件已保留。'));
      try { return policy.normalizeStore(JSON.parse(content)); }
      catch { throw new Error(tr('工作集数据无效，原文件已保留。')); }
    } finally { await handle.close(); }
  }
  function mutate(action) {
    const pending = queue.catch(() => {}).then(async () => {
      const previous = await read(), next = policy.normalizeStore(action(previous));
      if (JSON.stringify(previous) !== JSON.stringify(next)) {
        await io.mkdir(root, { recursive: true });
        if (path.resolve(await io.realpath(root)) !== root) throw new Error(tr('工作集数据无效，原文件已保留。'));
        await persist(file, JSON.stringify(next) + '\n', { io });
      }
      return next;
    });
    queue = pending; return pending;
  }
  return {
    read,
    remember(part, value) { const normalized = policy.normalizePart(part, value); return mutate(previous => ({ ...previous, context: { ...previous.context, [part]: normalized } })); },
    save(input) {
      const args = policy.normalizeSave(input);
      return mutate(previous => {
        const old = args.id ? previous.items.find(item => item.id === args.id) : null;
        if (args.id && !old) throw new Error(tr('工作集已不存在，请刷新后重试。'));
        const date = new Date(now()).toISOString();
        const item = policy.normalizeWorkset({ ...args, id: old?.id || uuid(), logs: previous.context.logs?.deviceId === args.deviceId ? previous.context.logs : null,
          ssh: previous.context.ssh, serial: previous.context.serial, createdAt: old?.createdAt || date, updatedAt: date });
        return { ...previous, items: [item, ...previous.items.filter(value => value.id !== item.id)] };
      });
    },
    remove(id) {
      if (typeof id !== 'string') return Promise.reject(new Error(tr('工作集数据无效，原文件已保留。')));
      return mutate(previous => {
        if (!previous.items.some(item => item.id === id)) throw new Error(tr('工作集已不存在，请刷新后重试。'));
        return { ...previous, items: previous.items.filter(item => item.id !== id) };
      });
    }
  };
}

function register(ipcMain, dependencies = {}) {
  const ctx = dependencies.context || require('./app-context.cjs');
  const store = dependencies.store || createWorksetStore({ directory: require('electron').app.getPath('userData') });
  const unavailable = new Set();
  const revisions = { application: 0, logs: 0, ssh: 0, serial: 0 };
  for (const method of ['list', 'save', 'remove', 'remember']) ipcMain.handle(`worksets:${method}`, async (event, args) => {
    const main = ctx.getMainWindow(), log = ctx.getLogAnalyzerWindow();
    const owns = window => window && !window.isDestroyed() && window.webContents === event.sender && event.senderFrame === window.webContents.mainFrame;
    if (!owns(main) && !(method === 'remember' && args?.part === 'logs' && owns(log))) return { ok: false, error: tr('只允许在应用窗口管理工作集。') };
    const part = method === 'remember' && Object.hasOwn(revisions, args?.part) ? args.part : null;
    const revision = part ? ++revisions[part] : 0;
    if (part) unavailable.add(part);
    try {
      let result;
      if (method === 'list') result = await store.read();
      else if (method === 'save') {
        if (unavailable.size) throw new Error(tr('部分调试配置尚未保存，请在对应页面重试后再保存工作集。'));
        result = await store.save(args);
      }
      else if (method === 'remove') {
        if (!args || Object.keys(args).join(',') !== 'id') throw new Error(tr('工作集数据无效，原文件已保留。'));
        result = await store.remove(args.id);
      } else {
        if (!args || Object.keys(args).sort().join(',') !== 'part,value') throw new Error(tr('工作集数据无效，原文件已保留。'));
        result = await store.remember(args.part, args.value);
        if (part && revisions[part] === revision) unavailable.delete(part);
      }
      return method === 'remember' ? { ok: true } : { ok: true, items: result.items, context: result.context };
    } catch (error) {
      if (part && revisions[part] === revision) unavailable.add(part);
      return { ok: false, error: error.message };
    }
  });
  return store;
}
module.exports = { createWorksetStore, register };
