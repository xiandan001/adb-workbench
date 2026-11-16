import { tr } from './i18n.js';
import { taskPlatformMismatch, adaptPristineBuiltin } from './taskPlatform.js';

export function prepareSavedTaskRun({ script, deviceIds, devices, outputBaseDir = '' }) {
  if (!Array.isArray(deviceIds) || !deviceIds.length) throw new Error(tr('请至少选择一台在线设备'));
  const targets = [...new Set(deviceIds)];
  if (targets.some(id => !devices.some(device => device.id === id && device.status === 'device'))) {
    throw new Error(tr('所选设备已离线，请重新连接或取消勾选离线设备'));
  }
  const adapted = targets.every(id => String(id).startsWith('hdc:')) ? adaptPristineBuiltin(script, targets[0]) : null;
  const snapshot = JSON.parse(JSON.stringify(adapted || script));
  if (taskPlatformMismatch(snapshot, targets)) throw new Error(tr('任务平台与设备不一致，请为当前设备新建任务；旧脚本不会自动转换。'));
  if (snapshot.aiTargetDeviceId && (targets.length !== 1 || targets[0] !== snapshot.aiTargetDeviceId)) {
    throw new Error(tr('此 AI 控件任务仅适用于来源设备 {0}；请选回原设备，或在新设备重新读取并选择控件。', { 0: snapshot.aiTargetDeviceId }));
  }
  if (!Array.isArray(snapshot.steps) || !snapshot.steps.length) throw new Error(tr('请先添加测试步骤。'));
  return { script: snapshot, deviceIds: targets, outputBaseDir, continueOnError: snapshot.continueOnError, concurrency: 1 };
}
