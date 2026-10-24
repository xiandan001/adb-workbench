const { tr } = require('./localization.cjs');
const { normalizeSession } = require('./log-sessions.cjs');
const { normalizeOnboardingState } = require('./task-center-onboarding-state.cjs');
const { normalizeDeviceShortcuts } = require('./device-shortcuts-policy.cjs');
const { storageKey: SHORTCUTS_KEY } = require('./device-shortcuts-spec.json');
const { normalizePreferences: normalizeSerialPreferences } = require('./serial-policy.cjs');

const PORTABLE_PREF_KEYS = Object.freeze([
  'globalCommandSettings', 'autoUpdateEnabled', 'adb-workbench.favorite-packages.v1',
  'logFilterPresets.v1', 'adb-workbench.task-center.draft.v1', 'packageSearchVisible',
  'deviceNames', 'currentTheme', 'scrcpySettings', SHORTCUTS_KEY, 'adb-workbench.pinned-devices.v1',
  'adb-workbench.serial-preferences.v1', 'adb-workbench.serial-terminal-style.v1', 'adb-workbench.ui-motion.v1'
]);
const FILES = new Set([
  'settings.json', 'customThemes.json', 'connection_history.json', 'terminal_command_history.json',
  'task-center-scripts.json', 'task-center-history.json', 'auto-diagnose-rules.json', 'performance-thresholds.json'
]);
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SESSION_FILE = new RegExp(`^log-analysis-sessions/(${UUID})\\.json$`);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const COMMAND_ACTIONS = new Set(['tab:devices', 'tab:serial', 'tab:ssh', 'tab:ai-tools', 'environmentCheck', 'tab:troubleshoot', 'tab:artifacts',
  'tab:quality', 'tab:history', 'tab:tasks', 'tab:performance', 'tab:settings', 'logAnalyzer', 'refreshDevices']);
const RULE_IDS = new Set(['builtin-crash', 'builtin-anr', 'builtin-native-crash', 'builtin-oom', 'builtin-watchdog', 'builtin-kernel-panic']);
const STEP_TYPES = new Set(['shell', 'installApk', 'pushFile', 'screenshot', 'imageCompare', 'perfSnapshot', 'tap',
  'longPress', 'swipe', 'input', 'keyevent', 'waitText', 'assertText', 'inspection', 'waitLog', 'delay', 'externalScript']);
const EVIDENCE_KEYS = new Set(['artifact', 'artifactDir', 'artifactBaseDir', 'artifactWorkDir', 'runResultPath',
  'stressReportPath', 'stressResultPath', 'reportPath', 'resultPath', 'outputPath', 'outputDir']);

