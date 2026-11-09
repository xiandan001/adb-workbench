import { tr } from './i18n.js';

export function isHarmonyDevice(device) {
  const id = typeof device === 'string' ? device : device?.id;
  return typeof id === 'string' && id.startsWith('hdc:');
}
export function platformLabel(device) { return isHarmonyDevice(device) ? tr('鸿蒙 / OpenHarmony') : 'Android'; }
export function displayDeviceId(device) { return device?.displayId || (isHarmonyDevice(device) ? device.id.slice(4) : device?.id) || ''; }
export function deviceRemoteRoot(device) { return isHarmonyDevice(device) ? '/data/local/tmp' : '/sdcard'; }
export function applicationPackageExtensions(device) { return isHarmonyDevice(device) ? ['hap', 'hsp'] : ['apk']; }
