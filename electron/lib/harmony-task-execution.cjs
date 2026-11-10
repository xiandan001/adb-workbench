const fs = require('node:fs');
const path = require('node:path');
const { tr } = require('./localization.cjs');
const { runHdc } = require('./hdc-runtime.cjs');
const { resolveDeviceRef } = require('./device-registry.cjs');
const { captureHarmonyLayout, performHarmonyInput, probeHarmonyUi, buildHarmonyInput } = require('./harmony-task-ui.cjs');

async function withHarmonyTask(task, deviceId, action) {
  if (task.cancelled) throw Object.assign(new Error(tr('用户取消')), { code: 'CANCELLED' });
  if (!path.isAbsolute(task.hdcPath || '')) throw new Error(tr('任务缺少可信 HDC 路径，未执行。'));
  const deviceRef = resolveDeviceRef(deviceId, { deviceRef: task.deviceRefs?.[deviceId] });
  if (deviceRef.transport !== 'hdc') throw new Error(tr('设备通道与目标不匹配。'));
  const owned = new Set();
  const cached = task.uitestCapabilities?.[deviceId];
  const options = { command: task.hdcPath, deviceRef, isCancelled: () => task.cancelled,
    ...(cached?.generation === deviceRef.generation ? { uitestCapabilities: cached } : {}),
    onProcess(proc) { owned.add(proc); task.procs?.add?.(proc); task.currentProc = proc; } };
  try { return await action(options); }
  finally { for (const proc of owned) task.procs?.delete?.(proc); if (owned.has(task.currentProc)) task.currentProc = null; }
}

async function preflightHarmonyInputs(task, deviceId, signal, run = runHdc) {
  const inputs = (task.script.steps || []).filter(step => ['tap', 'longPress', 'swipe', 'input', 'keyevent'].includes(step.type));
  if (!inputs.length) return;
  await withHarmonyTask(task, deviceId, async options => {
    const hasExplicitInputTarget = step => step.type === 'input' && (Object.keys(selectorOf({ ...step, text: step.selector?.text || '', textContains: step.selector?.textContains || '' })).length
      || step.x != null && step.y != null);
    const requireFocusText = inputs.some(step => step.type === 'input' && !hasExplicitInputTarget(step));
    const capabilities = await probeHarmonyUi(deviceId, { ...options, signal, timeoutMs: 8000, requireFocusText }, run);
    const operations = { tap: 'click', longPress: 'longClick', swipe: 'swipe', keyevent: 'keyEvent' };
    for (const step of inputs) {
      const explicitInputTarget = hasExplicitInputTarget(step);
      const operation = step.type === 'input' ? (explicitInputTarget ? 'inputText' : 'text') : operations[step.type];
      if (step.type === 'input') buildHarmonyInput(step, explicitInputTarget ? { x: 1, y: 1 } : null, capabilities);
      if (!capabilities.actions.includes(operation)) throw new Error(tr('所选设备 UITest 不支持此输入操作，未执行。'));
    }
    task.uitestCapabilities ||= {};
    task.uitestCapabilities[deviceId] = { ...capabilities, generation: options.deviceRef.generation };
  });
}

function selectorOf(step) {
  const selector = step.selector || {};
  return Object.fromEntries(['text', 'textContains', 'resourceId', 'contentDesc', 'className', 'xpath', 'packageName']
    .map(key => [key, String(step[key] || selector[key] || '').trim()]).filter(([, value]) => value));
}

function matchHarmonyNode(node, selector) {
  const attrs = node.attrs;
  const fields = { text: 'text', resourceId: 'resource-id', contentDesc: 'content-desc', className: 'class', packageName: 'package' };
  for (const [key, attr] of Object.entries(fields)) if (selector[key] && selector[key] !== attrs[attr]) return false;
  if (selector.textContains && !attrs.text.includes(selector.textContains)) return false;
  return !selector.xpath || selector.xpath === node.xpath;
}

async function findHarmonyNode(deviceId, step, options, capture = captureHarmonyLayout) {
  const selector = selectorOf(step);
  if (!Object.keys(selector).length) return null;
  const { nodes } = await capture(deviceId, options);
  const matches = nodes.filter(node => matchHarmonyNode(node, selector));
  if (matches.length > 1) throw new Error(tr('鸿蒙控件匹配不唯一，请重新读取并选择更明确的控件。'));
  return matches[0] || null;
}

async function harmonyPoint(deviceId, step, options) {
  const targetStep = step.type === 'input' ? { ...step, text: step.selector?.text || '', textContains: step.selector?.textContains || '' } : step;
  if (Object.keys(selectorOf(targetStep)).length) {
    const node = await findHarmonyNode(deviceId, targetStep, options);
    if (!node) throw new Error(tr('未找到所选鸿蒙控件，未使用旧坐标代替。'));
    return { x: Math.round((node.bounds.left + node.bounds.right) / 2), y: Math.round((node.bounds.top + node.bounds.bottom) / 2) };
  }
  if (step.x === null || step.y === null || step.x === undefined || step.y === undefined || step.x === '' || step.y === '') return null;
  return { x: step.x, y: step.y };
}