function invalid(label) { throw new Error(tr("迁移数据格式无效：{0}", { 0: label })); }
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
  if (--budget.left < 0 || depth > 48) invalid(tr("内容层级或数量超出限制"));
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) assertSafeJson(item, depth + 1, budget);
    return;
  }
  object(value, tr("只支持普通 JSON 对象"));
  for (const [key, item] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key)) invalid(tr("包含不安全对象字段"));
    assertSafeJson(item, depth + 1, budget);
  }
}
function uniqueIds(items, label) {
  if (new Set(items.map(item => item.id)).size !== items.length) invalid(tr("{0} ID 重复", { 0: label }));
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
  object(value, tr("日志过滤"));
  const next = {};
  for (const key of ['text', 'excludeText', 'regex', 'regexFlags', 'pkg', 'tag', 'minLevel']) {
    if (value[key] !== undefined) next[key] = text(value[key], 10000, tr("过滤 {0}", { 0: key }));
  }
  if (value.pid !== undefined) {
    if (!Number.isInteger(value.pid) || value.pid < 0) invalid(tr("日志 PID"));
    next.pid = value.pid;
  }
  return next;
}
function normalizePresets(value) {
  return uniqueIds(array(value, 20, tr("日志过滤预设")).map(item => {
    object(item, tr("日志过滤预设"));
    const buffers = array(item.buffers, 6, tr("日志缓冲区"));
    if (buffers.some(buffer => !['main', 'system', 'radio', 'events', 'crash', 'kernel'].includes(buffer))) invalid(tr("日志缓冲区"));
    return { id: text(item.id, 200, tr("预设 ID"), false), name: text(item.name, 40, tr("预设名称"), false),
      filter: normalizeFilter(item.filter), buffers: [...new Set(buffers)] };
  }), tr("预设"));
}
function normalizeCommands(value) {
  object(value, tr("快捷命令"));
  const shortcut = value.shortcut;
  if (shortcut !== null) {
    object(shortcut, tr("快捷键"));
    for (const key of ['ctrl', 'alt', 'shift', 'meta']) boolean(shortcut[key], tr("快捷键 {0}", { 0: key }));
    text(shortcut.key, 40, tr("快捷键字符"), false);
  }
  const customCommands = uniqueIds(array(value.customCommands, 500, tr("自定义命令")).map(command => {
    object(command, tr("自定义命令"));
    if (!COMMAND_ACTIONS.has(command.action)) invalid(tr("未知命令动作"));
    return { id: text(command.id, 200, tr("命令 ID"), false), title: text(command.title, 40, tr("命令名称"), false),
      description: text(command.description || '', 80, tr("命令描述")), action: command.action, group: '自定义' };
  }), tr("命令"));
  return { enabled: boolean(value.enabled, tr("命令开关")), shortcut: shortcut === null ? null
    : Object.fromEntries(['ctrl', 'alt', 'shift', 'meta', 'key'].map(key => [key, shortcut[key]])), customCommands };
}
function validateScript(script, allowEmpty = false) {
  object(script, tr("脚本"));
  text(script.id, 200, tr("脚本 ID"), false);
  text(script.name, 80, tr("脚本名称"), allowEmpty);
  optionalTextFields(script, ['description', 'createdAt', 'updatedAt']);
  if (script.continueOnError !== undefined) boolean(script.continueOnError, tr("脚本继续开关"));
  for (const key of ['loop', 'acceptance', 'report']) if (script[key] !== undefined) object(script[key], tr("脚本 {0}", { 0: key }));
  if (script.mode !== undefined && !['replay', 'stress'].includes(script.mode)) invalid(tr("脚本模式"));
  const steps = array(script.steps, 10000, tr("脚本步骤"));
  if (!allowEmpty && !steps.length) invalid(tr("空脚本"));
  uniqueIds(steps.map(step => {
    object(step, tr("脚本步骤"));
    text(step.id, 200, tr("步骤 ID"), false);
    if (!STEP_TYPES.has(step.type)) invalid(tr("脚本步骤类型"));
    for (const key of ['command', 'localPath', 'remotePath', 'baselinePath', 'scriptPath', 'workingDir', 'outputBaseDir', 'text', 'label']) {
      if (step[key] !== undefined) text(step[key], 100000, tr("步骤 {0}", { 0: key }));
    }
    optionalTextFields(step, ['keyword', 'regex', 'textContains', 'resourceId', 'contentDesc', 'className', 'xpath', 'keyCode', 'adapter']);
    if (step.selector !== undefined) {
      object(step.selector, tr("步骤选择器"));
      optionalTextFields(step.selector, ['text', 'textContains', 'resourceId', 'contentDesc', 'className', 'xpath']);
    }
    if (step.points !== undefined) {
      // The unsaved editor deliberately keeps partially typed gesture JSON as text.
      if (allowEmpty && typeof step.points === 'string') text(step.points, 100000, tr("手势草稿"));
      else array(step.points, 10000, tr("手势点")).forEach(point => {
        object(point, tr("手势点"));
        for (const axis of ['x', 'y']) if (!Number.isFinite(point[axis])) invalid(tr("手势坐标"));
      });
    }
    if (step.args !== undefined && typeof step.args !== 'string') array(step.args, 1000, tr("脚本参数")).forEach(item => text(item, 10000, tr("脚本参数")));
    return step;
  }), tr("脚本步骤"));
  return clone(script);
}
function normalizeDraft(value) {
  object(value, tr("任务草稿"));
  if (value.version !== 1) invalid(tr("草稿版本"));
  const draft = validateScript(value.draft, true);
  if (!['home', 'recording', 'editor'].includes(value.workspaceView) || !['simple', 'advanced'].includes(value.editorMode)) invalid(tr("草稿界面"));
  return { version: 1, draft, savedFingerprint: text(value.savedFingerprint, 10000000, tr("草稿指纹")),
    workspaceView: value.workspaceView, editorMode: value.editorMode, selectedDeviceIds: [] };
}
function normalizePreference(key, raw) {
  text(raw, 16 * 1024 * 1024, tr("偏好 {0}", { 0: key }));
  if (key === 'adb-workbench.serial-terminal-style.v1' && raw.length > 64) invalid(tr("串口终端样式数据过长"));
  if (key === 'adb-workbench.ui-motion.v1' && raw.length > 256) invalid(tr("启动与动效偏好数据过长"));
  if (key === 'currentTheme') {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(raw)) invalid(tr("主题名称"));
    return raw;
  }
  let value;
  try { value = JSON.parse(raw); } catch { invalid(tr("偏好 {0} JSON", { 0: key })); }
  assertSafeJson(value);
  if (key === SHORTCUTS_KEY) value = normalizeDeviceShortcuts(value);
  if (key === 'adb-workbench.serial-preferences.v1') value = normalizeSerialPreferences(value);
  if (key === 'adb-workbench.serial-terminal-style.v1' && !['current', 'classic'].includes(value)) invalid(tr("串口终端样式"));
  if (key === 'adb-workbench.ui-motion.v1' && (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'reducedMotion,startupAnimation,version' || value.version !== 1
    || typeof value.reducedMotion !== 'boolean' || typeof value.startupAnimation !== 'boolean')) invalid(tr("启动与动效偏好"));
  if (key === 'adb-workbench.pinned-devices.v1') {
    value = [...new Set(array(value, 1000, tr("常用设备")).map(id => {
      text(id, 300, tr("常用设备 ID"), false);
      if (/[\u0000-\u001f\u007f]/u.test(id)) invalid(tr("常用设备 ID"));
      return id;
    }))];
  }
  if (['autoUpdateEnabled', 'packageSearchVisible'].includes(key)) return JSON.stringify(boolean(value, key));
  if (key === 'globalCommandSettings') value = normalizeCommands(value);
  if (key === 'logFilterPresets.v1') value = normalizePresets(value);
  if (key === 'adb-workbench.task-center.draft.v1') value = normalizeDraft(value);
  if (key === 'adb-workbench.favorite-packages.v1') {
    value = [...new Set(array(value, 5000, tr("收藏应用")).map(item => {
      if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/.test(text(item, 300, tr('包名')))) invalid(tr("包名"));
      return item;
    }))];
  }
  if (key === 'deviceNames') {
    object(value, tr("设备别名"));
    if (Object.keys(value).length > 5000) invalid(tr("设备别名数量"));
    for (const [id, name] of Object.entries(value)) { text(id, 300, tr("设备 ID"), false); text(name, 300, tr("设备别名"), false); }
  }
  if (key === 'scrcpySettings') {
    object(value, tr("投屏设置"));
    if (!['2 Mbps', '4 Mbps', '8 Mbps', '16 Mbps', '32 Mbps'].includes(value.bitrate) || !['0', '1920', '1280', '1024', '720'].includes(value.maxSize)) invalid(tr("投屏参数"));
    value = { screenOff: boolean(value.screenOff, tr("息屏")), stayAwake: boolean(value.stayAwake, tr("保持唤醒")), bitrate: value.bitrate, maxSize: value.maxSize };
  }
  return JSON.stringify(value);
}
function normalizePreferences(preferences) {
  object(preferences, tr("本地偏好"));
  assertSafeJson(preferences);
  if (Buffer.byteLength(JSON.stringify(preferences), 'utf8') > 4 * 1024 * 1024) invalid(tr("本地偏好总计超过 4 MB"));
  const result = {};
  for (const [key, value] of Object.entries(preferences)) {
    if (!PORTABLE_PREF_KEYS.includes(key)) invalid(tr("不支持的偏好 {0}", { 0: key }));
    result[key] = normalizePreference(key, value);
  }
  return result;
}

