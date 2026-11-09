import { tr } from './i18n.js';

export const taskPlatformForDevice = id => String(id || '').startsWith('hdc:') ? 'harmony' : 'android';
export const taskPlatformMismatch = (script, ids) => ids.some(id => taskPlatformForDevice(id) !== (script.targetPlatform || 'android'));

export function adaptPristineBuiltin(script, deviceId) {
  if (taskPlatformForDevice(deviceId) !== 'harmony' || script.id !== 'default-smoke-test' || script.createdAt !== 'builtin' || script.updatedAt !== 'builtin') return null;
  return { ...script, id: 'default-harmony-smoke-test', targetPlatform: 'harmony', name: tr('鸿蒙基础复现脚本'),
    steps: script.steps.map((step, index) => index === 0 ? { ...step, command: 'param get const.product.model' } : { ...step }) };
}

export function createHarmonyTaskTemplate(templateId, seed, makeStep) {
  const step = (type, values = {}) => ({ ...makeStep(type), ...values });
  const capture = [step('screenshot'), step('perfSnapshot')];
  const launch = [step('launchApp', { packageName: '', label: tr('启动鸿蒙应用') }), step('delay', { durationMs: 2000 }), ...capture];
  const steps = {
    record: [],
    launch,
    compare: [step('screenshot'), step('imageCompare')],
    'install-launch': [step('installApk', { label: tr('安装 HAP/HSP') }), ...launch],
    'crash-capture': [launch[0], step('waitLog', { regex: 'JS_CRASH|JS_ERROR|CPP_CRASH|APP_CRASH|APP_FREEZE|AppFreeze', timeoutMs: 60000 }), step('screenshot')],
    smoke: [step('shell', { command: 'param get const.product.model' }), step('keyevent', { keyCode: 'Home' }), step('delay', { durationMs: 1000 }), ...capture],
    'performance-watch': launch
  }[templateId] || [];
  return { ...seed, targetPlatform: 'harmony', name: templateId === 'record' ? tr('鸿蒙录制流程') : tr('鸿蒙设备验证'), mode: templateId === 'record' ? 'replay' : 'stress',
    loop: { ...seed.loop, count: ['launch', 'performance-watch'].includes(templateId) ? 10 : 1 }, steps };
}
