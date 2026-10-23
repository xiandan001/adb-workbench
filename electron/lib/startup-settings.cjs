const { createStartupSettingsService } = require('./startup-settings-service.cjs');
const { exact, fail, validateSet } = require('./startup-settings-policy.cjs');

function createStartupSettingsController({ service, getOwner }) {
  function authorize(event) {
    try {
      const owner = getOwner();
      if (owner && !owner.isDestroyed() && owner.webContents?.mainFrame && !owner.webContents.isDestroyed()
        && event?.sender === owner.webContents && event.senderFrame === owner.webContents.mainFrame) return;
    } catch { /* A replaced/destroyed owner must fail closed without cached data. */ }
    throw fail('STARTUP_SETTINGS_OWNER', '请在卓控台主窗口修改开机自启设置');
  }
  async function result(operation) {
    try { return { success: true, result: await operation() }; }
    catch (error) {
      const known = typeof error?.code === 'string' && error.code.startsWith('STARTUP_');
      const current = error?.code === 'STARTUP_SETTINGS_OWNER' ? undefined : service.snapshot();
      return { success: false, error: { code: known ? error.code : 'STARTUP_SETTINGS_FAILED', message: known ? error.message : '开机自启设置操作失败，请重试' }, ...(current ? { result: current } : {}) };
    }
  }
  const invoke = (event, value, writing) => result(async () => {
    authorize(event);
    if (writing) validateSet(value);
    else if (value !== undefined && !exact(value, [])) throw fail('STARTUP_SETTINGS_ARGUMENT', '读取开机自启设置不接受额外参数');
    const guard = () => authorize(event);
    const state = writing ? await service.set(value, guard) : await service.get(guard);
    authorize(event); return state;
  });
  return {
    register(ipcMain) {
      ipcMain.handle('startup-settings:get', (event, value) => invoke(event, value, false));
      ipcMain.handle('startup-settings:set', (event, value) => invoke(event, value, true));
    },
    initialize: () => result(() => service.initialize()),
    dispose: () => service.dispose(),
  };
}

let controller;
function register(ipcMain) {
  const { app } = require('electron');
  const service = createStartupSettingsService({ app, directory: app.getPath('userData') });
  controller = createStartupSettingsController({ service, getOwner: () => require('./app-context.cjs').getMainWindow() });
  controller.register(ipcMain);
}
module.exports = { createStartupSettingsController, register,
  initialize: () => controller?.initialize() || Promise.resolve({ success: false, error: { code: 'STARTUP_SETTINGS_NOT_READY', message: '开机自启设置尚未就绪' } }),
  cleanup: () => controller?.dispose(),
};