function sanitizeSettings(value) {
  object(value, tr("设置"));
  const next = {};
  if (value.locale !== undefined) {
    if (!['zh-CN', 'en-US'].includes(value.locale)) invalid(tr("界面语言"));
    next.locale = value.locale;
  }
  if (value.pushRemotePathHistory !== undefined) {
    next.pushRemotePathHistory = array(value.pushRemotePathHistory, 1000, tr("设备路径历史")).map(item => text(item, 4000, tr("设备路径"), false));
  }
  if (value.taskCenterOnboarding !== undefined) {
    next.taskCenterOnboarding = normalizeOnboardingState(value.taskCenterOnboarding);
    if (value.taskCenterOnboarding !== null && !next.taskCenterOnboarding) invalid(tr("新手教程状态"));
  }
  return next;
}
function sanitizeThemes(value) {
  const themes = array(value, 500, tr("主题")).map(theme => {
    object(theme, tr("主题"));
    const next = { key: text(theme.key, 200, tr("主题 ID"), false), isCustom: true };
    for (const key of ['name', 'preview', 'primary', 'card', 'header', 'text', 'textMuted', 'input']) next[key] = text(theme[key], 2000, tr("主题 {0}", { 0: key }));
    for (const [key, fields] of [['button', ['primary', 'secondary', 'outline']], ['terminal', ['bg', 'output', 'text', 'accent']]]) {
      object(theme[key], tr("主题 {0}", { 0: key }));
      next[key] = Object.fromEntries(fields.map(field => [field, text(theme[key][field], 2000, tr("主题 {0}", { 0: field }))]));
    }
    return next;
  });
  if (new Set(themes.map(theme => theme.key)).size !== themes.length) invalid(tr("主题 ID 重复"));
  return themes;
}
function sanitizeConnections(value) {
  return array(value, 20, tr("连接历史")).map(entry => {
    object(entry, tr("连接历史"));
    if (!['usb', 'wifi'].includes(entry.type)) invalid(tr("连接类型"));
    return { id: text(entry.id, 200, tr("连接 ID"), false), deviceId: text(entry.deviceId, 300, tr("设备 ID"), false),
      deviceName: text(entry.deviceName, 300, tr("设备名称"), false), ip: entry.ip === null ? null : text(entry.ip, 300, tr("连接地址")),
      type: entry.type, timestamp: date(entry.timestamp, tr("连接时间")) };
  });
}
function stripEvidence(value) {
  if (Array.isArray(value)) return value.map(stripEvidence);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !EVIDENCE_KEYS.has(key)).map(([key, child]) => [key, stripEvidence(child)]));
}
function sanitizeHistory(value) {
  object(value, tr("任务历史"));
  if (value.version !== 1) invalid(tr("任务历史版本"));
  const history = uniqueIds(array(value.history, 100, tr("任务历史")).map(record => {
    object(record, tr("任务记录"));
    text(record.id, 200, tr("任务 ID"), false);
    text(record.scriptName, 80, tr("任务名称"), false);
    optionalTextFields(record, ['mode', 'error', 'createdAt', 'startedAt', 'endedAt', 'scriptId', 'scriptHash']);
    optionalNumberFields(record, ['comparisonVersion', 'completedSteps', 'failedSteps', 'totalSteps']);
    if (!['success', 'failed', 'cancelled', 'queued', 'running', 'passed'].includes(record.status)) invalid(tr("任务状态"));
    for (const key of ['deviceRuns', 'devices', 'scriptSteps', 'logs']) {
      if (record[key] !== undefined) array(record[key], 100000, tr("任务 {0}", { 0: key }));
    }
    for (const run of record.deviceRuns || []) {
      object(run, tr("设备运行记录")); text(run.deviceId, 300, tr("运行设备"), false);
      optionalTextFields(run, ['originalDeviceId', 'status', 'error', 'startedAt', 'endedAt']);
      for (const step of array(run.steps || [], 100000, tr("运行步骤"))) {
        object(step, tr("运行步骤"));
        optionalTextFields(step, ['id', 'stepId', 'label', 'type', 'status', 'output', 'error', 'startedAt', 'endedAt']);
        optionalNumberFields(step, ['index']);
      }
    }
    for (const step of record.scriptSteps || []) {
      object(step, tr("步骤身份")); text(step.id, 200, tr("步骤身份"), false); text(step.type, 100, tr("步骤类型"), false);
      optionalTextFields(step, ['label']);
    }
    for (const item of record.logs || []) {
      if (typeof item === 'string') continue;
      object(item, tr("运行日志")); optionalTextFields(item, ['at', 'message']);
    }
    if (record.stressSummary !== undefined && record.stressSummary !== null) {
      object(record.stressSummary, tr("压测总结")); optionalTextFields(record.stressSummary, ['reason']);
    }
    return stripEvidence(record);
  }), tr("任务"));
  return { version: 1, history };
}
function sanitizeRules(value) {
  object(value, tr("诊断规则"));
  if (value.version !== 1) invalid(tr("诊断规则版本"));
  object(value.builtinEnabled, tr("内置规则开关"));
  const builtinEnabled = {};
  for (const [key, enabled] of Object.entries(value.builtinEnabled)) {
    if (!RULE_IDS.has(key)) invalid(tr("内置规则 ID"));
    builtinEnabled[key] = boolean(enabled, tr("规则开关"));
  }
  const customRules = uniqueIds(array(value.customRules, 1000, tr("自定义规则")).map(rule => {
    object(rule, tr("自定义规则"));
    if (RULE_IDS.has(rule.id)) invalid(tr("自定义规则 ID"));
    const pattern = text(rule.pattern, 10000, tr("规则正则"), false);
    const flags = text(rule.flags, 3, tr("规则 flags"));
    if (!/^[imu]*$/.test(flags)) invalid(tr("规则 flags"));
    try { new RegExp(pattern, flags); } catch { invalid(tr("规则正则")); }
    if (!['info', 'warning', 'error', 'fatal'].includes(rule.severity)) invalid(tr("规则等级"));
    return { id: text(rule.id, 200, tr("规则 ID"), false), label: text(rule.label, 1000, tr("规则名称"), false),
      type: text(rule.type, 100, tr("规则类型"), false), pattern, flags, severity: rule.severity,
      keywords: array(rule.keywords, 12, tr("规则关键字")).map(item => text(item, 1000, tr("关键字"))),
      enabled: boolean(rule.enabled, tr("规则开关")), builtIn: false,
      description: text(rule.description || '', 10000, tr("规则描述")), updatedAt: date(rule.updatedAt, tr("规则时间")) };
  }), tr("规则"));
  return { version: 1, builtinEnabled, customRules };
}
function isAllowedFile(name) { return typeof name === 'string' && (FILES.has(name) || SESSION_FILE.test(name)); }
function sanitizeFile(name, data) {
  if (!isAllowedFile(name)) invalid(tr("不允许迁移的文件"));
  assertSafeJson(data);
  const session = name.match(SESSION_FILE);
  if (session) {
    object(data, tr("日志会话"));
    if (data.schemaVersion !== 1 || data.id !== session[1]) invalid(tr("日志会话 ID 或版本"));
    return { ...normalizeSession(data), id: data.id, savedAt: date(data.savedAt, tr("会话保存时间")) };
  }
  if (name === 'settings.json') return sanitizeSettings(data);
  if (name === 'customThemes.json') return sanitizeThemes(data);
  if (name === 'connection_history.json') return sanitizeConnections(data);
  if (name === 'terminal_command_history.json') return array(data, 100, tr("终端历史")).map(item => text(item, 100000, tr("终端命令"), false));
  if (name === 'task-center-history.json') return sanitizeHistory(data);
  if (name === 'auto-diagnose-rules.json') return sanitizeRules(data);
  if (name === 'task-center-scripts.json') {
    object(data, tr("脚本库"));
    if (data.version !== 1) invalid(tr("脚本库版本"));
    return { version: 1, scripts: uniqueIds(array(data.scripts, 5000, tr("脚本库")).map(script => validateScript(script)), tr("脚本")) };
  }
  object(data, tr("性能阈值"));
  const result = {};
  for (const key of ['cpu', 'memory', 'batteryTemp', 'dataUsed']) {
    if (typeof data[key] !== 'number' || !Number.isFinite(data[key]) || data[key] < 1 || data[key] > 100) invalid(tr("性能阈值 {0}", { 0: key }));
    result[key] = data[key];
  }
  return result;
}

module.exports = { PORTABLE_PREF_KEYS, normalizePreferences, isAllowedFile, sanitizeFile };
