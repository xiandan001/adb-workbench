const { isHarmonyDevice, shellQuote, unsupportedDeviceOperation } = require('./device-platform.cjs');

// Script/UI key codes retain their Android meanings; only verified semantic equivalents cross transports.
const HARMONY_KEYS = new Map([
  ['3', 'Home'], ['KEYCODE_HOME', 'Home'], ['HOME', 'Home'],
  ['4', 'Back'], ['KEYCODE_BACK', 'Back'], ['BACK', 'Back'],
  ['26', 'Power'], ['KEYCODE_POWER', 'Power'], ['POWER', 'Power'],
  ['24', '16'], ['KEYCODE_VOLUME_UP', '16'], ['25', '17'], ['KEYCODE_VOLUME_DOWN', '17'],
  ['66', '2054'], ['KEYCODE_ENTER', '2054'], ['67', '2055'], ['KEYCODE_DEL', '2055'],
  ['82', '2067'], ['KEYCODE_MENU', '2067']
]);
function harmonyShellCommand(words, ref) {
  const command = words.length === 1 ? words[0] : words.map(shellQuote).join(' ');
  const logical = words.length === 1 ? words[0] : words.join(' ');
  const key = /^input keyevent (\w+)\s*$/.exec(logical);
  if (key) {
    const code = HARMONY_KEYS.get(key[1].toUpperCase());
    if (!code || ref.capabilities?.ui === false) throw unsupportedDeviceOperation('keyEvent');
    return ['shell', 'uitest', 'uiInput', 'keyEvent', code];
  }
  const tap = /^input tap (\d+) (\d+)\s*$/.exec(logical);
  if (tap) {
    if (ref.capabilities?.ui === false) throw unsupportedDeviceOperation('tap');
    return ['shell', 'uitest', 'uiInput', 'click', tap[1], tap[2]];
  }
  if (/^(?:getprop|pm|am|cmd package|dumpsys|uiautomator|logcat|screencap|screenrecord|input)\b/.test(logical.trim())) {
    throw unsupportedDeviceOperation(logical.trim().split(/\s+/)[0]);
  }
  return ['shell', command];
}
function compileHdcOperation(args, ref) {
  if (!Array.isArray(args) || !args.length) throw unsupportedDeviceOperation('empty');
  const [operation, ...rest] = args;
  if (operation === 'get-state' && !rest.length) return { args: ['shell', "printf '__AWB_DEVICE_READY__'"], state: true };
  if (operation === 'shell' && rest.length) return { args: harmonyShellCommand(rest, ref) };
  if (['push', 'pull'].includes(operation) && rest.length === 2 && !rest[0].startsWith('-')) {
    return { args: ['file', operation === 'push' ? 'send' : 'recv', ...rest] };
  }
  if (operation === 'install') {
    const files = rest.filter(value => value !== '-r');
    if (!files.length || files.some(value => value.startsWith('-') || !/\.(?:hap|hsp)$/i.test(value))) throw unsupportedDeviceOperation('install');
    return { args: ['install', ...(rest.includes('-r') ? ['-r'] : []), ...files] };
  }
  if (operation === 'uninstall' && rest.length === 1 && !rest[0].startsWith('-')) return { args: ['uninstall', ...rest] };
  if (operation === 'reboot' && rest.length <= 1 && (!rest.length || ['bootloader', 'recovery'].includes(rest[0]))) {
    return { args: ['target', 'boot', ...rest.map(value => '-' + value)] };
  }
  if (operation === 'root' && !rest.length) return { args: ['smode'] };
  if (operation === 'remount' && !rest.length) return { args: ['target', 'mount'] };
  throw unsupportedDeviceOperation(operation);
}
function deviceIdFromAdbArgs(args) {
  const index = args.indexOf('-s');
  return index >= 0 ? args[index + 1] || '' : '';
}
function isHdcInvocation(args) { return isHarmonyDevice(deviceIdFromAdbArgs(args)); }
module.exports = { HARMONY_KEYS, harmonyShellCommand, compileHdcOperation, deviceIdFromAdbArgs, isHdcInvocation };
