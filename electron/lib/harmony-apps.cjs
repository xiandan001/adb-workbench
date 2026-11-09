const fs = require('node:fs');
const path = require('node:path');
const { tr } = require('./localization.cjs');
const { runHdc: defaultRunHdc } = require('./hdc-runtime.cjs');
const { unsupportedDeviceOperation } = require('./device-platform.cjs');
const { resolveDeviceRef } = require('./device-registry.cjs');
const { bundleName, parseBundleList, parseBundleDetail, selectLaunchAbility } = require('./harmony-bundles.cjs');

function applicationResult(result) {
  const output = String(result?.stdout || result?.stderr || '');
  const failure = [result?.stdout || '', result?.stderr || ''].join('\n').split(/\r?\n/).find(line => /^\s*(?:error\b|failed\b|fail\b|\[Fail\])/i.test(line));
  return result?.ok && !result.cancelled && !failure ? { ok: true, output }
    : { ok: false, code: result?.code, error: result?.error || failure || output || tr('鸿蒙应用操作未完成。'), cancelled: result?.cancelled === true };
}

function createHarmonyApps({ runHdc = defaultRunHdc, io = fs, resolve = resolveDeviceRef } = {}) {
  const bind = (deviceId, options) => {
    if (options.deviceRef) return options;
    const ref = resolve(deviceId);
    return { ...options, deviceRef: ref, assertCurrent: () => {
      options.assertCurrent?.();
      const current = resolve(deviceId);
      if (current.generation !== ref.generation || current.targetKey !== ref.targetKey) throw Object.assign(new Error(tr('应用操作期间设备连接已变化，未继续执行。')), { code: 'DEVICE_CHANGED', safe: true });
    } };
  };
  const shell = async (deviceId, args, options) => {
    options?.assertCurrent?.();
    return runHdc(deviceId, ['shell', ...args], { timeoutMs: 60000, ...options });
  };
  async function checked(deviceId, args, options) {
    const result = await shell(deviceId, args, options);
    const normalized = applicationResult(result);
    if (!normalized.ok) throw Object.assign(new Error(normalized.error), { code: normalized.code, cancelled: normalized.cancelled, safe: true });
    return result.stdout;
  }
  async function listPackages(deviceId, options = {}) {
    return parseBundleList(await checked(deviceId, ['bm', 'dump', '-a'], bind(deviceId, options)));
  }
  async function getPackageDetail(deviceId, name, options = {}) {
    return parseBundleDetail(await checked(deviceId, ['bm', 'dump', '-n', bundleName(name)], bind(deviceId, options)), name);
  }
  async function getCapabilities(deviceId, options = {}) {
    options = bind(deviceId, options);
    const [bm, aa] = await Promise.all([shell(deviceId, ['bm', 'help'], options), shell(deviceId, ['aa', 'help'], options)]);
    const available = (result, command) => result.ok && new RegExp('^\\s*' + command + '(?:\\s|$)', 'm').test(String(result.stdout));
    return {
      launch: { supported: available(aa, 'start'), reason: tr('设备未提供可用的 aa start 命令。') },
      forceStop: { supported: available(aa, 'force-stop'), reason: tr('设备未提供可用的应用停止命令。') },
      clearData: { supported: available(bm, 'clean'), reason: tr('当前系统或开发者权限未提供 bm clean。') },
      enable: { supported: available(bm, 'enable'), reason: tr('此系统未开放应用启用操作。') },
      disable: { supported: available(bm, 'disable'), reason: tr('此系统未开放应用停用操作。') },
      uninstall: { supported: available(bm, 'uninstall'), reason: tr('设备未提供可用的应用卸载命令。') },
      export: { supported: false, reason: tr('不能将 APK 导出方式用于 HAP；此设备尚无已验证的应用包导出能力。') }
    };
  }
  async function launchPackage(deviceId, name, options = {}) {
    try {
      options = bind(deviceId, options);
      const detail = await getPackageDetail(deviceId, name, options);
      const entry = selectLaunchAbility(detail, options);
      const args = ['aa', 'start', '-b', name, '-a', entry.abilityName];
      if (entry.moduleName) args.push('-m', entry.moduleName);
      return { ...applicationResult(await shell(deviceId, args, options)), entry };
    } catch (error) { return { ok: false, error: error.message, code: error.code, cancelled: error.cancelled === true }; }
  }
  async function runPackageAction(deviceId, name, action, options = {}) {
    try {
      options = bind(deviceId, options);
      bundleName(name);
      if (action === 'launch') return launchPackage(deviceId, name, options);
      const commands = { forceStop: ['aa', 'force-stop', name], clearData: ['bm', 'clean', '-d', '-n', name],
        enable: ['bm', 'enable', '-n', name], disable: ['bm', 'disable', '-n', name], uninstall: ['bm', 'uninstall', '-n', name] };
      if (!commands[action]) throw unsupportedDeviceOperation(action);
      const capabilities = await getCapabilities(deviceId, options);
      if (!capabilities[action]?.supported) return { ok: false, code: 'DEVICE_UNSUPPORTED', error: capabilities[action]?.reason || tr('当前鸿蒙设备不支持该应用操作。') };
      return applicationResult(await shell(deviceId, commands[action], options));
    } catch (error) { return { ok: false, error: error.message, code: error.code, cancelled: error.cancelled === true }; }
  }
  async function installPackage(deviceId, localPath, options = {}) {
    try {
      options = bind(deviceId, options);
      if (typeof localPath !== 'string' || !path.isAbsolute(localPath) || !/\.(hap|hsp)$/i.test(localPath) || !io.statSync(localPath).isFile()) {
        throw Object.assign(new Error(tr('鸿蒙设备仅接受现有的本地 HAP/HSP 文件。')), { code: 'INVALID_APP_PACKAGE' });
      }
      options.assertCurrent?.();
      return applicationResult(await runHdc(deviceId, ['install', '-r', localPath], { timeoutMs: 180000, ...options }));
    } catch (error) { return { ok: false, error: error.message, code: error.code }; }
  }
  return { listPackages, getPackageDetail, getCapabilities, launchPackage, runPackageAction, installPackage };
}

module.exports = { ...createHarmonyApps(), createHarmonyApps, applicationResult };
