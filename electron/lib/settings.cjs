// 设置存储 IPC handlers
// 持久化用户设置：自定义主题、截图/录屏/巡检/性能/任务/质量中心路径、推送远程路径历史。

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { normalizeOnboardingState } = require('./task-center-onboarding-state.cjs');

const SETTINGS_FILE = 'settings.json';
const CUSTOM_THEMES_FILE = 'customThemes.json';
let settingsWriteQueue = Promise.resolve();

const SETTING_KEYS = {
  screenshotPath: { fallback: null },
  screenRecordPath: { fallback: null },
  inspectionPath: { fallback: null },
  performancePath: { fallback: null },
  taskCenterPath: { fallback: null },
  qualityCenterPath: { fallback: null },
  pushRemotePathHistory: { fallback: [] },
  taskCenterOnboarding: { fallback: null, sanitize: normalizeOnboardingState }
};

function register(ipcMain) {
  ipcMain.handle('settings:loadAll', async () => {
    try {
      const [settings, customThemes] = await Promise.all([
        readSettings(),
        readCustomThemes()
      ]);
      return { success: true, data: { settings, customThemes } };
    } catch (error) {
      console.error('Failed to load all settings:', error);
      return { success: false, error: error.message, data: { settings: {}, customThemes: [] } };
    }
  });

  ipcMain.handle('settings:savePatch', async (event, patch) => {
    try {
      await writeSettingsPatch(patch || {});
      return { success: true };
    } catch (error) {
      console.error('Failed to save settings patch:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('themes:saveCustomThemes', async (event, customThemes) => {
    try {
      await writeJson(getCustomThemesPath(), Array.isArray(customThemes) ? customThemes : []);
      return { success: true };
    } catch (error) {
      console.error('Failed to save custom themes:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('themes:loadCustomThemes', async () => {
    try {
      return { success: true, data: await readCustomThemes() };
    } catch (error) {
      console.error('Failed to load custom themes:', error);
      return { success: false, error: error.message, data: [] };
    }
  });

  registerSettingHandlers(ipcMain, 'ScreenshotPath', 'screenshotPath');
  registerSettingHandlers(ipcMain, 'ScreenRecordPath', 'screenRecordPath');
  registerSettingHandlers(ipcMain, 'InspectionPath', 'inspectionPath');
  registerSettingHandlers(ipcMain, 'PerformancePath', 'performancePath');
  registerSettingHandlers(ipcMain, 'TaskCenterPath', 'taskCenterPath');
  registerSettingHandlers(ipcMain, 'QualityCenterPath', 'qualityCenterPath');
  registerSettingHandlers(ipcMain, 'PushRemotePathHistory', 'pushRemotePathHistory');
}

function registerSettingHandlers(ipcMain, channelSuffix, key) {
  const saveChannel = `settings:save${channelSuffix}`;
  const loadChannel = `settings:load${channelSuffix}`;
  const fallback = SETTING_KEYS[key]?.fallback ?? null;

  ipcMain.handle(saveChannel, async (event, value) => {
    try {
      await writeSettingsPatch({ [key]: value });
      return { success: true };
    } catch (error) {
      console.error(`Failed to save ${key}:`, error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(loadChannel, async () => {
    try {
      const settings = await readSettings();
      return { success: true, data: settings[key] ?? cloneFallback(fallback) };
    } catch (error) {
      console.error(`Failed to load ${key}:`, error);
      return { success: false, error: error.message, data: cloneFallback(fallback) };
    }
  });
}

async function readSettings() {
  const settings = await readJson(getSettingsPath(), {});
  return {
    ...settings,
    taskCenterOnboarding: normalizeOnboardingState(settings.taskCenterOnboarding)
  };
}

async function writeSettingsPatch(patch) {
  const task = settingsWriteQueue.then(() => writeSettingsPatchNow(patch));
  settingsWriteQueue = task.catch(() => {});
  return task;
}

async function writeSettingsPatchNow(patch) {
  const current = await readSettings();
  const next = { ...current };
  for (const [key, value] of Object.entries(patch || {})) {
    if (!Object.prototype.hasOwnProperty.call(SETTING_KEYS, key)) continue;
    const config = SETTING_KEYS[key];
    const sanitized = typeof config.sanitize === 'function' ? config.sanitize(value) : value;
    if (key === 'taskCenterOnboarding' && value !== null && sanitized === null) {
      throw new Error('invalid_task_center_onboarding');
    }
    next[key] = sanitized;
  }
  await writeJson(getSettingsPath(), next);
  return next;
}

async function readCustomThemes() {
  const data = await readJson(getCustomThemesPath(), []);
  return Array.isArray(data) ? data : [];
}

async function readJson(filePath, fallback) {
  try {
    const data = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error?.code === 'ENOENT') return cloneFallback(fallback);
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), SETTINGS_FILE);
}

function getCustomThemesPath() {
  return path.join(app.getPath('userData'), CUSTOM_THEMES_FILE);
}

function cloneFallback(value) {
  return Array.isArray(value) ? value.slice() : value;
}

module.exports = { register };
