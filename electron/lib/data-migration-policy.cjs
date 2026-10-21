const { normalizeSession } = require('./log-sessions.cjs');
const { normalizeOnboardingState } = require('./task-center-onboarding-state.cjs');
const { normalizeDeviceShortcuts } = require('./device-shortcuts-policy.cjs');
const { storageKey: SHORTCUTS_KEY } = require('./device-shortcuts-spec.json');
const { normalizePreferences: normalizeSerialPreferences } = require('./serial-policy.cjs');

const PORTABLE_PREF_KEYS = Object.freeze([
  'globalCommandSettings', 'autoUpdateEnabled', 'adb-workbench.favorite-packages.v1',
  'logFilterPresets.v1', 'adb-workbench.task-center.draft.v1', 'packageSearchVisible',
  'deviceNames', 'currentTheme', 'scrcpySettings', SHORTCUTS_KEY, 'adb-workbench.pinned-devices.v1',
  'adb-workbench.serial-preferences.v1'
]);
const FILES = new Set([
  'settings.json', 'customThemes.json', 'connection_history.json', 'terminal_command_history.json',
  'task-center-scripts.json', 'task-center-history.json', 'auto-diagnose-rules.json', 'performance-thresholds.json'
]);
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SESSION_FILE = new RegExp(`^log-analysis-sessions/(${UUID})\\.json$`);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const COMMAND_ACTIONS = new Set(['tab:devices', 'tab:serial', 'environmentCheck', 'tab:troubleshoot', 'tab:artifacts',
  'tab:quality', 'tab:history', 'tab:tasks', 'tab:performance', 'tab:settings', 'logAnalyzer', 'refreshDevices']);
const RULE_IDS = new Set(['builtin-crash', 'builtin-anr', 'builtin-native-crash', 'builtin-oom', 'builtin-watchdog', 'builtin-kernel-panic']);
const STEP_TYPES = new Set(['shell', 'installApk', 'pushFile', 'screenshot', 'imageCompare', 'perfSnapshot', 'tap',
  'longPress', 'swipe', 'input', 'keyevent', 'waitText', 'assertText', 'inspection', 'waitLog', 'delay', 'externalScript']);
const EVIDENCE_KEYS = new Set(['artifact', 'artifactDir', 'artifactBaseDir', 'artifactWorkDir', 'runResultPath',
  'stressReportPath', 'stressResultPath', 'reportPath', 'resultPath', 'outputPath', 'outputDir']);

function invalid(label) { throw new Error(`迁移数据格式无效：${label}`); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(label);
  return value;
}
function array(value, max, label) {
  if (!Array.isArray(value) || value.length > max) invalid(label);
  return value;
}
function text(value, max, label, allowEmpty = true) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) invalid(label);
  return value;
}
function boolean(value, label) { if (typeof value !== 'boolean') invalid(label); return value; }
function date(value, label) {
  text(value, 80, label, false);
  if (!Number.isFinite(Date.parse(value))) invalid(label);
  return value;
}
function assertSafeJson(value, depth = 0, budget = { left: 2000000 }) {
  if (--budget.left < 0 || depth > 48) invalid('内容层级或数量超出限制');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) assertSafeJson(item, depth + 1, budget);
    return;
  }
  object(value, '只支持普通 JSON 对象');
  for (const [key, item] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key)) invalid('包含不安全对象字段');
    assertSafeJson(item, depth + 1, budget);
  }
}
function uniqueIds(items, label) {
  if (new Set(items.map(item => item.id)).size !== items.length) invalid(`${label} ID 重复`);
  return items;
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function optionalTextFields(value, keys, max = 100000) {
  for (const key of keys) if (value[key] !== undefined) text(value[key], max, key);
}
function optionalNumberFields(value, keys) {
  for (const key of keys) {
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) invalid(key);
  }
}

