const { tr } = require('./localization.cjs');
const { runAdb } = require('./adb-runtime.cjs');
const { normalizeDeviceShortcuts } = require('./device-shortcuts-policy.cjs');
const spec = require('./device-shortcuts-spec.json');

const CACHE_MS = 30000;
const PROBE_TIMEOUT_MS = 2500;
const COMPONENTS = {
  settings: 'com.xbh.jyjsetting/.mainsetting.view.MainActivity',
  whiteboard: 'com.xbh.whiteboard/.LaunchActivity'
};
const status = (id, state, reason) => ({ id, status: state, reason });

function unavailableReason(result) {
  const text = [result?.error, result?.stderr, result?.stdout].filter(Boolean).join('\n');
  if (/unauthorized|not authorized/i.test(text)) return tr("设备尚未授权，暂时无法检查");
  if (/offline|device.*not found|no devices|closed|disconnected/i.test(text)) return tr("设备已断开，暂时无法检查");
  if (result?.timedOut || /timeout|timed out/i.test(text)) return tr("设备检查超时，可稍后重试");
  if (/permission|securityexception|not allowed|denied/i.test(text)) return tr("设备限制了查询权限，无法确认支持情况");
  return tr("设备不支持此项查询，暂时无法确认");
}

function parsePackages(result) {
  if (!result?.ok) return null;
  const lines = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  // Empty/error output is not evidence that every application is absent.
  if (!lines.length || lines.some(line => !/^package:[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/.test(line))) return null;
  return new Set(lines.map(line => line.slice(8)));
}

function componentName(value) {
  const [pkg, activity] = value.split('/');
  return `${pkg}/${activity?.startsWith('.') ? pkg + activity : activity}`;
}

function activityStatus(id, result, packageName, expectedComponent) {
  if (!result?.ok) return status(id, 'unknown', unavailableReason(result));
  const output = String(result.stdout || '').trim();
  if (/^(?:No activit(?:y|ies) found|Unable to resolve Intent)\b/im.test(output)) {
    return status(id, 'unsupported', expectedComponent ? tr("设备未提供此启动入口，请编辑替换按钮") : tr("此应用没有可启动的桌面入口，请编辑替换按钮"));
  }
  const components = output.split(/\r?\n/).filter(line => /^[A-Za-z][\w.]\S*\/[.\w$]+$/.test(line));
  const matched = expectedComponent
    ? components.some(value => componentName(value) === componentName(expectedComponent))
    : components.some(value => value.startsWith(`${packageName}/`));
  return matched ? status(id, 'supported', tr("已检查设备应用及启动入口")) : status(id, 'unknown', tr("无法确认启动入口，可点击尝试或编辑替换"));
}

function createCapabilityService({ run = runAdb, now = Date.now, cacheMs = CACHE_MS, concurrency = 2 } = {}) {
  const cache = new Map();
  const pending = new Map();
  const queue = [];
  let active = 0;

  function schedule(action) {
    return new Promise((resolve, reject) => {
      queue.push({ action, resolve, reject });
      drain();
    });
  }
  function drain() {
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      active++;
      Promise.resolve().then(job.action).then(job.resolve, job.reject).finally(() => { active--; drain(); });
    }
  }
  async function probe(deviceId, args) {
    try {
      return await run(['-s', deviceId, 'shell', ...args], { timeoutMs: PROBE_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, queue: false });
    } catch (error) { return { ok: false, error: error.message }; }
  }
  async function inspect(deviceId, config) {
    const needsPackages = config.slots.some(slot => slot.type === 'app' || spec.actions.find(item => item.id === slot.action)?.packageName);
    const packageResult = needsPackages ? await probe(deviceId, ['pm', 'list', 'packages', '--user', 'current']) : null;
    const packages = parsePackages(packageResult);
    const checks = [];
    for (const slot of config.slots) {
      if (slot.type === 'shell') {
        checks.push(status(slot.id, 'confirm', tr("自定义 ADB 命令无法预检，每次执行前均需确认")));
        continue;
      }
      const builtin = slot.type === 'builtin' ? spec.actions.find(item => item.id === slot.action) : null;
      const packageName = slot.type === 'app' ? slot.packageName : builtin?.packageName;
      if (packageName) {
        if (!packages) checks.push(status(slot.id, 'unknown', unavailableReason(packageResult)));
        else if (!packages.has(packageName)) checks.push(status(slot.id, 'unsupported', tr("设备未安装 {0}，请编辑替换按钮", { 0: packageName })));
        else if (slot.action === 'sidebar') checks.push(status(slot.id, 'unknown', tr("已安装侧边栏应用；动态广播无法预检，可点击尝试")));
        else {
          const component = COMPONENTS[slot.action];
          const intent = component ? ['-n', component] : ['-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-p', packageName];
          const result = await probe(deviceId, ['cmd', 'package', 'resolve-activity', '--brief', '--user', 'current', ...intent]);
          checks.push(activityStatus(slot.id, result, packageName, component));
        }
      } else if (slot.action === 'notifications') {
        const result = await probe(deviceId, ['cmd', 'statusbar', 'help']);
        const output = String(result.stdout || '');
        if (result.ok && /\bexpand-notifications\b/.test(output)) checks.push(status(slot.id, 'supported', tr("设备提供通知栏操作")));
        else if (result.ok && /Status bar commands:/i.test(output)) checks.push(status(slot.id, 'unsupported', tr("设备未提供展开通知栏操作，请编辑替换按钮")));
        else checks.push(status(slot.id, 'unknown', unavailableReason(result)));
      } else checks.push(status(slot.id, 'supported', tr("标准 Android 按键操作")));
    }
    return { success: true, checks, checkedAt: now() };
  }
  async function check(args) {
    try {
      const deviceId = args?.deviceId;
      if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 256 || /\s|[\x00-\x1f\x7f]/.test(deviceId)) throw new Error(tr("没有可检查的设备"));
      const config = normalizeDeviceShortcuts(args?.config);
      const key = JSON.stringify([deviceId, config]);
      if (!args.force) {
        if (pending.has(key)) return await pending.get(key);
        const cached = cache.get(key);
        if (cached && now() - cached.checkedAt < cacheMs) return cached;
      }
      cache.delete(key);
      const task = schedule(() => inspect(deviceId, config));
      pending.set(key, task);
      try {
        const result = await task;
        if (pending.get(key) === task) {
          cache.set(key, result);
          if (cache.size > 200) cache.delete(cache.keys().next().value);
        }
        return result;
      } finally { if (pending.get(key) === task) pending.delete(key); }
    } catch (error) { return { success: false, error: error.message }; }
  }
  return { check };
}

function register(ipcMain) {
  const service = createCapabilityService();
  ipcMain.handle('device-shortcuts:check', (_event, args) => service.check(args));
}

module.exports = { register, createCapabilityService, CACHE_MS };
