const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function createDeviceMediaStore({ directory, shell, nativeImage, clipboard, onChange = () => {}, maxItems = 500 }) {
  const indexPath = path.join(directory, 'device-media-history.json');
  let queue = Promise.resolve();

  async function read() {
    try {
      const stat = await fs.promises.lstat(indexPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error('最近文件索引无效，请保留原文件后检查');
      const data = JSON.parse(await fs.promises.readFile(indexPath, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.items) || data.items.some(item => !validItem(item))) throw new Error('最近文件索引格式无效');
      return data.items;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async function resolveFile(item, log = false) {
    const file = log ? item.logPath : item.path;
    const expected = log ? item.logRealPath : item.realPath;
    if (!file || !expected) throw new Error('文件未记录或已不存在');
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || await fs.promises.realpath(file) !== expected) throw new Error('文件位置已变化，请从保存目录检查');
    return { path: file, stat };
  }

  async function save(items) {
    await fs.promises.mkdir(directory, { recursive: true });
    const temporary = `${indexPath}.${randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(temporary, JSON.stringify({ version: 1, items }), { flag: 'wx' });
      await fs.promises.rename(temporary, indexPath);
    } finally { await fs.promises.unlink(temporary).catch(() => {}); }
  }

  async function addNow(input) {
    if (!['image', 'video'].includes(input.type) || typeof input.deviceId !== 'string' || !input.deviceId) throw new Error('媒体类型或设备无效');
    const file = path.resolve(input.path);
    if (!(input.type === 'image' ? /\.png$/i : /\.mp4$/i).test(file)) throw new Error('不支持的媒体文件类型');
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) throw new Error('媒体文件不存在或内容为空');
    const items = await read();
    const item = {
      id: randomUUID(), type: input.type, deviceId: input.deviceId, path: file,
      realPath: await fs.promises.realpath(file), name: path.basename(file), bytes: stat.size,
      createdAt: Number.isFinite(input.createdAt) ? input.createdAt : Date.now(),
      ...(Number.isFinite(input.durationMs) ? { durationMs: Math.max(0, input.durationMs) } : {})
    };
    if (input.logPath) {
      const logPath = path.resolve(input.logPath);
      if (path.dirname(logPath) !== path.dirname(file) || path.extname(logPath).toLowerCase() !== '.log') throw new Error('关联日志必须位于录屏保存目录');
      const logStat = await fs.promises.lstat(logPath);
      if (!logStat.isFile() || logStat.isSymbolicLink()) throw new Error('关联日志文件无效');
      Object.assign(item, { logPath, logRealPath: await fs.promises.realpath(logPath), logBytes: logStat.size, logTruncated: input.logTruncated === true });
    }
    if (input.logError) item.logError = String(input.logError).slice(0, 1000);
    // Limit metadata only. Original screenshots, videos and logs are never deleted here.
    const next = [item, ...items.filter(entry => entry.realPath !== item.realPath)].sort((a, b) => b.createdAt - a.createdAt).slice(0, maxItems);
    await save(next);
    onChange({ deviceId: item.deviceId });
    return { ...item, exists: true };
  }

  return {
    add(input) {
      const task = queue.then(() => addNow(input));
      queue = task.catch(() => {});
      return task;
    },
    async list({ deviceId } = {}) {
      await queue;
      const items = (await read()).filter(item => !deviceId || item.deviceId === deviceId).slice(0, 10);
      return Promise.all(items.map(async item => {
        try { await resolveFile(item); return { ...item, exists: true }; }
        catch { return { ...item, exists: false }; }
      }));
    },
    async perform({ id, action } = {}) {
      if (!['open', 'folder', 'copy', 'log'].includes(action)) throw new Error('无效的文件操作');
      await queue;
      const item = (await read()).find(entry => entry.id === id);
      if (!item) throw new Error('该文件不在最近记录中，请从保存目录查看');
      if (action === 'folder') {
        try { await resolveFile(item); shell.showItemInFolder(item.path); }
        catch {
          const parent = path.dirname(item.path);
          if (await fs.promises.realpath(parent) !== path.dirname(item.realPath)) throw new Error('保存目录已变化');
          const error = await shell.openPath(parent);
          if (error) throw new Error(error);
        }
        return;
      }
      const target = await resolveFile(item, action === 'log');
      if (action === 'copy') {
        if (item.type !== 'image') throw new Error('只有截图可以复制为图片');
        const image = nativeImage.createFromPath(target.path);
        if (image.isEmpty()) throw new Error('截图无法读取');
        clipboard.writeImage(image);
      } else {
        const error = await shell.openPath(target.path);
        if (error) throw new Error(error);
      }
    }
  };
}

function validItem(item) {
  return item && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(item.id) && ['image', 'video'].includes(item.type)
    && typeof item.deviceId === 'string' && typeof item.path === 'string' && path.isAbsolute(item.path)
    && typeof item.realPath === 'string' && typeof item.name === 'string' && Number.isFinite(item.createdAt)
    && Number.isFinite(item.bytes) && (item.type === 'image' ? /\.png$/i : /\.mp4$/i).test(item.path)
    && (!item.logPath || (typeof item.logPath === 'string' && path.isAbsolute(item.logPath) && /\.log$/i.test(item.logPath)
      && path.dirname(item.logPath) === path.dirname(item.path) && typeof item.logRealPath === 'string'));
}

let store;
function getStore() {
  if (!store) {
    const { app, shell, nativeImage, clipboard } = require('electron');
    store = createDeviceMediaStore({ directory: app.getPath('userData'), shell, nativeImage, clipboard,
      onChange: payload => require('./app-context.cjs').broadcastToAllWindows('device-media:changed', payload) });
  }
  return store;
}
function recordMedia(input) { return getStore().add(input); }
function register(ipcMain) {
  ipcMain.handle('device-media:list', async (_event, args) => {
    try { return { success: true, items: await getStore().list(args) }; }
    catch (error) { return { success: false, items: [], error: error.message }; }
  });
  ipcMain.handle('device-media:action', async (_event, args) => {
    try { await getStore().perform(args); return { success: true }; }
    catch (error) { return { success: false, error: error.message }; }
  });
}

module.exports = { createDeviceMediaStore, recordMedia, register };
