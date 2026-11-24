const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWriteAsync } = require('./ai-workspace-store-async.cjs');
const { tr } = require('./localization.cjs');

const PLATFORMS = Object.freeze({
  rk: { extensions: ['img'], help: 'https://redmine.rock-chips.com/urllist' },
  mtk: { extensions: ['xml'], help: 'https://genio.mediatek.com/download/b78c5e11-5a50-4ba2-a8fa-a406f54da13f/info' },
});
const cancelled = () => ({ ok: false, cancelled: true });
const failure = error => ({ ok: false, error });
const desktopToolsFolder = '烧录';

async function localDirectory(value) {
  if (typeof value !== 'string' || value.length > 1024 || !path.isAbsolute(value) || /^[\\/]{2}/.test(value)) return '';
  try {
    const real = await fs.realpath(value);
    return !/^[\\/]{2}/.test(real) && (await fs.stat(real)).isDirectory() ? real : '';
  } catch { return ''; }
}

function register(ipcMain, options = {}) {
  const { app, dialog, shell } = options.electron || require('electron');
  const getMainWindow = options.getMainWindow || require('./app-context.cjs').getMainWindow;
  const tools = options.tools || require('./firmware-tools.cjs').createFirmwareTools();
  const preflight = options.preflight || require('./firmware-preflight.cjs').preflightFirmware;
  const isWindows = (options.hostPlatform || process.platform) === 'win32';
  const configFile = path.join(app.getPath('userData'), 'firmware-tools.v1.json');
  let configuring = false;
  let installing = false;

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
          return { rk: config.rk, mtk: config.mtk };
        }
      }
    } catch { /* An empty or moved setup can be selected again. */ }
    return {};
  }

  async function toolRoot(platform) {
    const config = await readToolConfig();
    return await localDirectory(config[platform]) || localDirectory(path.join(app.getPath('desktop'), 'work', 'utils', desktopToolsFolder));
  }

  const workspaceStatus = async (platform, root) => ({ ok: true, ...await tools.status(platform, root), toolRoot: root });
  const operationResult = response => response.message && !response.error ? { ...response, error: response.message } : response;

  function handle(name, action) {
    ipcMain.handle(`firmware:${name}`, async (event, platform) => {
      const owner = ownerFor(event);
      if (!owner || typeof platform !== 'string' || !Object.hasOwn(PLATFORMS, platform)) return { ok: false, code: 'invalid-request' };
      if (!isWindows) return failure(tr('固件刷机工作区目前仅支持 Windows。'));
      try { return await action(platform, owner, event); }
      catch { return failure(tr('固件刷机操作未完成，请重试。')); }
    });
  }

  handle('status', async platform => workspaceStatus(platform, await toolRoot(platform)));
  handle('chooseTools', async (platform, owner, event) => {
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
      const available = state => state.tool?.available || state.installer?.available;
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
    const selected = await dialog.showOpenDialog(owner, {
      title: tr('选择待预检的固件'),
      properties: ['openFile'],
      filters: [{ name: tr('固件文件'), extensions: PLATFORMS[platform].extensions }]
    });
    if (selected.canceled || !selected.filePaths?.[0] || ownerFor(event) !== owner) return cancelled();
    const filePath = selected.filePaths[0];
    return { ...await preflight(platform, filePath), filePath };
  });
  handle('installDriver', async (platform, owner, event) => {
    if (installing || configuring) return failure(tr('正在处理另一个驱动或工具设置操作。'));
    installing = true;
    try {
      const root = await toolRoot(platform);
      if (ownerFor(event) !== owner) return cancelled();
      const result = operationResult(await tools.install(platform, root, { confirmed: true }));
      return { ...result, status: result.status ? { ...result.status, ok: true, toolRoot: root } : undefined };
    } finally { installing = false; }
  });
  handle('openTool', async (platform, owner, event) => {
    const root = await toolRoot(platform);
    return ownerFor(event) === owner ? operationResult(await tools.open(platform, root)) : cancelled();
  });
  handle('openVendorHelp', async platform => {
    await shell.openExternal(PLATFORMS[platform].help);
    return { ok: true };
  });
}

module.exports = { register };
