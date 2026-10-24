const { tr } = require('./localization.cjs');
const path = require('node:path');
const { types } = require('node:util');
const LOGIN_ITEM_NAME = '卓控台';
const fail = (code, message) => Object.assign(new Error(message), { code });

function exact(value, keys) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const own = Reflect.ownKeys(value); const descriptors = Object.getOwnPropertyDescriptors(value);
  return own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key)
    && descriptors[key].enumerable && Object.hasOwn(descriptors[key], 'value'));
}
function validateSet(value) {
  if (!exact(value, ['enabled']) || typeof value.enabled !== 'boolean') throw fail('STARTUP_SETTINGS_ARGUMENT', tr("开机自启设置仅接受 enabled 布尔值"));
  return value.enabled;
}
function normalizeStored(value) {
  if (!exact(value, ['version', 'enabled', 'initialized']) || value.version !== 1 || typeof value.enabled !== 'boolean' || typeof value.initialized !== 'boolean') throw fail('STARTUP_SETTINGS_READ', tr("本机开机自启设置格式异常，原文件已保留"));
  return { version: 1, enabled: value.enabled, initialized: value.initialized };
}
function runtimeMode(app, platform, environment, defaultApp) {
  if (!['win32', 'darwin'].includes(platform)) return 'unsupported';
  if (!app.isPackaged || defaultApp || ['development', 'test'].includes(environment.NODE_ENV)
    || environment.AWB_DISABLE_OS_STARTUP === '1' || environment.AWB_QA === '1' || environment.NODE_TEST_CONTEXT) return 'development';
  const executable = app.getPath('exe');
  if (/(?:^|[\\/])\.superpowers(?:[\\/]|$)/i.test(executable) || /^electron(?:\.exe)?$/i.test(path.basename(executable))) return 'development';
  return 'packaged';
}
function loginState(value, platform, executable) {
  if (!value || typeof value.openAtLogin !== 'boolean') throw fail('STARTUP_NATIVE_READ', tr("无法确认系统的开机自启状态"));
  const registered = value.openAtLogin;
  if (platform === 'darwin') {
    const approval = value.status === 'requires-approval';
    if (value.status !== undefined && !['not-registered', 'enabled', 'requires-approval', 'not-found'].includes(value.status)) throw fail('STARTUP_NATIVE_READ', tr("无法识别系统登录项状态"));
    const enabled = value.status === undefined ? registered : value.status === 'enabled';
    return { registered, enabled, approval, exists: registered || approval || value.status === 'enabled', own: { registered: registered || approval, enabled } };
  }
  const enabled = typeof value.executableWillLaunchAtLogin === 'boolean' ? value.executableWillLaunchAtLogin : registered;
  const allRows = Array.isArray(value.launchItems) ? value.launchItems.filter(row => row && typeof row === 'object') : [];
  const rows = allRows.filter(row => typeof row.path === 'string'
    && path.win32.normalize(row.path).toLowerCase() === path.win32.normalize(executable).toLowerCase());
  const own = rows.find(row => row.name === LOGIN_ITEM_NAME && row.scope !== 'machine' && Array.isArray(row.args) && row.args.length === 0);
  const conflict = allRows.some(row => row.name === LOGIN_ITEM_NAME && row.scope !== 'machine' && row !== own);
  return { registered, enabled, approval: false, exists: registered || enabled || rows.length > 0,
    conflict, own: { registered: Boolean(own), enabled: own?.enabled === true } };
}
function resultFor(preferences, mode, native) {
  let message = mode === 'development' ? tr("开发/验证模式仅保存本机选择，不读取或修改系统启动项。")
    : mode === 'unsupported' ? tr("当前平台不支持开机自启；仅保存本机选择。") : '';
  if (native?.approval) message = tr("系统仍需批准登录项，请在系统设置中允许；本软件不会自动重复申请。");
  else if (native && native.enabled !== preferences.enabled) message = tr("系统当前开机自启状态与保存的选择不同，已尊重系统设置，不会自动覆盖。");
  else if (native?.registered && !native.enabled) message = tr("该启动项已被系统禁用；如需启用，请明确打开此开关。");
  return { enabled: native ? native.enabled : preferences.enabled, preferredEnabled: preferences.enabled,
    registered: native ? native.registered : null, initialized: preferences.initialized, mode, message };
}
module.exports = { LOGIN_ITEM_NAME, fail, exact, validateSet, normalizeStored, runtimeMode, loginState, resultFor };
