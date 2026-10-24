const { tr } = require('./localization.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { readSafe, atomicReplace, checksum } = require('./ai-tools-file-safety.cjs');
const { LOGIN_ITEM_NAME, fail, validateSet, normalizeStored, runtimeMode, loginState, resultFor } = require('./startup-settings-policy.cjs');
const LIMIT = 4096;

function createStartupSettingsService({ app, directory, platform = process.platform, environment = process.env,
  defaultApp = process.defaultApp === true, filesystem: io = fs } = {}) {
  if (!app || typeof app.getPath !== 'function' || typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) throw fail('STARTUP_SETTINGS_PATH', tr("本机开机自启设置目录无效"));
  const file = path.join(directory, 'startup-preferences.json');
  let disposed = false; let attempted = false; let lastKnown; let queue = Promise.resolve();
  const mode = () => runtimeMode(app, platform, environment, defaultApp);
  function read() {
    try {
      const source = readSafe(file, io, LIMIT);
      return { ...source, preferences: source.bytes ? normalizeStored(JSON.parse(source.bytes.toString('utf8'))) : { version: 1, enabled: true, initialized: false } };
    } catch { throw fail('STARTUP_SETTINGS_READ', tr("无法读取本机开机自启设置，原文件已保留")); }
  }
  function write(preferences, before) {
    const bytes = Buffer.from(`${JSON.stringify(normalizeStored(preferences))}\n`);
    try { atomicReplace(file, bytes, before.hash, io, LIMIT); }
    catch { throw fail('STARTUP_SETTINGS_SAVE', tr("无法保存本机开机自启设置，未修改系统启动项")); }
    return { preferences, bytes, hash: checksum(bytes), exists: true };
  }
  function nativeRead() {
    try {
      const executable = app.getPath('exe');
      return loginState(app.getLoginItemSettings(platform === 'win32' ? { path: executable, args: [] } : {}), platform, executable);
    } catch { throw fail('STARTUP_NATIVE_READ', tr("无法读取系统开机自启状态，请检查系统设置后重试")); }
  }
  function nativeWrite(enabled, approved = enabled) {
    try {
      app.setLoginItemSettings(platform === 'win32'
        ? { openAtLogin: enabled, enabled: approved, path: app.getPath('exe'), args: [], name: LOGIN_ITEM_NAME }
        : { openAtLogin: enabled });
    } catch { throw fail('STARTUP_NATIVE_UPDATE', tr("系统未能更新开机自启，请检查权限或系统设置后重试")); }
  }
  const remember = (preferences, currentMode, native) => { lastKnown = resultFor(preferences, currentMode, native); return { ...lastKnown }; };
  function restoreNative(before) {
    let current = nativeRead();
    if (current.conflict) throw fail('STARTUP_COMPENSATION_FAILED', tr("系统出现其他同名启动项，未覆盖它；请检查系统登录启动设置"));
    if (JSON.stringify(current.own) !== JSON.stringify(before.own)) {
      nativeWrite(before.own.registered, before.own.enabled); current = nativeRead();
      if (JSON.stringify(current.own) !== JSON.stringify(before.own)) throw fail('STARTUP_COMPENSATION_FAILED', tr("系统启动项未能恢复，请检查系统登录启动设置"));
    }
    return current;
  }
  function apply(preferences, before, nativeBefore, keepMarker = false) {
    if (nativeBefore.conflict || (!preferences.enabled && !nativeBefore.own.registered && nativeBefore.enabled)) {
      remember(before.preferences, 'packaged', nativeBefore);
      throw fail('STARTUP_NATIVE_CONFLICT', tr("系统存在非本软件管理的启动项，未覆盖或删除它；请在系统启动设置中管理"));
    }
    const written = write(preferences, before); let nativeAfter;
    try {
      const shouldWrite = preferences.enabled ? !nativeBefore.enabled : nativeBefore.own.registered;
      if (shouldWrite) nativeWrite(preferences.enabled);
      nativeAfter = nativeRead();
      if (nativeAfter.approval && preferences.enabled) {
        remember(preferences, 'packaged', nativeAfter);
        throw fail('STARTUP_APPROVAL_REQUIRED', tr("系统仍需批准开机自启，当前尚未启用；请在系统设置中允许登录项"));
      }
      if (nativeAfter.enabled !== preferences.enabled) throw fail('STARTUP_NATIVE_UPDATE', tr("系统未接受开机自启变更，可能存在其他启动项或系统限制，请检查系统设置"));
      if (readSafe(file, io, LIMIT).hash !== written.hash) throw fail('STARTUP_SETTINGS_CHANGED', tr("开机自启设置在操作期间发生变化，未覆盖外部修改"));
      return remember(preferences, 'packaged', nativeAfter);
    } catch (error) {
      if (error.code === 'STARTUP_APPROVAL_REQUIRED') throw error;
      let compensationFailed = false; let restored;
      try { restored = restoreNative(nativeBefore); } catch { compensationFailed = true; }
      if (!keepMarker) {
        try { atomicReplace(file, before.bytes, written.hash, io, LIMIT); } catch { compensationFailed = true; }
      }
      if (restored && !compensationFailed) remember(keepMarker ? preferences : before.preferences, 'packaged', restored);
      else lastKnown = undefined;
      if (compensationFailed) throw fail('STARTUP_COMPENSATION_FAILED', tr("更新失败，部分设置未能恢复；请检查系统启动项和本机设置后重试"));
      throw error;
    }
  }
  function initializeInternal() {
    lastKnown = undefined; const before = read(); const currentMode = mode();
    if (currentMode !== 'packaged') return remember(before.preferences, currentMode);
    const native = nativeRead();
    if (before.preferences.initialized || attempted) return remember(before.preferences, currentMode, native);
    attempted = true;
    // Respect an existing OS choice (including StartupApproved disable) on feature adoption.
    const preferences = { version: 1, enabled: !before.exists && native.exists ? native.enabled : before.preferences.enabled, initialized: true };
    if (!before.exists && native.exists) { write(preferences, before); return remember(preferences, currentMode, native); }
    // Persist this one-time initialization before changing the OS; never auto-retry after a crash/failure.
    return apply(preferences, before, native, true);
  }
  function enqueue(operation, guard) {
    const pending = queue.then(() => { if (disposed) throw fail('STARTUP_SETTINGS_DISPOSED', tr("开机自启设置服务正在退出")); guard?.(); return operation(); });
    queue = pending.catch(() => {}); return pending;
  }
  function set(input, guard) {
    let enabled; try { enabled = validateSet(input); } catch (error) { return Promise.reject(error); }
    return enqueue(() => {
      lastKnown = undefined; const before = read(); const currentMode = mode();
      if (currentMode !== 'packaged') return remember(write({ version: 1, enabled, initialized: false }, before).preferences, currentMode);
      const native = nativeRead(); attempted = true;
      return apply({ version: 1, enabled, initialized: true }, before, native);
    }, guard);
  }
  return { initialize: () => enqueue(initializeInternal), get: guard => enqueue(initializeInternal, guard), set,
    snapshot: () => lastKnown ? { ...lastKnown } : undefined, dispose() { disposed = true; } };
}

module.exports = { createStartupSettingsService, LOGIN_ITEM_NAME };
