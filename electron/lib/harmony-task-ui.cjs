const { randomUUID } = require('node:crypto');
const { tr } = require('./localization.cjs');
const { runHdc } = require('./hdc-runtime.cjs');
const { shellQuote, unsupportedDeviceOperation } = require('./device-platform.cjs');

const MAX_LAYOUT_BYTES = 4 * 1024 * 1024;
const MAX_NODES = 5000;
const fail = (message, controlReason = 'INVALID_INPUT', controlPhase = 'validation') => Object.assign(new Error(message),
  { code: 'HARMONY_TASK_INPUT', safe: true, controlReason, controlPhase });
const number = value => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;

function normalizeHarmonyCoordinate(value) {
  if (value === '' || value === null || value === undefined) return null;
  const coordinate = number(value);
  if (coordinate === null || !Number.isInteger(coordinate) || coordinate < 0 || coordinate > 1000000) throw fail(tr('鸿蒙操作需要有效的目标控件或屏幕坐标。'));
  if (coordinate === 0) throw fail(tr('鸿蒙 UITest 坐标必须大于 0，请调整目标位置。'));
  return coordinate;
}

function normalizeHarmonyDuration(step) {
  if (step.longPressMode === 'native' && step.durationMs == null) return null;
  if (step.durationMs === undefined || step.durationMs === null || step.durationMs === '') return 1000;
  const duration = number(step.durationMs);
  if (duration === null || duration <= 0 || duration > 600000) throw fail(tr('鸿蒙手势时长无效，未调整或忽略该参数。'));
  return duration;
}

function normalizeHarmonyPoints(value) {
  if (value === undefined || value === null || value === '') return [];
  let points = value;
  if (typeof points === 'string') {
    try { points = JSON.parse(points); } catch { throw fail(tr('鸿蒙手势路径不是有效 JSON，未忽略该参数。')); }
  }
  if (!Array.isArray(points) || points.length > 120) throw fail(tr('鸿蒙手势路径格式无效或超过上限。'));
  return points.map(point => {
    const x = normalizeHarmonyCoordinate(Array.isArray(point) ? point[0] : point?.x), y = normalizeHarmonyCoordinate(Array.isArray(point) ? point[1] : point?.y);
    if (x === null || y === null) throw fail(tr('鸿蒙手势路径缺少有效坐标。'));
    return { x, y };
  });
}

function layoutBounds(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch {
      const match = value.match(/^\s*\[(-?\d+),\s*(-?\d+)\]\[(-?\d+),\s*(-?\d+)\]\s*$/);
      if (!match) return null;
      value = { left: Number(match[1]), top: Number(match[2]), right: Number(match[3]), bottom: Number(match[4]) };
    }
  }
  if (!value || typeof value !== 'object') return null;
  const bounds = Object.fromEntries(['left', 'top', 'right', 'bottom'].map(key => [key, number(value[key])]));
  if (Object.values(bounds).some(value => value === null || Math.abs(value) > 1000000) || bounds.right <= bounds.left || bounds.bottom <= bounds.top) return null;
  return bounds;
}

function parseHarmonyLayout(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_LAYOUT_BYTES) throw fail(tr('鸿蒙界面树过大或格式无效，请缩小目标界面后重试。'));
  let tree;
  try { tree = JSON.parse(raw); } catch { throw fail(tr('鸿蒙界面树不是有效 JSON，未执行控件操作。')); }
  const nodes = [], stack = [{ value: tree, xpath: 'ROOT', bundle: '', depth: 0 }];
  let inspected = 0;
  while (stack.length) {
    const { value, xpath, bundle, depth } = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (++inspected > MAX_NODES * 3 || depth > 64) throw fail(tr('鸿蒙界面树过大或格式无效，请缩小目标界面后重试。'));
    if (Array.isArray(value)) { value.forEach((item, index) => stack.push({ value: item, xpath: `${xpath},${index}`, bundle, depth: depth + 1 })); continue; }
    const source = value.attributes && typeof value.attributes === 'object' ? value.attributes : value;
    const ownBundle = String(source.bundleName || source.bundle || source.packageName || bundle).slice(0, 500);
    const bounds = layoutBounds(source.bounds || source.Bounds);
    if (bounds) {
      if (nodes.length >= MAX_NODES) throw fail(tr('鸿蒙界面树过大或格式无效，请缩小目标界面后重试。'));
      const password = source.password === true || source.password === 'true' || source.isPassword === true || source.isPassword === 'true' || /password/i.test(String(source.inputType || ''));
      const attrs = { text: password ? '' : String(source.text || '').slice(0, 2000),
        'resource-id': String(source.id || source.resourceId || source.key || '').slice(0, 500),
        'content-desc': password ? '' : String(source.description || source.accessibilityText || source['content-desc'] || '').slice(0, 500),
        class: String(source.type || source.class || '').slice(0, 500), package: ownBundle, password: String(password),
        bounds: `[${bounds.left},${bounds.top}][${bounds.right},${bounds.bottom}]` };
      nodes.push({ attrs, bounds, xpath: String(source.hierarchy || xpath).slice(0, 2000) });
    }
    const children = value.children || value.childNodes;
    if (Array.isArray(children)) for (let index = children.length - 1; index >= 0; index--) stack.push({ value: children[index], xpath: `${xpath},${index}`, bundle: ownBundle, depth: depth + 1 });
    else if (!bounds) for (const [key, child] of Object.entries(value)) if (key !== 'attributes' && child && typeof child === 'object') stack.push({ value: child, xpath: `${xpath},${key}`, bundle: ownBundle, depth: depth + 1 });
  }
  return nodes;
}

