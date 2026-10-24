import { tr } from './i18n.js';
export const TASK_DRAFT_KEY = 'adb-workbench.task-center.draft.v1';

export function draftFingerprint(draft) {
  return JSON.stringify(draft);
}

export function resolveScriptAfterSave(selectedScript, savedScript) {
  return savedScript?.id === selectedScript.id ? savedScript : selectedScript;
}

export function readTaskDraft(storage) {
  try {
    const raw = (storage || globalThis.localStorage).getItem(TASK_DRAFT_KEY);
    if (!raw) return { workspace: null, error: '' };
    const workspace = JSON.parse(raw);
    if (workspace.version !== 1 || !workspace.draft || !Array.isArray(workspace.draft.steps)) {
      throw new Error(tr("草稿格式不兼容"));
    }
    return { workspace, error: '' };
  } catch (error) {
    return { workspace: null, error: tr("本地草稿读取失败：{0}", { 0: error.message }) };
  }
}

export function writeTaskDraft(workspace, storage) {
  try {
    (storage || globalThis.localStorage).setItem(TASK_DRAFT_KEY, JSON.stringify({ ...workspace, version: 1 }));
    return '';
  } catch (error) {
    return tr("本地草稿保存失败：{0}。请使用“保存脚本”保护当前工作。", { 0: error.message });
  }
}

export function getTaskStatusLabel(status) {
  return ({
    queued: tr("排队中"), running: tr("运行中"), success: tr("已完成"),
    passed: tr("已通过"), failed: tr("失败"), cancelled: tr("已取消")
  })[status] || status || tr("未知状态");
}

export function getMatchingBaseline(baselines, deviceId, selectedPath) {
  const matching = baselines.filter(item => item.deviceId === deviceId);
  return matching.find(item => item.path === selectedPath) || matching[0] || null;
}

export function getAcceptanceErrors({ suiteId, packageName, apkPath, baselineImagePath, rounds, launchWaitMs, threshold }) {
  const errors = {};
  if (suiteId === 'install-launch' || suiteId === 'launch-stability') {
    if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(packageName.trim())) {
      errors.packageName = tr("请输入有效包名，例如 com.example.app");
    }
    if (!Number.isFinite(launchWaitMs) || launchWaitMs < 1000 || launchWaitMs > 60000) {
      errors.launchWaitMs = tr("首屏等待需要在 1000–60000 ms 之间");
    }
  }
  if (suiteId === 'install-launch' && !apkPath.trim()) errors.apkPath = tr("请选择要安装的 APK 文件");
  if (suiteId === 'visual-compare') {
    if (!baselineImagePath.trim()) errors.baselineImagePath = tr("请选择截图基线 PNG");
    if (!Number.isFinite(threshold) || threshold < 1 || threshold > 100) errors.threshold = tr("相似度需要在 1–100% 之间");
  }
  if (suiteId === 'launch-stability' && (!Number.isInteger(rounds) || rounds < 1 || rounds > 100)) {
    errors.rounds = tr("启动轮次需要是 1–100 之间的整数");
  }
  return errors;
}

export function qualityErrorMessage(message) {
  const messages = {
    apk_required: tr("请选择要安装的 APK 文件"),
    baseline_image_required: tr("请选择截图基线 PNG"),
    package_name_invalid: tr("应用包名格式不正确，请检查后重试"),
    baseline_required: tr("请先为当前设备选择或采集基线"),
    baseline_invalid: tr("基线文件无法读取，请重新采集"),
    device_required: tr("请先选择在线设备")
  };
  if (String(message).startsWith('file_not_found:')) return tr("文件不存在，请重新选择：{0}", { 0: message.slice(15) });
  if (String(message).startsWith('device_offline:')) return tr("目标设备已离线，请重新连接后重试");
  return messages[message] || message || tr("操作失败，请重试");
}
