const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWriteAsync } = require('./ai-workspace-store-async.cjs');
const { tr } = require('./localization.cjs');
const { inspectSignedDriver, signedDriverInfName } = require('./firmware-driver-package.cjs');
const { registerFirmwareDirectWorkspace } = require('./firmware-direct-workspace.cjs');
const { createMtkBindingStore, createRkBindingStore } = require('./firmware-direct-binding.cjs');

const PLATFORMS = Object.freeze({
  rk: ['img'],
  mtk: ['xml'],
});
const cancelled = () => ({ ok: false, cancelled: true });
const failure = error => ({ ok: false, error });

function recentFirmwareFiles(directory) {
  const filename = platform => path.join(directory, `firmware-recent-file.${platform}.v1.json`);
  const usable = (platform, file) => typeof file === 'string' && file.length <= 1024 && !file.includes('\0') &&
    path.isAbsolute(file) && !/^[\\/]{2}/.test(file) && PLATFORMS[platform].includes(path.extname(file).slice(1).toLowerCase());
  return {
    async read(platform) {
      try {
        const meta = await fs.lstat(filename(platform));
        if (!meta.isFile() || meta.size > 8192) return '';
        const value = JSON.parse(await fs.readFile(filename(platform), 'utf8'));
        return value?.version === 1 && usable(platform, value.filePath) ? value.filePath : '';
      } catch { return ''; }
    },
    async remember(platform, filePath) {
      if (!usable(platform, filePath)) return;
      await fs.mkdir(directory, { recursive: true });
      await atomicWriteAsync(filename(platform), JSON.stringify({ version: 1, filePath }));
    },
  };
}

async function localDirectory(value) {
  if (typeof value !== 'string' || value.length > 1024 || !path.isAbsolute(value) || /^[\\/]{2}/.test(value)) return '';
  try {
    const real = await fs.realpath(value);
    return !/^[\\/]{2}/.test(real) && (await fs.stat(real)).isDirectory() ? real : '';
  } catch { return ''; }
}

