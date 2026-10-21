const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function createDeviceMediaStore({ directory, shell, nativeImage, clipboard, onChange = () => {}, maxItems = 500 }) {
  const indexPath = path.join(directory, 'device-media-history.json');
  const itemLimit = Number.isInteger(maxItems) && maxItems > 0 ? Math.min(maxItems, 500) : 500;
  let queue = Promise.resolve();

  function enqueue(operation) {
    const task = queue.then(operation);
    queue = task.catch(() => {});
    return task;
  }

  async function read() {
    try {
      const stat = await fs.promises.lstat(indexPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error('最近文件索引无效，请保留原文件后检查');
      const data = JSON.parse(await fs.promises.readFile(indexPath, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.items) || data.items.some(item => !validItem(item))) throw new Error('最近文件索引格式无效');
      return data.items;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      if (error.code === 'EACCES' || error.code === 'EPERM') throw mediaError('MEDIA_INDEX_UNAVAILABLE', '最近文件记录暂时无法读取，请检查访问权限后重试');
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

  function withoutLog(item) {
    const next = { ...item };
    for (const key of ['logPath', 'logRealPath', 'logBytes', 'logTruncated']) delete next[key];
    return next;
  }

  async function inspect(item, log = false) {
    try { await resolveFile(item, log); return { available: true }; }
    catch (error) {
      const failure = await classifyFileError(error, log ? item.logPath : item.path, log, log ? item.logRealPath : item.realPath);
      return { available: false, missing: failure.missing, error: failure.error.message };
    }
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
      try {
        const logStat = await fs.promises.lstat(logPath);
        if (!logStat.isFile() || logStat.isSymbolicLink()) throw new Error('关联日志文件无效');
        Object.assign(item, { logPath, logRealPath: await fs.promises.realpath(logPath), logBytes: logStat.size, logTruncated: input.logTruncated === true });
      } catch (error) {
        // A removed optional log must not prevent a successfully saved video from being indexed.
        if (!isMissing(error)) throw error;
        const failure = await classifyFileError(error, logPath, true, path.join(path.dirname(item.realPath), path.basename(logPath)));
        if (!failure.missing) throw failure.error;
      }
    }
    if (input.logError) item.logError = String(input.logError).slice(0, 1000);
    // Limit metadata only. Original screenshots, videos and logs are never deleted here.
    const next = [item, ...items.filter(entry => entry.realPath !== item.realPath)].sort((a, b) => b.createdAt - a.createdAt).slice(0, itemLimit);
    await save(next);
    onChange({ deviceId: item.deviceId });
    return { ...item, exists: true };
  }

  async function listNow({ deviceId } = {}) {
    const items = await read();
    const retained = [];
    const visible = [];
    let changed = items.length > itemLimit;
    // Reconcile before taking the visible ten so older files can fill deleted rows.
    for (const item of items.slice(0, itemLimit)) {
      const media = await inspect(item);
      if (media.missing) { changed = true; continue; }
      let next = item;
      let log;
      if (item.logPath) {
        log = await inspect(item, true);
        if (log.missing) { next = withoutLog(item); changed = true; }
      }
      retained.push(next);
      if (!deviceId || item.deviceId === deviceId) visible.push({
        ...next, exists: media.available ? true : null, available: media.available,
        ...(!media.available ? { availabilityError: media.error } : {}),
        ...(next.logPath ? { logAvailable: log.available, ...(!log.available ? { logAvailabilityError: log.error } : {}) } : {})
      });
    }
    // Do not emit onChange from a list refresh: subscribers already receive this result.
    if (changed) await save(retained);
    return visible.sort((a, b) => b.createdAt - a.createdAt).slice(0, 10);
  }

  async function resolveForAction(items, item, log = false) {
    try { return await resolveFile(item, log); }
    catch (error) {
      const failure = await classifyFileError(error, log ? item.logPath : item.path, log, log ? item.logRealPath : item.realPath);
      if (failure.missing) {
        await save(log ? items.map(entry => entry.id === item.id ? withoutLog(entry) : entry) : items.filter(entry => entry.id !== item.id));
        onChange({ deviceId: item.deviceId });
      }
      throw failure.error;
    }
  }

  async function performNow({ id, action } = {}) {
    if (!['open', 'folder', 'copy', 'log'].includes(action)) throw new Error('无效的文件操作');
    const items = await read();
    const item = items.find(entry => entry.id === id);
    if (!item) throw mediaError('MEDIA_RECORD_MISSING', '该文件不在最近记录中，请刷新列表或从保存目录查看');
    const media = await resolveForAction(items, item);
    if (action === 'log' && !item.logPath) throw mediaError('MEDIA_LOG_MISSING', '关联日志已移动或删除，日志入口已移除');
    const target = action === 'log' ? await resolveForAction(items, item, true) : media;
    try {
      if (action === 'folder') {
        shell.showItemInFolder(media.path);
        return;
      }
      if (action === 'copy') {
        if (item.type !== 'image') throw mediaError('MEDIA_ACTION_INVALID', '只有截图可以复制为图片');
        const image = nativeImage.createFromPath(target.path);
        if (image.isEmpty()) throw mediaError('MEDIA_UNREADABLE', '截图暂时无法读取，请稍后重试');
        clipboard.writeImage(image);
      } else {
        const error = await shell.openPath(target.path);
        if (error) throw mediaError('MEDIA_OPEN_FAILED', '文件暂时无法打开，请检查文件访问权限和默认打开程序');
      }
    } catch (error) {
      // A file may disappear after the first check but before the OS opens it.
      await resolveForAction(items, item);
      if (action === 'log') await resolveForAction(items, item, true);
      throw error.code?.startsWith('MEDIA_') ? error : fileError(error, action === 'log');
    }
  }

  return {
    add: input => enqueue(() => addNow(input)),
    list: args => enqueue(() => listNow(args)),
    perform: args => enqueue(() => performNow(args))
  };
}

function isMissing(error) { return error?.code === 'ENOENT' || error?.code === 'ENOTDIR'; }

function mediaError(code, message) { return Object.assign(new Error(message), { code }); }

async function classifyFileError(error, file, log = false, realFile = file) {
  if (isMissing(error)) {
    try {
      // Junctions can leave the visible drive online while the recorded target drive is disconnected.
      for (const rootPath of new Set([path.parse(file).root, path.parse(realFile).root])) {
        const root = await fs.promises.stat(rootPath);
        if (!root.isDirectory()) throw new Error('Storage root unavailable');
      }
    } catch {
      return { missing: false, error: mediaError('MEDIA_STORAGE_UNAVAILABLE', '存储位置暂时不可用，请重新连接磁盘或网络位置后重试') };
    }
  }
  return { missing: isMissing(error), error: fileError(error, log) };
}

function fileError(error, log = false) {
  const subject = log ? '关联日志' : '文件';
  if (isMissing(error)) return mediaError(log ? 'MEDIA_LOG_MISSING' : 'MEDIA_FILE_MISSING', `${subject}已移动或删除，${log ? '日志入口已移除' : '已从最近文件中移除'}`);
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return mediaError('MEDIA_ACCESS_DENIED', `${subject}暂时无法读取，请检查访问权限后重试`);
  return mediaError('MEDIA_UNREADABLE', `${subject}暂时无法读取或位置已变化，请检查保存目录后重试`);
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
    catch (error) { return { success: false, error: error.message, code: error.code || 'MEDIA_ACTION_FAILED' }; }
  });
}

module.exports = { createDeviceMediaStore, recordMedia, register };