async function captureHarmonyLayout(deviceId, options = {}, run = runHdc) {
  const remotePath = `/data/local/tmp/awb-layout-${randomUUID()}.json`;
  try {
    const dumped = await run(deviceId, ['shell', 'uitest', 'dumpLayout', '-p', remotePath], options);
    if (!dumped.ok) throw fail(dumped.error || tr('鸿蒙控件树采集失败。'));
    const read = await run(deviceId, ['shell', 'cat', remotePath], { ...options, maxBuffer: MAX_LAYOUT_BYTES });
    if (!read.ok) throw fail(read.error || tr('鸿蒙控件树读取失败。'));
    const raw = String(read.stdout || '');
    return { nodes: parseHarmonyLayout(raw), rawLength: raw.length };
  } finally {
    await run(deviceId, ['shell', `rm -f ${shellQuote(remotePath)}`], { ...options, signal: undefined, isCancelled: undefined, timeoutMs: 3000 }).catch(() => {});
  }
}

function harmonyKey(value) {
  const key = String(value || '').trim();
  const logical = { HOME: 'Home', BACK: 'Back', POWER: 'Power' }[key.toUpperCase()];
  if (logical) return logical;
  const native = /^native:(\d{1,5})$/.exec(key);
  if (native) return native[1];
  throw fail(tr('鸿蒙按键请使用 Home、Back、Power 或 native:键码；不能直接使用 Android 数字键码。'));
}

function requiredPoint(point) {
  const x = number(point?.x), y = number(point?.y);
  if (x === null || y === null || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 1000000 || y > 1000000) throw fail(tr('鸿蒙操作需要有效的目标控件或屏幕坐标。'));
  if (x === 0 || y === 0) throw fail(tr('鸿蒙 UITest 坐标必须大于 0，请调整目标位置。'));
  return [String(x), String(y)];
}

function buildHarmonyInput(step, point, capabilities) {
  const prefix = ['shell', 'uitest', 'uiInput'];
  if (step.type === 'keyevent') return [...prefix, 'keyEvent', harmonyKey(step.keyCode)];
  if (step.type === 'tap') return [...prefix, 'click', ...requiredPoint(point)];
  if (step.type === 'longPress') {
    if (step.longPressMode !== 'native' || step.durationMs !== null && step.durationMs !== undefined) throw fail(tr('UITest 长按不支持指定毫秒时长；请改用明确的“设备原生长按”步骤。'));
    return [...prefix, 'longClick', ...requiredPoint(point)];
  }
  if (step.type === 'swipe') {
    if ((step.points || []).length > 2) throw fail(tr('鸿蒙 UITest 不能保持曲线手势，请改用直线滑动步骤。'));
    const start = requiredPoint(point), end = requiredPoint({ x: step.endX, y: step.endY });
    if (step.points?.length && (step.points.length !== 2 || Number(start[0]) !== step.points[0].x || Number(start[1]) !== step.points[0].y
      || Number(end[0]) !== step.points[1].x || Number(end[1]) !== step.points[1].y)) throw fail(tr('鸿蒙滑动路径与起止坐标不一致，未忽略路径参数。'));
    const duration = number(step.durationMs), distance = Math.hypot(Number(end[0]) - Number(start[0]), Number(end[1]) - Number(start[1]));
    const velocity = duration > 0 ? Math.round(distance * 1000 / duration) : 0;
    if (!distance || velocity < 200 || velocity > 40000) throw fail(tr('该滑动时长无法转换为 UITest 支持的 200–40000 px/s，请调整距离或时长。'));
    return [...prefix, 'swipe', ...start, ...end, String(velocity)];
  }
  if (step.type === 'input') {
    const text = String(step.text || '');
    if (!text || text.includes('\0')) throw fail(tr('请输入有效文本。'));
    if (point) return [...prefix, 'inputText', ...requiredPoint(point), text];
    if (!(capabilities.apiVersion >= 18 && capabilities.focusText)) throw fail(tr('当前焦点输入需要 API 18 及以上且 UITest 支持 text；请选中输入控件或填写坐标。'), 'UNSUPPORTED', 'api');
    return [...prefix, 'text', text];
  }
  throw unsupportedDeviceOperation(step.type);
}

