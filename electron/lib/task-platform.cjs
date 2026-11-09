const { tr } = require('./localization.cjs');
const { devicePlatform } = require('./device-platform.cjs');
const { buildHarmonyInput } = require('./harmony-task-ui.cjs');

function taskPlatform(script) {
  if (script?.targetPlatform !== undefined && !['android', 'harmony'].includes(script.targetPlatform)) throw new Error(tr('任务平台无效。'));
  return script?.targetPlatform || 'android';
}
function assertTaskPlatform(script, deviceIds) {
  const platform = taskPlatform(script);
  if (deviceIds.some(id => devicePlatform(id) !== platform)) throw Object.assign(new Error(tr('任务与所选设备平台不一致；旧 Android 脚本不会自动转换为鸿蒙脚本。请在对应设备新建任务。')), { code: 'TASK_PLATFORM_MISMATCH' });
  if (platform !== 'harmony') return;
  for (const step of script.steps || []) {
    if (step.type === 'launchApp' && !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(String(step.packageName || ''))) throw new Error(tr('请填写有效的鸿蒙 Bundle 名称后再运行。'));
    if (step.type === 'installApk' && !/\.(?:hap|hsp)$/i.test(String(step.localPath || ''))) throw new Error(tr('鸿蒙任务安装步骤需要 HAP/HSP 文件，不能安装 APK。'));
    if (step.type === 'longPress') buildHarmonyInput(step, { x: 0, y: 0 }, {});
    if (step.type === 'keyevent') buildHarmonyInput(step, null, {});
    if (step.type === 'swipe' && step.x !== null && step.y !== null) buildHarmonyInput(step, { x: step.x, y: step.y }, {});
    if (step.type === 'externalScript' && (step.adapter && step.adapter !== 'custom' || [step.command, step.args, step.scriptPath].some(value => /\{adb\}/.test(String(value || ''))))) {
      throw new Error(tr('鸿蒙外部脚本需使用 custom 适配器及 {hdc}/{targetKey}，不能沿用 Android {adb} 参数。'));
    }
  }
}
function sameTaskPlatform(record, deviceId) {
  const platform = record.targetPlatform || 'android';
  return platform === devicePlatform(deviceId);
}
module.exports = { taskPlatform, assertTaskPlatform, sameTaskPlatform };