async function waitHarmonyNode(task, deviceId, step, options, sleep) {
  const deadline = Date.now() + (step.type === 'assertText' ? 0 : step.timeoutMs || 30000);
  do {
    const node = await findHarmonyNode(deviceId, step, options);
    if (node) return { ok: true, output: tr('已找到目标控件') };
    if (step.type === 'assertText' || Date.now() >= deadline || task.cancelled) break;
    await sleep(task, Math.min(step.intervalMs || 1000, Math.max(0, deadline - Date.now())));
  } while (!task.cancelled);
  return { ok: false, error: task.cancelled ? tr('用户取消') : tr('未找到所选鸿蒙控件，未使用旧坐标代替。') };
}

async function waitHarmonyLog(task, deviceId, step, options, sleep) {
  const keyword = String(step.keyword || '').trim(), expression = String(step.regex || '').trim();
  if (!keyword && !expression) return { ok: false, error: tr('请填写等待日志的关键词或正则。') };
  const regex = expression ? new RegExp(expression, 'i') : null;
  const deadline = Date.now() + (step.timeoutMs || 30000);
  while (!task.cancelled && Date.now() < deadline) {
    const result = await require('./harmony-log.cjs').readHiLogSnapshot(deviceId, { ...options, maxLines: 2000, timeoutMs: Math.min(10000, step.timeoutMs || 30000) });
    if (!result.ok) return result;
    const text = String(result.stdout || '');
    if (regex ? regex.test(text) : text.includes(keyword)) return { ok: true, output: text.slice(-12000) };
    await sleep(task, Math.min(step.intervalMs || 1000, Math.max(0, deadline - Date.now())));
  }
  return { ok: false, error: task.cancelled ? tr('用户取消') : tr('等待日志超时：{0}', { 0: keyword || expression }) };
}

async function executeHarmonyCoreStep(task, deviceId, step, sleep) {
  const types = ['shell', 'installApk', 'launchApp', 'pushFile', 'tap', 'longPress', 'swipe', 'input', 'keyevent', 'waitText', 'assertText', 'waitLog'];
  if (!types.includes(step.type)) return null;
  return withHarmonyTask(task, deviceId, async base => {
    const options = { ...base, timeoutMs: step.timeoutMs || 30000 };
    if (step.type === 'shell') {
      if (!String(step.command || '').trim()) return { ok: false, error: tr('请填写命令') };
      return runHdc(deviceId, ['shell', step.command], options);
    }
    if (step.type === 'installApk') return require('./harmony-apps.cjs').installPackage(deviceId, step.localPath, options);
    if (step.type === 'launchApp') return require('./harmony-apps.cjs').launchPackage(deviceId, step.packageName, options);
    if (step.type === 'pushFile') {
      if (!path.isAbsolute(step.localPath || '') || !fs.statSync(step.localPath).isFile() || !String(step.remotePath || '').startsWith('/')
        || /[\0\r\n]/.test(step.remotePath) || step.remotePath.length > 4096) return { ok: false, error: tr('请选择有效的本地文件与设备路径。') };
      return runHdc(deviceId, ['file', 'send', step.localPath, step.remotePath], options);
    }
    if (step.type === 'waitLog') return waitHarmonyLog(task, deviceId, step, options, sleep);
    if (['waitText', 'assertText'].includes(step.type)) return waitHarmonyNode(task, deviceId, step, options, sleep);
    const point = step.type === 'keyevent' ? null : await harmonyPoint(deviceId, step, options);
    return performHarmonyInput(deviceId, step, point, options);
  });
}

function parseHarmonyUdid(output) {
  const text = String(output || '').trim();
  const match = /^(?:udid of current device is:\s*)?([a-f\d]{8,128})$/i.exec(text);
  if (!match || /^0+$/.test(match[1])) return '';
  return match[1].toLowerCase();
}

async function readHarmonyIdentity(task, deviceId) {
  return withHarmonyTask(task, deviceId, async options => {
    const result = await runHdc(deviceId, ['shell', 'bm', 'get', '-u'], { ...options, timeoutMs: 5000, maxBuffer: 4096 });
    return { transport: 'hdc', harmonyUdid: result.ok ? parseHarmonyUdid(result.stdout) : '' };
  });
}

async function detectHarmonyCrashAnr(task, deviceId, acceptance) {
  return withHarmonyTask(task, deviceId, async options => {
    const result = await require('./harmony-log.cjs').readHiLogSnapshot(deviceId, { ...options, maxLines: 300, timeoutMs: 10000 });
    if (!result.ok) return { ok: false, warnings: [{ type: 'collection', label: tr('鸿蒙异常日志采集失败，不能判定压测通过。'), fail: true }] };
    const text = String(result.stdout || ''), warnings = [];
    if (acceptance.failOnCrash && /\b(?:JS_CRASH|JS_ERROR|CPP_CRASH|APP_CRASH)\b/i.test(text)) warnings.push({ type: 'crash', label: tr('检测到崩溃日志'), fail: true });
    if (acceptance.failOnAnr && /\b(?:APP_FREEZE|AppFreeze)\b/i.test(text)) warnings.push({ type: 'anr', label: tr('检测到鸿蒙应用无响应日志'), fail: true });
    return { ok: !warnings.length, warnings };
  });
}

module.exports = { withHarmonyTask, selectorOf, matchHarmonyNode, findHarmonyNode, executeHarmonyCoreStep, parseHarmonyUdid, readHarmonyIdentity, detectHarmonyCrashAnr, preflightHarmonyInputs };
