const { tr } = require('./localization.cjs');
const { normalizeDiagnostic } = require('./ai-workspace-diagnostics.cjs');
const { readHiLogSnapshot } = require('./harmony-log.cjs');

function createHarmonyEvidence({ runHdc = (...args) => require('./hdc-runtime.cjs').runHdc(...args),
  resolve = (...args) => require('./device-registry.cjs').resolveDeviceRef(...args),
  getPackageDetail = (...args) => require('./harmony-apps.cjs').getPackageDetail(...args),
  collectMetrics = (...args) => require('./harmony-metrics.cjs').collectHarmonySnapshot(...args) } = {}) {
  async function read(deviceId, args, signal, maxBuffer = 256 * 1024) {
    if (signal?.aborted) throw Object.assign(new Error(tr('操作已取消')), { code: 'CANCELLED', safe: true });
    const result = await runHdc(deviceId, args, { signal, timeoutMs: 12000, maxBuffer });
    if (signal?.aborted || result.cancelled) throw Object.assign(new Error(tr('操作已取消')), { code: 'CANCELLED', safe: true });
    const text = String(result.stdout || '');
    if (!result.ok || /^(?:\[Fail\]|error:|unknown (?:command|option)|.*(?:not found|permission denied))\b/im.test(text)) {
      throw Object.assign(new Error(result.error || tr('鸿蒙只读检查不可用，不能据此判断设备或应用正常。')), { code: 'HARMONY_CHECK_UNAVAILABLE', safe: true });
    }
    return text.trim();
  }
  async function verifyTarget(deviceId, signal) {
    const ref = resolve(deviceId);
    if (ref.transport !== 'hdc') throw new Error(tr('所选设备不是 HDC 设备。'));
    if (await read(deviceId, ['shell', 'echo', 'AWB_READY'], signal, 1024) !== 'AWB_READY') throw new Error(tr('所选设备已离线，未切换到其他设备。'));
    return ref;
  }
  async function readCheck(deviceId, checkId, diagnostic, signal) {
    const ref = resolve(deviceId); let text = '', unavailable = false;
    const name = normalizeDiagnostic(diagnostic)?.packageName || '';
    try {
      const capability = { device_info: 'shell', logcat_snapshot: 'logs', performance_snapshot: 'performance', app_package: 'apps', app_process: 'shell', app_memory: 'performance', app_activity: 'apps' }[checkId];
      if (capability && ref.capabilities[capability] === false) throw new Error(tr('此设备尚未提供该能力，读取结果会标记为不可用。'));
      if (checkId === 'device_info') {
        const values = [];
        for (const property of ['const.product.manufacturer', 'const.product.model', 'const.ohos.fullname', 'const.ohos.apiversion']) {
          const value = await read(deviceId, ['shell', 'param', 'get', property], signal, 32 * 1024);
          values.push(`${property}: ${value || tr('未提供')}`);
        }
        text = values.join('\n');
      } else if (checkId === 'logcat_snapshot') {
        const result = await readHiLogSnapshot(deviceId, { signal }, { runHdc });
        if (signal?.aborted || result.cancelled) throw Object.assign(new Error(tr('操作已取消')), { code: 'CANCELLED' });
        if (!result.ok) throw new Error(result.error || tr('HiLog 快照读取失败。'));
        text = String(result.stdout || '');
        if (!text.trim()) { unavailable = true; text = tr('日志缓冲暂无可读日志，不能据此确认没有异常。'); }
      } else if (checkId === 'performance_snapshot') {
        const snapshot = await collectMetrics(deviceId, { signal, timeoutMs: 12000 });
        unavailable = Boolean(snapshot.sampleError) && ![snapshot.cpu?.usage, snapshot.memory?.totalKb].some(Number.isFinite);
        text = JSON.stringify(snapshot, null, 2);
      } else {
        if (!name) throw new Error(tr('专项检查需要明确选择应用包名。'));
        if (checkId === 'app_package') {
          if (ref.capabilities.apps === false) throw new Error(tr('设备未提供可用的 Bundle 查询能力。'));
          const detail = await getPackageDetail(deviceId, name, { signal, timeoutMs: 12000, maxBuffer: 256 * 1024 });
          text = JSON.stringify({ bundleName: detail.bundleName, versionName: detail.versionName, versionCode: detail.versionCode,
            system: detail.system, enabled: detail.enabled, abilities: detail.abilities, permissions: detail.permissions }, null, 2);
        } else if (checkId === 'app_process' || checkId === 'app_memory') {
          const output = await read(deviceId, ['shell', 'pidof', name], signal, 16 * 1024);
          if (!/^\d+(?:\s+\d+)*$/.test(output)) throw new Error(tr('未取得与 Bundle 名同名的进程；自定义进程名需另行核对，不能据此确认应用已退出。'));
          const pids = output.split(/\s+/).slice(0, 4);
          const parts = [tr('按 Bundle 同名进程查询：{0}', { 0: name }), `PID: ${pids.join(', ')}`];
          if (checkId === 'app_memory') for (const pid of pids) parts.push(await read(deviceId, ['shell', 'hidumper', '--mem', pid], signal));
          text = parts.join('\n');
        } else if (checkId === 'app_activity') {
          const output = await read(deviceId, ['shell', 'hidumper', '-s', 'AbilityManagerService', '-a', '-a'], signal);
          const exact = new RegExp(`(?:^|[^A-Za-z0-9_.])${name.replace(/\./g, '\\.')}($|[^A-Za-z0-9_.])`);
          const matching = output.split(/\r?\n/).filter(line => exact.test(line)).slice(0, 2000);
          if (!matching.length) throw new Error(tr('没有取得目标 Bundle 的 Ability 状态，不能据此确认应用正常。'));
          text = matching.join('\n');
        } else throw new Error(tr('鸿蒙只读检查类型无效。'));
      }
    } catch (error) {
      if (signal?.aborted || error.code === 'CANCELLED' || error.name === 'AbortError') throw Object.assign(error, { code: 'CANCELLED' });
      unavailable = true; text = `${tr('检查不可用，未将缺失数据视为正常。')}\n${error.message}`;
    }
    return { kind: 'hdc', platform: 'harmony', checkId, target: deviceId, deviceId, text, unavailable,
      ...(checkId.startsWith('app_') ? { diagnostic } : {}) };
  }
  return { verifyTarget, readCheck };
}

module.exports = { createHarmonyEvidence };