function normalizeFilter(value) {
  object(value, '日志过滤');
  const next = {};
  for (const key of ['text', 'excludeText', 'regex', 'regexFlags', 'pkg', 'tag', 'minLevel']) {
    if (value[key] !== undefined) next[key] = text(value[key], 10000, `过滤 ${key}`);
  }
  if (value.pid !== undefined) {
    if (!Number.isInteger(value.pid) || value.pid < 0) invalid('日志 PID');
    next.pid = value.pid;
  }
  return next;
}
function normalizePresets(value) {
  return uniqueIds(array(value, 20, '日志过滤预设').map(item => {
    object(item, '日志过滤预设');
    const buffers = array(item.buffers, 6, '日志缓冲区');
    if (buffers.some(buffer => !['main', 'system', 'radio', 'events', 'crash', 'kernel'].includes(buffer))) invalid('日志缓冲区');
    return { id: text(item.id, 200, '预设 ID', false), name: text(item.name, 40, '预设名称', false),
      filter: normalizeFilter(item.filter), buffers: [...new Set(buffers)] };
  }), '预设');
}
function normalizeCommands(value) {
  object(value, '快捷命令');
  const shortcut = value.shortcut;
  if (shortcut !== null) {
    object(shortcut, '快捷键');
    for (const key of ['ctrl', 'alt', 'shift', 'meta']) boolean(shortcut[key], `快捷键 ${key}`);
    text(shortcut.key, 40, '快捷键字符', false);
  }
  const customCommands = uniqueIds(array(value.customCommands, 500, '自定义命令').map(command => {
    object(command, '自定义命令');
    if (!COMMAND_ACTIONS.has(command.action)) invalid('未知命令动作');
    return { id: text(command.id, 200, '命令 ID', false), title: text(command.title, 40, '命令名称', false),
      description: text(command.description || '', 80, '命令描述'), action: command.action, group: '自定义' };
  }), '命令');
  return { enabled: boolean(value.enabled, '命令开关'), shortcut: shortcut === null ? null
    : Object.fromEntries(['ctrl', 'alt', 'shift', 'meta', 'key'].map(key => [key, shortcut[key]])), customCommands };
}
function validateScript(script, allowEmpty = false) {
  object(script, '脚本');
  text(script.id, 200, '脚本 ID', false);
  text(script.name, 80, '脚本名称', allowEmpty);
  optionalTextFields(script, ['description', 'createdAt', 'updatedAt']);
  if (script.continueOnError !== undefined) boolean(script.continueOnError, '脚本继续开关');
  for (const key of ['loop', 'acceptance', 'report']) if (script[key] !== undefined) object(script[key], `脚本 ${key}`);
  if (script.mode !== undefined && !['replay', 'stress'].includes(script.mode)) invalid('脚本模式');
  const steps = array(script.steps, 10000, '脚本步骤');
  if (!allowEmpty && !steps.length) invalid('空脚本');
  uniqueIds(steps.map(step => {
    object(step, '脚本步骤');
    text(step.id, 200, '步骤 ID', false);
    if (!STEP_TYPES.has(step.type)) invalid('脚本步骤类型');
    for (const key of ['command', 'localPath', 'remotePath', 'baselinePath', 'scriptPath', 'workingDir', 'outputBaseDir', 'text', 'label']) {
      if (step[key] !== undefined) text(step[key], 100000, `步骤 ${key}`);
    }
    optionalTextFields(step, ['keyword', 'regex', 'textContains', 'resourceId', 'contentDesc', 'className', 'xpath', 'keyCode', 'adapter']);
    if (step.selector !== undefined) {
      object(step.selector, '步骤选择器');
      optionalTextFields(step.selector, ['text', 'textContains', 'resourceId', 'contentDesc', 'className', 'xpath']);
    }
    if (step.points !== undefined) {
      // The unsaved editor deliberately keeps partially typed gesture JSON as text.
      if (allowEmpty && typeof step.points === 'string') text(step.points, 100000, '手势草稿');
      else array(step.points, 10000, '手势点').forEach(point => {
        object(point, '手势点');
        for (const axis of ['x', 'y']) if (!Number.isFinite(point[axis])) invalid('手势坐标');
      });
    }
    if (step.args !== undefined && typeof step.args !== 'string') array(step.args, 1000, '脚本参数').forEach(item => text(item, 10000, '脚本参数'));
    return step;
  }), '脚本步骤');
  return clone(script);
}
function normalizeDraft(value) {
  object(value, '任务草稿');
  if (value.version !== 1) invalid('草稿版本');
  const draft = validateScript(value.draft, true);
  if (!['home', 'recording', 'editor'].includes(value.workspaceView) || !['simple', 'advanced'].includes(value.editorMode)) invalid('草稿界面');
  return { version: 1, draft, savedFingerprint: text(value.savedFingerprint, 10000000, '草稿指纹'),
    workspaceView: value.workspaceView, editorMode: value.editorMode, selectedDeviceIds: [] };
}
function normalizePreference(key, raw) {
  text(raw, 16 * 1024 * 1024, `偏好 ${key}`);
  if (key === 'currentTheme') {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(raw)) invalid('主题名称');
    return raw;
  }
  let value;
  try { value = JSON.parse(raw); } catch { invalid(`偏好 ${key} JSON`); }
  assertSafeJson(value);
  if (key === SHORTCUTS_KEY) value = normalizeDeviceShortcuts(value);
  if (key === 'adb-workbench.serial-preferences.v1') value = normalizeSerialPreferences(value);
  if (key === 'adb-workbench.pinned-devices.v1') {
    value = [...new Set(array(value, 1000, '常用设备').map(id => {
      text(id, 300, '常用设备 ID', false);
      if (/[\u0000-\u001f\u007f]/u.test(id)) invalid('常用设备 ID');
      return id;
    }))];
  }
  if (['autoUpdateEnabled', 'packageSearchVisible'].includes(key)) return JSON.stringify(boolean(value, key));
  if (key === 'globalCommandSettings') value = normalizeCommands(value);
  if (key === 'logFilterPresets.v1') value = normalizePresets(value);
  if (key === 'adb-workbench.task-center.draft.v1') value = normalizeDraft(value);
  if (key === 'adb-workbench.favorite-packages.v1') {
    value = [...new Set(array(value, 5000, '收藏应用').map(item => {
      if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/.test(text(item, 300, '包名'))) invalid('包名');
      return item;
    }))];
  }
  if (key === 'deviceNames') {
    object(value, '设备别名');
    if (Object.keys(value).length > 5000) invalid('设备别名数量');
    for (const [id, name] of Object.entries(value)) { text(id, 300, '设备 ID', false); text(name, 300, '设备别名', false); }
  }
  if (key === 'scrcpySettings') {
    object(value, '投屏设置');
    if (!['2 Mbps', '4 Mbps', '8 Mbps', '16 Mbps', '32 Mbps'].includes(value.bitrate) || !['0', '1920', '1280', '1024', '720'].includes(value.maxSize)) invalid('投屏参数');
    value = { screenOff: boolean(value.screenOff, '息屏'), stayAwake: boolean(value.stayAwake, '保持唤醒'), bitrate: value.bitrate, maxSize: value.maxSize };
  }
  return JSON.stringify(value);
}
function normalizePreferences(preferences) {
  object(preferences, '本地偏好');
  assertSafeJson(preferences);
  if (Buffer.byteLength(JSON.stringify(preferences), 'utf8') > 4 * 1024 * 1024) invalid('本地偏好总计超过 4 MB');
  const result = {};
  for (const [key, value] of Object.entries(preferences)) {
    if (!PORTABLE_PREF_KEYS.includes(key)) invalid(`不支持的偏好 ${key}`);
    result[key] = normalizePreference(key, value);
  }
  return result;
}