function register(ipcMain, options = {}) {
  const { app, dialog } = options.electron || require('electron');
  const getMainWindow = options.getMainWindow || require('./app-context.cjs').getMainWindow;
  const tools = options.tools || require('./firmware-tools.cjs').createFirmwareTools();
  const validateDriver = options.inspectSignedDriver || inspectSignedDriver;
  const preflight = options.preflight || require('./firmware-preflight.cjs').preflightFirmware;
  const isWindows = (options.hostPlatform || process.platform) === 'win32';
  const configFile = path.join(app.getPath('userData'), 'firmware-tools.v1.json');
  const recentFiles = recentFirmwareFiles(app.getPath('userData'));
  const fileRevision = new Map();
  const choosingFiles = new Set();
  const mtkBindings = createMtkBindingStore(path.join(app.getPath('userData'), 'firmware-direct-mtk-binding.v1.json'));
  const rkBindings = createRkBindingStore(path.join(app.getPath('userData'), 'firmware-direct-rk-binding.v1.json'));
  let configuring = false;
  let installing = false;
  let openingVendor = false;

  function ownerFor(event) {
    const main = getMainWindow();
    if (main && !main.isDestroyed() && main.webContents === event?.sender &&
      event.senderFrame && main.webContents.mainFrame === event.senderFrame) return main;
    return null;
  }

  async function readToolConfig() {
    try {
      if ((await fs.stat(configFile)).size <= 8192) {
        const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
        if (config?.version === 1) {
          return { rk: config.rk, mtk: config.mtk, rkDriver: config.rkDriver, mtkDriver: config.mtkDriver,
            rkDirect: config.rkDirect, mtkDirect: config.mtkDirect };
        }
      }
    } catch { /* An empty or moved setup can be selected again. */ }
    return {};
  }

  async function toolRoot(platform) {
    const config = await readToolConfig();
    return localDirectory(config[platform]);
  }

  const cachedRkTool = path.join(app.getPath('userData'), 'firmware-direct-tools', 'rk-2.46');
  async function directRoots(platform) {
    const config = await readToolConfig();
    const bundledResources = app.isPackaged && (options.resourcesPath || process.resourcesPath);
    const candidates = [
      bundledResources && path.join(bundledResources, 'firmware-direct-tools', platform),
      platform === 'rk' && cachedRkTool,
      config[platform + 'Direct'],
      config[platform],
    ];
    const local = await Promise.all(candidates.map(localDirectory));
    return [...new Map(local.filter(Boolean).map(directory => [directory.toLowerCase(), directory])).values()];
  }

  async function prepareDirectTool(platform, { owner, frame, signal, local, findExisting, inspect }) {
    if (configuring || installing || openingVendor || signal.aborted) return cancelled();
    const stillOwned = () => !signal.aborted && getMainWindow() === owner &&
      !owner.isDestroyed() && owner.webContents.mainFrame === frame;
    const unavailable = { ok: false, code: 'flash-tool-unavailable' };
    configuring = true;
    try {
      const previous = await findExisting();
      if (!stillOwned()) return cancelled();
      if (previous.ok) return previous;
      if (platform === 'rk' && !local) {
        const installRk = options.installRkDirectTool || require('./firmware-rk-tool-download.cjs').installRkDirectTool;
        if (!await installRk(cachedRkTool, { signal })) return stillOwned() ? unavailable : cancelled();
        if (!stillOwned()) return cancelled();
        const installed = await inspect(cachedRkTool);
        return installed.ok ? installed : unavailable;
      }
      const config = await readToolConfig();
      const priorRoot = await localDirectory(config[platform + 'Direct']) || await toolRoot(platform);
      if (!stillOwned()) return cancelled();
      const picked = await dialog.showOpenDialog(owner, {
        title: tr('选择刷机工具目录'), defaultPath: priorRoot || app.getPath('desktop'), properties: ['openDirectory'],
      });
      if (!stillOwned() || picked.canceled || !picked.filePaths?.[0]) return cancelled();
      const root = await localDirectory(picked.filePaths[0]);
      if (!root) return unavailable;
      const selected = await inspect(root);
      if (!stillOwned()) return cancelled();
      if (!selected.ok) return unavailable;
      const updated = { version: 1, ...await readToolConfig(), [platform + 'Direct']: root };
      if (!stillOwned()) return cancelled();
      await fs.mkdir(path.dirname(configFile), { recursive: true });
      if (!stillOwned()) return cancelled();
      await atomicWriteAsync(configFile, JSON.stringify(updated));
      return selected;
    } finally { configuring = false; }
  }

  async function driverRoot(platform) {
    const config = await readToolConfig();
    const saved = await localDirectory(config[platform + 'Driver']);
    if (saved) return saved;
    if (!app.isPackaged || !process.resourcesPath) return '';
    return localDirectory(path.join(process.resourcesPath, 'firmware-drivers', platform));
  }

  const workspaceStatus = async (platform, root, refresh = false) => {
    const driverDirectory = await driverRoot(platform);
    return { ok: true, ...await tools.status(platform, root, { refresh, ...(driverDirectory ? { driverDirectory } : {}) }), toolRoot: root };
  };
  const operationResult = response => response.message && !response.error ? { ...response, error: response.message } : response;
  const direct = registerFirmwareDirectWorkspace(ipcMain, {
    mtkBindings,
    rkBindings,
    ownerFor, isWindows, getOwnerFrame: () => getMainWindow()?.webContents?.mainFrame,
    canStart: () => !configuring && !installing && !openingVendor && options.canStartDirect?.() !== false,
    toolRoots: directRoots,
    prepareTool: prepareDirectTool,
    ...options.direct,
  });
  const flashBusy = () => failure(tr('设备正在刷机，请保持连接。'));

  function handle(name, action) {
    ipcMain.handle(`firmware:${name}`, async (event, platform, refresh) => {
      const owner = ownerFor(event);
      if (!owner || typeof platform !== 'string' || !Object.hasOwn(PLATFORMS, platform)) return { ok: false, code: 'invalid-request' };
      if (!isWindows) return failure(tr('固件刷机工作区目前仅支持 Windows。'));
      try { return await action(platform, owner, event, refresh === true); }
      catch { return failure(tr('固件刷机操作未完成，请重试。')); }
    });
  }

  handle('status', async (platform, _owner, _event, refresh) =>
    workspaceStatus(platform, await toolRoot(platform), refresh));
  handle('chooseTools', async (platform, owner, event) => {
    if (direct.isActive()) return flashBusy();
    if (configuring || installing) return cancelled();
    configuring = true;
    try {
      const existing = await toolRoot(platform);
      const selected = await dialog.showOpenDialog(owner, {
        title: tr('选择刷机工具目录'),
        defaultPath: existing || app.getPath('desktop'),
        properties: ['openDirectory']
      });
      if (selected.canceled || !selected.filePaths?.[0] || ownerFor(event) !== owner) return cancelled();
      const root = await localDirectory(selected.filePaths[0]);
      if (!root) return failure(tr('请选择本机的刷机工具目录。'));
      const other = platform === 'rk' ? 'mtk' : 'rk';
      const [result, otherStatus] = await Promise.all([workspaceStatus(platform, root), tools.status(other, root)]);
      const available = state => state.tool?.available;
      if (!available(result)) {
        return failure(tr('未在选定目录找到受支持的 RK 或 MTK 工具。'));
      }
      if (ownerFor(event) !== owner) return cancelled();
      const config = { version: 1, ...await readToolConfig(), [platform]: root };
      if (available(otherStatus)) config[other] = root;
      await fs.mkdir(path.dirname(configFile), { recursive: true });
      await atomicWriteAsync(configFile, JSON.stringify(config));
      return result;
    } finally { configuring = false; }
  });
  handle('chooseFile', async (platform, owner, event) => {
    if (direct.isActive()) return flashBusy();
    if (choosingFiles.has(platform)) return cancelled();
    choosingFiles.add(platform);
    fileRevision.set(platform, Symbol());
    try {
      const selected = await dialog.showOpenDialog(owner, {
        title: tr('选择待预检的固件'),
        properties: ['openFile'],
        filters: [{ name: tr('固件文件'), extensions: PLATFORMS[platform] }]
      });
      if (selected.canceled || !selected.filePaths?.[0] || ownerFor(event) !== owner) return cancelled();
      const filePath = selected.filePaths[0];
      const checked = await preflight(platform, filePath);
      if (ownerFor(event) !== owner || direct.isActive()) return cancelled();
      if (checked.ok) await recentFiles.remember(platform, filePath).catch(() => {});
      if (ownerFor(event) !== owner || direct.isActive()) return cancelled();
      if (!checked.ok) direct.forgetFile(platform, event.senderFrame);
      return { ...checked, filePath, ...(checked.ok ? { firmwareId: direct.rememberFile(platform, filePath, event.senderFrame) } : {}) };
    } finally { choosingFiles.delete(platform); }
  });
  handle('restoreFile', async (platform, owner, event) => {
    if (direct.isActive() || choosingFiles.has(platform)) return cancelled();
    const revision = Symbol();
    fileRevision.set(platform, revision);
    const filePath = await recentFiles.read(platform);
    if (!filePath) return { ok: false, empty: true };
    const checked = await preflight(platform, filePath);
    if (fileRevision.get(platform) !== revision || ownerFor(event) !== owner || direct.isActive()) return cancelled();
    return { ...checked, filePath, ...(checked.ok ? { firmwareId: direct.rememberFile(platform, filePath, event.senderFrame) } : {}) };
  });
  handle('installDriver', async (platform, owner, event) => {
    if (direct.isActive()) return flashBusy();
    if (installing || configuring) return failure(tr('正在处理另一个驱动或工具设置操作。'));
    installing = true;
    try {
      const root = await toolRoot(platform);
      let driverDirectory = await driverRoot(platform);
      const previous = await tools.status(platform, root, driverDirectory ? { driverDirectory } : {});
      if (!previous.installer?.available) {
        const chosen = await dialog.showOpenDialog(owner, {
          title: tr('选择已签名的刷机驱动 INF 文件'),
          properties: ['openFile'],
          filters: [{ name: tr('驱动文件'), extensions: ['inf'] }]
        });
        if (chosen.canceled || !chosen.filePaths?.[0] || ownerFor(event) !== owner) return cancelled();
        const file = chosen.filePaths[0];
        const directory = await localDirectory(path.dirname(file));
        if (!directory || path.basename(file).toLowerCase() !== signedDriverInfName(platform) ||
          !(await validateDriver(platform, directory)).length) return failure(tr('驱动包校验失败，请选择受支持的原厂 INF 和同目录配套文件。'));
        if (ownerFor(event) !== owner) return cancelled();
        driverDirectory = directory;
        const config = { version: 1, ...await readToolConfig(), [platform + 'Driver']: directory };
        await fs.mkdir(path.dirname(configFile), { recursive: true });
        await atomicWriteAsync(configFile, JSON.stringify(config));
      }
      if (ownerFor(event) !== owner) return cancelled();
      const result = operationResult(await tools.install(platform, root, {
        confirmed: true, ...(driverDirectory ? { driverDirectory } : {})
      }));
      return { ...result, status: result.status ? { ...result.status, ok: true, toolRoot: root } : undefined };
    } finally { installing = false; }
  });
  handle('openTool', async (platform, owner, event) => {
    if (direct.isActive() || openingVendor) return flashBusy();
    openingVendor = true;
    try {
      const root = await toolRoot(platform);
      return ownerFor(event) === owner ? operationResult(await tools.open(platform, root)) : cancelled();
    } finally { openingVendor = false; }
  });
  return { warmup: () => isWindows ? tools.warmup() : undefined, direct };
}

module.exports = { register };