function notify(callback, value) {
  try { Promise.resolve(callback?.(value)).catch(() => {}); } catch { /* Observer failures never change an input result. */ }
}
function controlError(reason, phase) {
  const messages = {
    HELP_UNAVAILABLE: tr('未能确认设备的 UITest 输入能力，未发送控制命令。'),
    API_UNAVAILABLE: tr('未能读取鸿蒙 API 版本，未发送文本。'),
    UNSUPPORTED: tr('所选设备 UITest 不支持此输入操作，未执行。'),
    REMOTE_EXIT: tr('设备命令返回失败，请检查应用日志中的控制阶段。'),
    REMOTE_UNCONFIRMED: tr('未确认设备命令完成，未将操作标记为成功。'),
    TRANSPORT_ERROR: tr('HDC 控制连接失败，请检查设备连接后重试。'),
    TIMEOUT: tr('鸿蒙控制命令超时，请稍后重试。'),
    CANCELLED: tr('用户取消'),
    PERMISSION_DENIED: tr('设备拒绝了控制权限，请检查设备调试授权。'),
    UITEST_ERROR: tr('设备 UITest 未能完成此操作，请查看应用日志。'),
    INVALID_INPUT: tr('鸿蒙输入参数无效，未发送控制命令。')
  };
  const error = fail(messages[reason], reason, phase);
  if (reason === 'CANCELLED') error.code = 'CANCELLED';
  return error;
}
function assertControlCurrent(options, phase) {
  if (options.signal?.aborted || options.isCancelled?.()) throw controlError('CANCELLED', phase);
  options.assertCurrent?.();
}
function completionMetadata(result) {
  const fields = {};
  if (Number.isInteger(result?.hostCode) && result.hostCode >= -2147483648 && result.hostCode <= 4294967295) fields.hostCode = result.hostCode;
  if (Number.isInteger(result?.remoteCode) && result.remoteCode >= 0 && result.remoteCode <= 255) fields.remoteCode = result.remoteCode;
  if (['confirmed', 'missing', 'not-requested'].includes(result?.completion)) fields.completion = result.completion;
  if (typeof result?.transportFailure === 'boolean') fields.transportFailure = result.transportFailure;
  return fields;
}
function uiOutputFailure(result) {
  const lines = [result.stdout, result.stderr].map(value => String(value || '')).join('\n').split(/\r?\n/).map(line => line.trim());
  // UITest CLI prints these exact exception/validation messages even when some
  // versions return EXIT_SUCCESS. Ordinary text containing "error" is not one.
  if (lines.some(line => /^(?:(?:\/system\/bin\/)?sh:\s*(?:uitest|param):\s*)?Permission denied[.!]?$/.test(line))) return 'PERMISSION_DENIED';
  if (lines.some(line => /^(?:Invalid display id\.|Set pasteBoard data failed\.)$/.test(line))) return 'UITEST_ERROR';
  if (lines.some(line => /^(?:Missing parameter\.|Invalid parameters\.|The number of parameters is incorrect\.|Too many parameters\.|Please confirm that the coordinate values are correct\.|The swipe velocity out of range, the default value will be used\.)$/.test(line))) return 'INVALID_INPUT';
  return '';
}
function resultFailure(result, phase) {
  if (result?.cancelled) return 'CANCELLED';
  if (result?.timedOut) return 'TIMEOUT';
  if (result?.transportFailure) return 'TRANSPORT_ERROR';
  const outputFailure = phase === 'execute' && result ? uiOutputFailure(result) : '';
  if (outputFailure) return outputFailure;
  if (result?.completion && result.completion !== 'confirmed') return 'REMOTE_UNCONFIRMED';
  if (Number.isInteger(result?.remoteCode) && result.remoteCode !== 0) return 'REMOTE_EXIT';
  if (Number.isInteger(result?.hostCode) && result.hostCode !== 0) return 'TRANSPORT_ERROR';
  return result?.ok ? '' : 'REMOTE_EXIT';
}
async function runInputPhase(deviceId, args, options, run, phase, validate) {
  assertControlCurrent(options, phase);
  const started = Date.now();
  const trace = (outcome, reason, result) => notify(options.onControlTrace, { phase, outcome,
    ...(reason ? { reason } : {}), durationMs: Math.max(0, Math.min(3600000, Date.now() - started)), ...completionMetadata(result) });
  trace('started');
  let result;
  try { result = await run(deviceId, args, { ...options, remoteExit: true }); }
  catch {
    try { assertControlCurrent(options, phase); } catch (error) { trace('cancelled', 'CANCELLED'); throw error; }
    trace('failure', 'TRANSPORT_ERROR'); throw controlError('TRANSPORT_ERROR', phase);
  }
  try { assertControlCurrent(options, phase); } catch (error) { trace('cancelled', 'CANCELLED', result); throw error; }
  const reason = resultFailure(result, phase) || validate?.(result) || '';
  trace(reason === 'CANCELLED' ? 'cancelled' : reason ? 'failure' : 'success', reason, result);
  return reason ? { ...result, ok: false, error: controlError(reason, phase).message, controlReason: reason, controlPhase: phase } : result;
}
function parseCapabilities(help, cached = {}) {
  if (typeof help !== 'string' || Buffer.byteLength(help) > 64 * 1024 || help.includes('\0')) return null;
  const actions = new Set();
  const allowed = new Set(['click', 'doubleClick', 'longClick', 'swipe', 'drag', 'fling', 'dircFling', 'keyEvent', 'inputText', 'text']);
  for (const line of help.split(/\r?\n/)) {
    const match = /^\s*(?:uitest\s+uiInput\s+)?([A-Za-z]+(?:\/[A-Za-z]+)*)\s*(?=<|\[|$)/.exec(line);
    if (match) for (const operation of match[1].split('/')) if (allowed.has(operation)) actions.add(operation);
  }
  if (!actions.size) return null;
  return { help, actions: [...actions], focusText: actions.has('text'),
    apiVersion: Number.isInteger(cached.apiVersion) && cached.apiVersion > 0 && cached.apiVersion <= 10000 ? cached.apiVersion : null };
}
function publishCapabilities(options, capabilities) {
  assertControlCurrent(options, 'help');
  notify(options.onUiCapabilities, { ...capabilities, actions: [...capabilities.actions] });
}
async function probeHarmonyUi(deviceId, options = {}, run = runHdc) {
  assertControlCurrent(options, 'help');
  let capabilities = parseCapabilities(options.uitestCapabilities?.help, options.uitestCapabilities);
  if (!capabilities) {
    const help = await runInputPhase(deviceId, ['shell', 'uitest', 'help'], { ...options, maxBuffer: 64 * 1024 }, run, 'help',
      result => parseCapabilities(String(result.stdout || '')) ? '' : 'HELP_UNAVAILABLE');
    if (!help.ok) throw controlError(help.controlReason, 'help');
    capabilities = parseCapabilities(String(help.stdout || ''));
    publishCapabilities(options, capabilities);
  }
  if (options.requireFocusText && !capabilities.focusText) throw controlError('UNSUPPORTED', 'help');
  if (options.requireFocusText && capabilities.apiVersion === null) {
    const api = await runInputPhase(deviceId, ['shell', 'param', 'get', 'const.ohos.apiversion'], { ...options, maxBuffer: 4096 }, run, 'api',
      result => /^[1-9]\d{0,3}$/.test(String(result.stdout || '').trim()) ? '' : 'API_UNAVAILABLE');
    if (!api.ok) throw controlError(api.controlReason === 'CANCELLED' ? 'CANCELLED' : 'API_UNAVAILABLE', 'api');
    capabilities = { ...capabilities, apiVersion: Number(String(api.stdout).trim()) };
    publishCapabilities(options, capabilities);
  }
  return capabilities;
}

async function performHarmonyInput(deviceId, step, point, options = {}, run = runHdc) {
  // Parameter errors fail before even querying a device; only focus input needs capabilities first.
  assertControlCurrent(options, 'validation');
  if (step.type !== 'input' || point) buildHarmonyInput(step, point, {});
  const capabilities = await probeHarmonyUi(deviceId, { ...options, requireFocusText: step.type === 'input' && !point }, run);
  assertControlCurrent(options, 'execute');
  const args = buildHarmonyInput(step, point, capabilities);
  if (!capabilities.actions.includes(args[3])) throw controlError('UNSUPPORTED', 'help');
  const result = await runInputPhase(deviceId, args, options, run, 'execute');
  return { ...result, output: result.stdout || result.error || '' };
}

module.exports = { MAX_LAYOUT_BYTES, parseHarmonyLayout, captureHarmonyLayout, layoutBounds, harmonyKey, buildHarmonyInput, probeHarmonyUi, performHarmonyInput, normalizeHarmonyCoordinate, normalizeHarmonyDuration, normalizeHarmonyPoints };