function sanitizeSettings(value) {
  object(value, '设置');
  const next = {};
  if (value.pushRemotePathHistory !== undefined) {
    next.pushRemotePathHistory = array(value.pushRemotePathHistory, 1000, '设备路径历史').map(item => text(item, 4000, '设备路径', false));
  }
  if (value.taskCenterOnboarding !== undefined) {
    next.taskCenterOnboarding = normalizeOnboardingState(value.taskCenterOnboarding);
    if (value.taskCenterOnboarding !== null && !next.taskCenterOnboarding) invalid('新手教程状态');
  }
  return next;
}
function sanitizeThemes(value) {
  const themes = array(value, 500, '主题').map(theme => {
    object(theme, '主题');
    const next = { key: text(theme.key, 200, '主题 ID', false), isCustom: true };
    for (const key of ['name', 'preview', 'primary', 'card', 'header', 'text', 'textMuted', 'input']) next[key] = text(theme[key], 2000, `主题 ${key}`);
    for (const [key, fields] of [['button', ['primary', 'secondary', 'outline']], ['terminal', ['bg', 'output', 'text', 'accent']]]) {
      object(theme[key], `主题 ${key}`);
      next[key] = Object.fromEntries(fields.map(field => [field, text(theme[key][field], 2000, `主题 ${field}`)]));
    }
    return next;
  });
  if (new Set(themes.map(theme => theme.key)).size !== themes.length) invalid('主题 ID 重复');
  return themes;
}
function sanitizeConnections(value) {
  return array(value, 20, '连接历史').map(entry => {
    object(entry, '连接历史');
    if (!['usb', 'wifi'].includes(entry.type)) invalid('连接类型');
    return { id: text(entry.id, 200, '连接 ID', false), deviceId: text(entry.deviceId, 300, '设备 ID', false),
      deviceName: text(entry.deviceName, 300, '设备名称', false), ip: entry.ip === null ? null : text(entry.ip, 300, '连接地址'),
      type: entry.type, timestamp: date(entry.timestamp, '连接时间') };
  });
}
function stripEvidence(value) {
  if (Array.isArray(value)) return value.map(stripEvidence);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !EVIDENCE_KEYS.has(key)).map(([key, child]) => [key, stripEvidence(child)]));
}
function sanitizeHistory(value) {
  object(value, '任务历史');
  if (value.version !== 1) invalid('任务历史版本');
  const history = uniqueIds(array(value.history, 100, '任务历史').map(record => {
    object(record, '任务记录');
    text(record.id, 200, '任务 ID', false);
    text(record.scriptName, 80, '任务名称', false);
    optionalTextFields(record, ['mode', 'error', 'createdAt', 'startedAt', 'endedAt', 'scriptId', 'scriptHash']);
    optionalNumberFields(record, ['comparisonVersion', 'completedSteps', 'failedSteps', 'totalSteps']);
    if (!['success', 'failed', 'cancelled', 'queued', 'running', 'passed'].includes(record.status)) invalid('任务状态');
    for (const key of ['deviceRuns', 'devices', 'scriptSteps', 'logs']) {
      if (record[key] !== undefined) array(record[key], 100000, `任务 ${key}`);
    }
    for (const run of record.deviceRuns || []) {
      object(run, '设备运行记录'); text(run.deviceId, 300, '运行设备', false);
      optionalTextFields(run, ['originalDeviceId', 'status', 'error', 'startedAt', 'endedAt']);
      for (const step of array(run.steps || [], 100000, '运行步骤')) {
        object(step, '运行步骤');
        optionalTextFields(step, ['id', 'stepId', 'label', 'type', 'status', 'output', 'error', 'startedAt', 'endedAt']);
        optionalNumberFields(step, ['index']);
      }
    }
    for (const step of record.scriptSteps || []) {
      object(step, '步骤身份'); text(step.id, 200, '步骤身份', false); text(step.type, 100, '步骤类型', false);
      optionalTextFields(step, ['label']);
    }
    for (const item of record.logs || []) {
      if (typeof item === 'string') continue;
      object(item, '运行日志'); optionalTextFields(item, ['at', 'message']);
    }
    if (record.stressSummary !== undefined && record.stressSummary !== null) {
      object(record.stressSummary, '压测总结'); optionalTextFields(record.stressSummary, ['reason']);
    }
    return stripEvidence(record);
  }), '任务');
  return { version: 1, history };
}
function sanitizeRules(value) {
  object(value, '诊断规则');
  if (value.version !== 1) invalid('诊断规则版本');
  object(value.builtinEnabled, '内置规则开关');
  const builtinEnabled = {};
  for (const [key, enabled] of Object.entries(value.builtinEnabled)) {
    if (!RULE_IDS.has(key)) invalid('内置规则 ID');
    builtinEnabled[key] = boolean(enabled, '规则开关');
  }
  const customRules = uniqueIds(array(value.customRules, 1000, '自定义规则').map(rule => {
    object(rule, '自定义规则');
    if (RULE_IDS.has(rule.id)) invalid('自定义规则 ID');
    const pattern = text(rule.pattern, 10000, '规则正则', false);
    const flags = text(rule.flags, 3, '规则 flags');
    if (!/^[imu]*$/.test(flags)) invalid('规则 flags');
    try { new RegExp(pattern, flags); } catch { invalid('规则正则'); }
    if (!['info', 'warning', 'error', 'fatal'].includes(rule.severity)) invalid('规则等级');
    return { id: text(rule.id, 200, '规则 ID', false), label: text(rule.label, 1000, '规则名称', false),
      type: text(rule.type, 100, '规则类型', false), pattern, flags, severity: rule.severity,
      keywords: array(rule.keywords, 12, '规则关键字').map(item => text(item, 1000, '关键字')),
      enabled: boolean(rule.enabled, '规则开关'), builtIn: false,
      description: text(rule.description || '', 10000, '规则描述'), updatedAt: date(rule.updatedAt, '规则时间') };
  }), '规则');
  return { version: 1, builtinEnabled, customRules };
}
function isAllowedFile(name) { return typeof name === 'string' && (FILES.has(name) || SESSION_FILE.test(name)); }
function sanitizeFile(name, data) {
  if (!isAllowedFile(name)) invalid('不允许迁移的文件');
  assertSafeJson(data);
  const session = name.match(SESSION_FILE);
  if (session) {
    object(data, '日志会话');
    if (data.schemaVersion !== 1 || data.id !== session[1]) invalid('日志会话 ID 或版本');
    return { ...normalizeSession(data), id: data.id, savedAt: date(data.savedAt, '会话保存时间') };
  }
  if (name === 'settings.json') return sanitizeSettings(data);
  if (name === 'customThemes.json') return sanitizeThemes(data);
  if (name === 'connection_history.json') return sanitizeConnections(data);
  if (name === 'terminal_command_history.json') return array(data, 100, '终端历史').map(item => text(item, 100000, '终端命令', false));
  if (name === 'task-center-history.json') return sanitizeHistory(data);
  if (name === 'auto-diagnose-rules.json') return sanitizeRules(data);
  if (name === 'task-center-scripts.json') {
    object(data, '脚本库');
    if (data.version !== 1) invalid('脚本库版本');
    return { version: 1, scripts: uniqueIds(array(data.scripts, 5000, '脚本库').map(script => validateScript(script)), '脚本') };
  }
  object(data, '性能阈值');
  const result = {};
  for (const key of ['cpu', 'memory', 'batteryTemp', 'dataUsed']) {
    if (typeof data[key] !== 'number' || !Number.isFinite(data[key]) || data[key] < 1 || data[key] > 100) invalid(`性能阈值 ${key}`);
    result[key] = data[key];
  }
  return result;
}

module.exports = { PORTABLE_PREF_KEYS, normalizePreferences, isAllowedFile, sanitizeFile };
