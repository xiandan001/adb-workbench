const { deviceComparisonIdentity } = require('./task-run-manifest.cjs');
const ANDROID_IDENTITY = ["printf '__MIRROR_ANDROID_ID__'; settings get secure android_id", "printf '__MIRROR_SERIAL__'; getprop ro.serialno", "printf '__MIRROR_BOOT_SERIAL__'; getprop ro.boot.serialno", 'true'].join('; ');
async function readMirrorIdentity(deviceId, ref, { runAdb = require('./adb-runtime.cjs').runAdb, runHdc = require('./hdc-runtime.cjs').runHdc } = {}) {
  if (ref.transport === 'hdc') {
    const result = await runHdc(deviceId, ['shell', 'bm', 'get', '-u'], { timeoutMs: 1500, maxBuffer: 4096 });
    const match = /^(?:udid of current device is:\s*)?([a-f\d]{8,128})$/i.exec(result.ok ? String(result.stdout || '').trim() : '');
    return deviceComparisonIdentity({ transport: 'hdc', harmonyUdid: match?.[1] || '' });
  }
  const result = await runAdb(['-s', deviceId, 'shell', ANDROID_IDENTITY], { timeoutMs: 1500, maxBuffer: 4096 });
  const text = result.ok ? String(result.stdout || '') : '';
  const field = label => text.match(new RegExp(`__MIRROR_${label}__([^\\r\\n]*)`))?.[1]?.trim() || '';
  return deviceComparisonIdentity({ androidId: field('ANDROID_ID'), roSerialno: field('SERIAL'), roBootSerialno: field('BOOT_SERIAL') });
}
module.exports = { readMirrorIdentity };
