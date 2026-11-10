import { tr } from './i18n.js';
import { isHarmonyDevice } from './devicePlatform.js';

const ANDROID_COMMANDS = Object.freeze(['pm list packages', 'getprop ro.build.version', 'dumpsys battery', 'cat /proc/meminfo', 'ls -la /data/']);
const HARMONY_COMMANDS = Object.freeze(['bm dump -a', 'param get const.ohos.fullname', 'hidumper -s 3302 -a -i', 'cat /proc/meminfo', 'ls -la /data/']);

export function deviceTerminalCommands(device) {
  return isHarmonyDevice(device) ? HARMONY_COMMANDS : ANDROID_COMMANDS;
}

export function createDeviceTerminalRequest(device, rawCommand, { root = false, strategy = 'none' } = {}) {
  const harmony = isHarmonyDevice(device);
  const escaped = rawCommand.replace(/'/g, "'\\''");
  const command = harmony || !root ? rawCommand : strategy === 'su-c' ? `su -c '${escaped}'`
    : strategy === 'su-sh' ? `su 0 sh -c '${escaped}'` : rawCommand;
  const target = harmony ? `hdc -t ${device.id.slice(4)}` : `adb -s ${device.id}`;
  return { deviceId: device.id, command, prompt: root ? '#' : '$', text: `${target} shell "${command}"` };
}

function rootWarning(harmony) {
  if (harmony) return {
    title: tr('当前 HDC Shell 不是 ROOT'), message: tr('当前设备会话没有 ROOT 权限，不会自动提权。'),
    bullets: [tr('仅检查当前会话身份，不执行 Android su 或安装权限管理工具。'), tr('调试权限由设备系统版本和安全策略决定。')],
    detail: tr('请按设备官方调试文档核对权限；普通只读命令仍可使用。')
  };
  return {
    title: tr('设备暂不支持 su 命令'), message: tr('检测到当前设备无法以 root 身份执行命令，可能原因：'),
    bullets: [tr('设备未 Root 或未安装权限管理（如 Magisk）'), tr('已 Root 但未给 ADB Shell 授权'), tr('使用了受限用户版本的系统镜像')],
    detail: tr('请先完成 Root 并在设备端授权后，再开启 ROOT 模式。')
  };
}

export function deviceTerminalPresentation(device, root = false) {
  const harmony = isHarmonyDevice(device);
  return {
    title: harmony ? tr('HDC 终端 - {0}', { 0: device.id.slice(4) }) : tr('终端 - {0}', { 0: device.id }),
    placeholder: harmony ? root ? tr('使用当前 HDC ROOT 会话执行命令...') : tr('输入 HDC Shell 命令...')
      : root ? tr('以 ROOT 身份执行命令...') : tr('输入 ADB Shell 命令...'),
    rootTitle: harmony ? root ? tr('当前 HDC Shell 已是 ROOT；点击退出标记') : tr('检查当前 HDC Shell 的 ROOT 状态（不会提权）')
      : root ? tr('已开启 ROOT 模式，点击关闭') : tr('开启 ROOT 模式'),
    rootWarning: rootWarning(harmony)
  };
}
