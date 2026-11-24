const { tr, getLocale } = require('./localization.cjs');
// AI 自动诊断引擎：实时检测 logcat 中的崩溃/ANR/OOM 等关键问题
// 触发后向渲染进程推送 onAutoDiagnose 事件，由用户确认是否调用 AI 分析
//
// 依赖方向（无循环）：
//   auto-diagnose → ai-analyze（共享 controller / pushAiMessages / buildAiSystemPrompt）
//   auto-diagnose → app-context（广播）
//   auto-diagnose → log-analyzer（延迟 require，运行时读取 logStore）

const https = require('./ai-outbound-transport.cjs');
const { StringDecoder } = require('string_decoder');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { createDiagnosticMatcher, MATCH_LIMITS } = require('./log-diagnostic-matcher.cjs');

const ctx = require('./app-context.cjs');
const aiAnalyze = require('./ai-analyze.cjs');
const vip = require('./vip.cjs');
const { canUseMembershipFeature } = require('./membership-entitlements.cjs');
const {
  AGNES_API_URL,
  AGNES_API_KEYS,
  AGNES_MODEL,
  getAgnesKeyIndex,
  getNextApiKey,
} = aiAnalyze.aiKeys;

// 日志诊断规则库：内置规则基础版可用，自定义规则与导入导出由会员版解锁。
const AUTO_DIAGNOSE_RULES_FILE = 'auto-diagnose-rules.json';
const AUTO_DIAGNOSE_BUILTIN_RULES = [
  {
    id: 'builtin-harmony-js-crash', type: 'harmony_js_crash', get label() { return tr('鸿蒙 JS 崩溃'); }, severity: 'fatal',
    pattern: '\\bJS_CRASH\\b', flags: 'i', keywords: ['JS_CRASH'], enabled: true, builtIn: true
  },
  {
    id: 'builtin-harmony-app-freeze', type: 'harmony_app_freeze', get label() { return tr('鸿蒙应用无响应'); }, severity: 'fatal',
    pattern: '\\bAPP_FREEZE\\b', flags: 'i', keywords: ['APP_FREEZE'], enabled: true, builtIn: true
  },
  {
    id: 'builtin-harmony-cpp-crash', type: 'harmony_cpp_crash', get label() { return tr('鸿蒙 C++ 崩溃'); }, severity: 'fatal',
    pattern: '\\bCPP_CRASH\\b', flags: 'i', keywords: ['CPP_CRASH'], enabled: true, builtIn: true
  },
  {
    id: 'builtin-crash',
    type: 'crash',
    label: 'Java Crash',
    severity: 'fatal',
    pattern: 'FATAL\\s+EXCEPTION|AndroidRuntime.*FATAL|CRASH:|java\\.lang\\.\\w+Exception|NullPointerException|IllegalStateException|ClassCastException|ArrayIndexOutOfBoundsException',
    flags: 'i',
    keywords: ['FATAL', 'AndroidRuntime', 'CRASH:', 'Exception', 'NullPointerException'],
    enabled: true,
    builtIn: true
  },
  {
    id: 'builtin-anr',
    type: 'anr',
    label: 'ANR',
    severity: 'fatal',
    pattern: 'ANR\\s+in\\s+|Application\\s+Not\\s+Responding|ANRManager|not\\s+responding',
    flags: 'i',
    keywords: ['ANR', 'Application', 'responding'],
    enabled: true,
    builtIn: true
  },
  {
    id: 'builtin-native-crash',
    type: 'native_crash',
    label: 'Native Crash',
    severity: 'fatal',
    pattern: 'SIGSEGV|signal\\s+11|SIGABRT|signal\\s+6|tombstone|libc.*Fatal|backtrace:',
    flags: 'i',
    keywords: ['SIGSEGV', 'SIGABRT', 'signal', 'tombstone', 'backtrace:'],
    enabled: true,
    builtIn: true
  },
  {
    id: 'builtin-oom',
    type: 'oom',
    label: 'OOM',
    severity: 'fatal',
    pattern: 'OutOfMemoryError|Failed\\s+to\\s+allocate|OutOfMem',
    flags: 'i',
    keywords: ['OutOfMemory', 'allocate', 'OutOfMem'],
    enabled: true,
    builtIn: true
  },
  {
    id: 'builtin-watchdog',
    type: 'watchdog',
    label: 'Watchdog',
    severity: 'error',
    pattern: 'Watchdog|watchdog.*killed|Blocked\\s+in\\s+handler',
    flags: 'i',
    keywords: ['Watchdog', 'watchdog', 'Blocked', 'handler'],
    enabled: true,
    builtIn: true
  },
  {
    id: 'builtin-kernel-panic',
    type: 'kernel_panic',
    label: 'Kernel Panic',
    severity: 'fatal',
    pattern: 'Kernel\\s+Panic|BUG:|oops:|Unable\\s+to\\s+handle',
    flags: 'i',
    keywords: ['Panic', 'BUG:', 'oops', 'Unable'],
    enabled: true,
    builtIn: true
  }
];
const AUTO_DIAGNOSE_BUILTIN_IDS = new Set(AUTO_DIAGNOSE_BUILTIN_RULES.map(rule => rule.id));
let diagnoseRuleStateCache = null;
let compiledRuleCache = null;
let compiledRuleLocale = '';
let ruleRevision = 0, diagnosticEpoch = 0, configuredRevision = -1, diagnosticLocale = '';
let diagnosticMatcher = null, diagnosticRules = [], diagnosticIncomplete = null, ruleTestMatcher = null;
let liveTimer = null, liveBytes = 0;
const pendingLive = new Map(), diagnosticWarnings = new Set();
function reportDiagnosticIncomplete(value) {
  const key = JSON.stringify([value.reason, value.ruleId, value.source]);
  if (diagnosticWarnings.has(key)) return;
  diagnosticWarnings.add(key);
  const error = ['timeout', 'blocked-rule'].includes(value.reason)
    ? tr('部分诊断规则执行超时后已暂停；采集继续，不能据此判断没有异常。')
    : ['line-limit', 'queue-limit', 'rule-limit'].includes(value.reason)
      ? tr('规则诊断超出安全工作量，部分日志未诊断；采集继续。')
      : tr('规则诊断未完成，原始日志仍保留；请检查规则后重试。');
  diagnosticIncomplete = { ...value, partial: true, error };
  ctx.broadcastToAllWindows('auto-diagnose:incomplete', diagnosticIncomplete);
}
function productionMatcher() {
  if (!diagnosticMatcher) diagnosticMatcher = createDiagnosticMatcher({ onIncomplete: reportDiagnosticIncomplete });
  if (configuredRevision !== ruleRevision || diagnosticLocale !== getLocale()) {
    diagnosticRules = getEffectiveRules().filter(rule => rule.enabled !== false);
    diagnosticMatcher.configure(diagnosticRules); configuredRevision = ruleRevision; diagnosticLocale = getLocale();
  }
  return diagnosticMatcher;
}
function flushLiveDiagnostics() {
  clearTimeout(liveTimer); liveTimer = null;
  const rows = [...pendingLive.values()], epoch = diagnosticEpoch; pendingLive.clear(); liveBytes = 0;
  if (!rows.length || !autoDiagnoseEnabled) return;
  let matcher;
  try { matcher = productionMatcher(); }
  catch { reportDiagnosticIncomplete({ reason: 'rule-limit', source: 'realtime' }); return; }
  void matcher.match(rows.map(row => row.line), { source: rows[0].source }).then(result => {
    if (epoch !== diagnosticEpoch || !autoDiagnoseEnabled) return;
    for (const issue of result.matches) {
      const row = rows[issue.index];
      emitDiagnosedIssue(issue, row.line, row.index, row.source, row.contextEntries, row.entry);
    }
  }).catch(error => { if (epoch === diagnosticEpoch && error.code !== 'DIAGNOSTIC_CANCELLED') reportDiagnosticIncomplete({ reason: error.reason || 'worker-error', ruleId: error.ruleId, source: rows[0].source }); });
}

// 自动诊断状态
// - autoDiagnoseEnabled: 总开关（用户可在 UI 关闭）
// - autoDiagnoseLastFireByType: 每种问题类型上次触发时间戳（独立去抖）
// - autoDiagnoseContextLines: 每个问题提取的上下文行数（前后各 N 行）
let autoDiagnoseEnabled = true;
const autoDiagnoseLastFireByType = {}; // { crash: timestamp, anr: timestamp, ... }
const AUTO_DIAGNOSE_DEBOUNCE_MS = 3000; // 同类型问题 3 秒内不重复推送（仅防止同一崩溃堆栈行反复触发）
const AUTO_DIAGNOSE_CONTEXT_LINES = 50;  // 每个问题前后各取 50 行上下文

// 运行时访问 log-analyzer 的 logStore（避免循环依赖：log-analyzer 也 require 本模块）
function getLogStore() {
  return require('./log-analyzer.cjs').getLogStore();
}

// 规则库持久化与编译缓存
function getRulesFilePath() {
  return path.join(app.getPath('userData'), AUTO_DIAGNOSE_RULES_FILE);
}

function createDefaultRuleState() {
  return {
    version: 1,
    builtinEnabled: Object.fromEntries(AUTO_DIAGNOSE_BUILTIN_RULES.map(rule => [rule.id, true])),
    customRules: []
  };
}

function readRuleState() {
  if (diagnoseRuleStateCache) return diagnoseRuleStateCache;
  const defaults = createDefaultRuleState();
  try {
    const parsed = JSON.parse(fs.readFileSync(getRulesFilePath(), 'utf8'));
    diagnoseRuleStateCache = {
      version: 1,
      builtinEnabled: { ...defaults.builtinEnabled, ...(parsed.builtinEnabled || {}) },
      customRules: Array.isArray(parsed.customRules)
        ? parsed.customRules.map(normalizeCustomRule).filter(Boolean)
        : []
    };
  } catch {
    diagnoseRuleStateCache = defaults;
  }
  return diagnoseRuleStateCache;
}

function writeRuleState(state) {
  diagnoseRuleStateCache = {
    version: 1,
    builtinEnabled: { ...createDefaultRuleState().builtinEnabled, ...(state.builtinEnabled || {}) },
    customRules: Array.isArray(state.customRules) ? state.customRules.map(normalizeCustomRule).filter(Boolean) : []
  };
  compiledRuleCache = null;
  ruleRevision++;
  fs.mkdirSync(path.dirname(getRulesFilePath()), { recursive: true });
  fs.writeFileSync(getRulesFilePath(), JSON.stringify(diagnoseRuleStateCache, null, 2), 'utf8');
}

function getEffectiveRules() {
  const state = readRuleState();
  const builtin = AUTO_DIAGNOSE_BUILTIN_RULES.map(rule => ({
    ...rule,
    enabled: state.builtinEnabled[rule.id] !== false
  }));
  return [...builtin, ...state.customRules];
}

function getCompiledRules() {
  // Synchronous compatibility is test-only; production matching is owned by the terminable worker.
  if (compiledRuleCache && compiledRuleLocale === getLocale()) return compiledRuleCache;
  compiledRuleLocale = getLocale();
  compiledRuleCache = getEffectiveRules()
    .filter(rule => rule.enabled !== false)
    .map(rule => {
      try {
        return { ...rule, regex: new RegExp(rule.pattern, normalizeRegexFlags(rule.flags)) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return compiledRuleCache;
}

function normalizeCustomRule(rule) {
  if (!rule || typeof rule !== 'object') return null;
  const id = String(rule.id || `custom-${Date.now()}-${Math.random().toString(16).slice(2)}`).trim();
  const label = String(rule.label || '').trim();
  const pattern = String(rule.pattern || '').trim();
  if (!id || !label || !pattern || AUTO_DIAGNOSE_BUILTIN_IDS.has(id)) return null;
  try {
    new RegExp(pattern, normalizeRegexFlags(rule.flags));
  } catch {
    return null;
  }
  return {
    id,
    type: String(rule.type || 'custom').trim() || 'custom',
    label,
    severity: ['info', 'warning', 'error', 'fatal'].includes(rule.severity) ? rule.severity : 'error',
    pattern,
    flags: normalizeRegexFlags(rule.flags),
    keywords: normalizeKeywords(rule.keywords),
    enabled: rule.enabled !== false,
    builtIn: false,
    description: String(rule.description || '').trim(),
    updatedAt: rule.updatedAt || new Date().toISOString()
  };
}

function normalizeRuleInput(raw) {
  const rule = normalizeCustomRule(raw);
  if (!rule) {
    const error = validateRuleShape(raw);
    return { ok: false, error };
  }
  return { ok: true, rule: { ...rule, updatedAt: new Date().toISOString() } };
}

function validateRuleShape(raw) {
  if (!raw || typeof raw !== 'object') return 'rule_invalid';
  if (!String(raw.label || '').trim()) return 'label_required';
  if (!String(raw.pattern || '').trim()) return 'pattern_required';
  try {
    new RegExp(String(raw.pattern || ''), normalizeRegexFlags(raw.flags));
  } catch (error) {
    return `regex_invalid: ${error.message}`;
  }
  return 'rule_invalid';
}

function normalizeKeywords(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item || '').trim()).filter(Boolean).slice(0, 12);
  }
  return String(value || '')
    .split(/[,，\n]/)
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function normalizeRegexFlags(flags) {
  const raw = String(flags || 'i');
  const allowed = new Set(['i', 'm', 'u']);
  return Array.from(new Set(raw.split('').filter(flag => allowed.has(flag)))).join('') || 'i';
}

async function ensureVipForRules() {
  const status = await vip.getStatusAsync();
  return canUseMembershipFeature(status, 'log-rules');
}

function publicRules() {
  return getEffectiveRules().map(rule => ({
    id: rule.id,
    type: rule.type,
    label: rule.label,
    severity: rule.severity,
    pattern: rule.pattern,
    flags: rule.flags,
    keywords: rule.keywords || [],
    enabled: rule.enabled !== false,
    builtIn: rule.builtIn === true,
    description: rule.description || '',
    updatedAt: rule.updatedAt || null
  }));
}

/**
 * 检测单行日志是否命中关键问题
 * @param {string} line 原始日志行
 * @returns {{type:string,label:string,severity:string}|null}
 */
function detectIssue(line) {
  // 使用可配置规则库，规则级关键词预筛减少每行正则次数；无关键词的自定义规则直接执行正则。
  const rules = getCompiledRules();
  for (const rule of rules) {
    if (rule.keywords?.length) {
      let keywordHit = false;
      for (const keyword of rule.keywords) {
        if (line.indexOf(keyword) !== -1) {
          keywordHit = true;
          break;
        }
      }
      if (!keywordHit) continue;
    }
    rule.regex.lastIndex = 0;
    if (rule.regex.test(line)) {
      return { type: rule.type, label: rule.label, severity: rule.severity, ruleId: rule.id };
    }
  }
  return null;
}

/**
 * 检测到问题后立即推送（每种类型独立去抖）
 * 在 logcat 实时数据事件中调用
 * @param {string} line 当前日志行
 * @param {number} lineIndex 当前日志在 logStore 中的索引
 * @param {string} source 日志源（'realtime' | 'file'），默认 'realtime'
 */
function autoDiagnoseOnLine(line, lineIndex, source = 'realtime', contextEntries = null, entry = null) {
  if (!autoDiagnoseEnabled) return;
  if (typeof line !== 'string') { reportDiagnosticIncomplete({ reason: 'line-limit', source }); return; }
  try { productionMatcher(); } catch { reportDiagnosticIncomplete({ reason: 'rule-limit', source }); return; }
  if (!diagnosticRules.some(rule => !rule.keywords?.length || rule.keywords.some(word => line.includes(word)))) return;
  const key = JSON.stringify([source, line]);
  if (pendingLive.has(key)) return;
  const bytes = Buffer.byteLength(line);
  if (bytes > MATCH_LIMITS.batchBytes) { reportDiagnosticIncomplete({ reason: 'line-limit', source }); return; }
  if (pendingLive.size >= MATCH_LIMITS.rows || liveBytes + bytes > MATCH_LIMITS.batchBytes) flushLiveDiagnostics();
  pendingLive.set(key, { line, index: lineIndex, source, contextEntries, entry: entry ? Object.freeze({ ...entry }) : null }); liveBytes += bytes;
  if (liveTimer === null) liveTimer = setTimeout(flushLiveDiagnostics, 0);
}
function emitDiagnosedIssue(issue, line, lineIndex, source, contextEntries = null, originalEntry = null) {
  const now = Date.now();
  // 同类型问题在去抖窗口内不重复推送
  const lastFire = autoDiagnoseLastFireByType[issue.type] || 0;
  if (now - lastFire < AUTO_DIAGNOSE_DEBOUNCE_MS) {
    return;
  }
  console.log(`[AutoDiagnose] 检测到 ${issue.label}（源: ${source}），line: ${line.slice(0, 100)}`);

  // 立即提取上下文快照（避免 logStore 截断后索引失效）
  // 支持外部传入的 entries（用于搜索结果重新扫描场景），避免使用错误的 logStore 源
  const entries = contextEntries || getLogStore()[source] || [];
  let index = originalEntry?.id ? entries.findIndex(entry => entry.id === originalEntry.id && entry.raw === originalEntry.raw && entry.deviceId === originalEntry.deviceId) : lineIndex;
  if (originalEntry && entries[index]?.raw !== originalEntry.raw) index = -1;
  const start = Math.max(0, index - AUTO_DIAGNOSE_CONTEXT_LINES);
  const end = Math.min(entries.length, index + AUTO_DIAGNOSE_CONTEXT_LINES + 1);
  const rows = index < 0 ? [originalEntry || { raw: line }] : entries.slice(start, end);
  const contextSnapshot = (index < 0 ? tr('上下文已离开保留窗口，仅保留诊断命中原文。') + '\n' : '') + rows.map(e => {
    if (typeof e.raw === 'string') return e.raw;
    const ts = e.ts ? new Date(e.ts).toLocaleString('zh-CN', { hour12: false }) : '';
    const lvl = e.level || 'V';
    const tag = e.tag || '';
    const pid = e.pid || 0;
    const msg = e.message || e.raw || '';
    return `${ts} ${lvl}/${tag}(${pid}): ${msg}`;
  }).join('\n');

  // 更新该类型的去抖时间戳
  autoDiagnoseLastFireByType[issue.type] = now;

  // 立即推送到渲染进程
  const issueWithCtx = {
    type: issue.type,
    label: issue.label,
    severity: issue.severity,
    context: contextSnapshot, ruleId: issue.ruleId, entryId: originalEntry?.id || '', deviceId: originalEntry?.deviceId || '', contextPartial: index < 0
  };

  const summary = { total: 1, [issue.type]: 1 };

  console.log(`[AutoDiagnose] 推送事件到渲染进程: ${issue.label}, context 长度: ${contextSnapshot.length}`);

  ctx.broadcastToAllWindows('auto-diagnose:detected', {
    issues: [issueWithCtx],
    summary,
    timestamp: now
  });
}

/**
 * 扫描已加载的文件日志，检测关键问题
 * 在文件加载完成后调用
 * @param {Array} entries 日志条目数组
 * @param {string} source 日志源标识（'file' | 'search' | 'realtime'），用于日志和上下文
 */
// 改为 async 函数，每 1000 条 yield 一次，防止阻塞主进程
async function autoDiagnoseScanFile(entries, source = 'file') {
  if (!autoDiagnoseEnabled || !entries || entries.length === 0) return;
  if (!Array.isArray(entries) || entries.length > 200000) { reportDiagnosticIncomplete({ reason: 'line-limit', source }); return; }
  resetAutoDiagnoseLastFire();
  const epoch = diagnosticEpoch;
  let matcher;
  try { matcher = productionMatcher(); } catch { reportDiagnosticIncomplete({ reason: 'rule-limit', source }); return; }
  console.log(`[AutoDiagnose] 开始扫描日志，共 ${entries.length} 行（源: ${source}）`);

  // 遍历所有条目，检测关键问题
  // 每种类型只取第一次出现的位置
  const detectedTypes = new Set();
  let incomplete = false;
  for (let offset = 0; offset < entries.length;) {
    if (epoch !== diagnosticEpoch || !autoDiagnoseEnabled) return;
    const lines = [], indices = [], originals = []; let bytes = 0;
    while (offset < entries.length && lines.length < MATCH_LIMITS.rows) {
      const entry = entries[offset];
      if (!entry || typeof (entry.raw ?? entry.message) !== 'string') { incomplete = true; reportDiagnosticIncomplete({ reason: 'line-limit', source }); offset++; continue; }
      const line = entry.raw ?? entry.message, size = Buffer.byteLength(line);
      if (size > MATCH_LIMITS.batchBytes) { incomplete = true; reportDiagnosticIncomplete({ reason: 'line-limit', source }); offset++; continue; }
      if (lines.length && bytes + size > MATCH_LIMITS.batchBytes) break;
      originals.push({ ...entries[offset], raw: line }); indices.push(offset++); lines.push(line); bytes += size;
    }
    try {
      const result = await matcher.match(lines, { source });
      if (epoch !== diagnosticEpoch || !autoDiagnoseEnabled) return;
      incomplete ||= result.incomplete;
      for (const issue of result.matches) {
        if (detectedTypes.has(issue.type)) continue;
        detectedTypes.add(issue.type); const index = indices[issue.index];
        emitDiagnosedIssue(issue, lines[issue.index], index, source, entries, originals[issue.index]);
      }
    } catch (error) {
      if (epoch !== diagnosticEpoch || error.code === 'DIAGNOSTIC_CANCELLED') return;
      incomplete = true; reportDiagnosticIncomplete({ reason: error.reason || 'worker-error', ruleId: error.ruleId, source });
    }
  }

  console.log(`[AutoDiagnose] ${incomplete ? '日志扫描不完整' : '日志扫描完成'}（源: ${source}），检测到 ${detectedTypes.size} 种问题`);

  // 扫描完成后广播事件，渲染进程据此从"监控中"切换到"扫描完成（无异常）"状态
  // 仅当 issueCount === 0 且非实时捕获时，渲染进程才切换到 clean 状态
  if (!incomplete && epoch === diagnosticEpoch) { diagnosticIncomplete = null; ctx.broadcastToAllWindows('auto-diagnose:scan-complete', {
    issueCount: detectedTypes.size,
    source,
    timestamp: Date.now()
  }); }

  return detectedTypes.size;
}

// 重置自动诊断去抖时间戳（log:clear / toggle 关闭时调用）
function resetAutoDiagnoseLastFire() {
  diagnosticEpoch++; clearTimeout(liveTimer); liveTimer = null; pendingLive.clear(); liveBytes = 0; diagnosticWarnings.clear();
  diagnosticMatcher?.cancel(); ruleTestMatcher?.dispose(); ruleTestMatcher = null;
  Object.keys(autoDiagnoseLastFireByType).forEach(k => delete autoDiagnoseLastFireByType[k]);
}

function register(rawIpcMain) {
  const ipcMain = https.protectIpc(rawIpcMain);
  // 诊断规则库 IPC：基础版可使用内置规则与重置，会员版解锁自定义规则和导入导出。
  ipcMain.handle('auto-diagnose:rules:list', async () => {
    return { ok: true, rules: publicRules() };
  });

  ipcMain.handle('auto-diagnose:rules:save', async (event, args) => {
    const raw = args?.rule || args;
    const state = readRuleState();
    if (AUTO_DIAGNOSE_BUILTIN_IDS.has(raw?.id)) {
      state.builtinEnabled[raw.id] = raw.enabled !== false;
      writeRuleState(state);
      resetAutoDiagnoseLastFire();
      return { ok: true, rules: publicRules() };
    }
    if (!(await ensureVipForRules())) {
      return { ok: false, code: 'vip_required', error: tr("自定义诊断规则为会员专属功能，请先开通会员") };
    }
    const normalized = normalizeRuleInput(raw);
    if (!normalized.ok) return { ok: false, error: normalized.error };
    const existingIndex = state.customRules.findIndex(rule => rule.id === normalized.rule.id);
    if (existingIndex >= 0) state.customRules[existingIndex] = normalized.rule;
    else state.customRules.unshift(normalized.rule);
    writeRuleState(state);
    resetAutoDiagnoseLastFire();
    return { ok: true, rule: normalized.rule, rules: publicRules() };
  });

  ipcMain.handle('auto-diagnose:rules:delete', async (event, args) => {
    if (!(await ensureVipForRules())) {
      return { ok: false, code: 'vip_required', error: tr("删除自定义规则为会员专属功能，请先开通会员") };
    }
    const id = String(args?.id || '').trim();
    if (!id || AUTO_DIAGNOSE_BUILTIN_IDS.has(id)) return { ok: false, error: 'builtin_rule_cannot_delete' };
    const state = readRuleState();
    const before = state.customRules.length;
    state.customRules = state.customRules.filter(rule => rule.id !== id);
    writeRuleState(state);
    resetAutoDiagnoseLastFire();
    return { ok: true, deleted: before !== state.customRules.length, rules: publicRules() };
  });

  ipcMain.handle('auto-diagnose:rules:reset', async () => {
    writeRuleState(createDefaultRuleState());
    resetAutoDiagnoseLastFire();
    return { ok: true, rules: publicRules() };
  });

  ipcMain.handle('auto-diagnose:rules:test', async (event, args) => {
    const line = String(args?.line || '');
    const rawRule = args?.rule;
    const normalized = rawRule ? normalizeRuleInput(rawRule) : null;
    if (normalized && !normalized.ok) return { ok: false, error: normalized.error };
    ruleTestMatcher?.dispose();
    const matcher = createDiagnosticMatcher({ onIncomplete: value => reportDiagnosticIncomplete({ ...value, source: 'rule-test' }) });
    ruleTestMatcher = matcher; const epoch = diagnosticEpoch, owner = event.sender;
    const cancel = () => matcher.dispose(); owner?.once?.('destroyed', cancel);
    const navigate = (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) cancel(); };
    owner?.on?.('did-start-navigation', navigate);
    try {
      matcher.configure(normalized ? [normalized.rule] : getEffectiveRules());
      const result = await matcher.match([line], { source: 'rule-test' });
      if (epoch !== diagnosticEpoch || owner?.isDestroyed?.() || ruleTestMatcher !== matcher) return { ok: false, cancelled: true };
      return { ok: true, matched: result.matches.length > 0, ...(normalized ? { rule: normalized.rule } : { issue: result.matches[0] || null }) };
    } catch (error) { return error.code === 'DIAGNOSTIC_CANCELLED' ? { ok: false, cancelled: true } : { ok: false, error: tr('规则测试未完成，请检查规则或缩小测试内容。'), code: error.code }; }
    finally { owner?.removeListener?.('destroyed', cancel); owner?.removeListener?.('did-start-navigation', navigate); matcher.dispose(); if (ruleTestMatcher === matcher) ruleTestMatcher = null; }
  });

  ipcMain.handle('auto-diagnose:rules:export', async () => {
    if (!(await ensureVipForRules())) {
      return { ok: false, code: 'vip_required', error: tr("导出诊断规则为会员专属功能，请先开通会员") };
    }
    return { ok: true, rules: publicRules(), exportedAt: new Date().toISOString() };
  });

  ipcMain.handle('auto-diagnose:rules:import', async (event, args) => {
    if (!(await ensureVipForRules())) {
      return { ok: false, code: 'vip_required', error: tr("导入诊断规则为会员专属功能，请先开通会员") };
    }
    const incoming = Array.isArray(args?.rules) ? args.rules : [];
    const state = readRuleState();
    for (const raw of incoming) {
      if (AUTO_DIAGNOSE_BUILTIN_IDS.has(raw?.id)) {
        state.builtinEnabled[raw.id] = raw.enabled !== false;
        continue;
      }
      const normalized = normalizeRuleInput(raw);
      if (!normalized.ok) continue;
      const existingIndex = state.customRules.findIndex(rule => rule.id === normalized.rule.id);
      if (existingIndex >= 0) state.customRules[existingIndex] = normalized.rule;
      else state.customRules.push(normalized.rule);
    }
    writeRuleState(state);
    resetAutoDiagnoseLastFire();
    return { ok: true, rules: publicRules() };
  });

  // 用户确认后触发 AI 分析（带自动诊断上下文）
  ipcMain.handle('auto-diagnose:analyze', async (event, args) => {
    try {
      const { issues, summary } = args || {};
      if (!issues || issues.length === 0) {
        return { ok: false, error: tr("没有可分析的问题") };
      }

      // 构造给 AI 的提示：将所有检测到的问题及上下文合并
      const issueBlocks = issues.map((issue, idx) => {
        return tr("### 问题 {0}：{1}（严重程度：{2}）\n\n```log\n{3}\n```", { 0: idx + 1, 1: issue.label, 2: issue.severity, 3: issue.context });
      }).join('\n\n---\n\n');

      const autoPrompt = tr('请分析以下设备日志中匹配到的 {0} 个问题线索：\n\n{1}\n\n根据实际平台区分 Android 崩溃/ANR 与鸿蒙 JS_CRASH、CPP_CRASH、APP_FREEZE。规则匹配不是根因证明；逐项说明日志事实、根因推测、优先级与建议验证。', { 0: issues.length, 1: issueBlocks });

      // 复用 AI 分析流程，但使用自动诊断的 prompt
      // 不传 filterContext，避免"自动诊断"字样误导 AI 的安全判断
      const systemPrompt = aiAnalyze.buildAiSystemPrompt(null);
      const userContent = autoPrompt;

      let messages;
      if (aiAnalyze.getAiConversationMessages().length === 0) {
        messages = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ];
      } else {
        // 压缩历史上下文，防止累积超限
        const compressedHistory = aiAnalyze.compressConversationContext(aiAnalyze.getAiConversationMessages());
        messages = [
          ...compressedHistory,
          { role: 'user', content: userContent }
        ];
      }

      // 取消之前的请求（保持原行为：共享 controller）
      if (aiAnalyze.hasActiveAiRequest()) {
        aiAnalyze.abortActiveAiRequestOnly();
      }

      const requestBody = JSON.stringify({
        model: AGNES_MODEL,
        messages,
        stream: true,
        temperature: 0.3
      });

      const urlObj = new URL(AGNES_API_URL);
      const sender = event.sender;

      if (!sender.isDestroyed()) {
        sender.send('ai:streamStart', { totalLines: issues.length, truncated: false, autoDiagnose: true });
      }

      let fullResponse = '';
      const AI_MAX_RETRIES = 0;
      let retryCount = 0;

      function doRequest(currentKey) {
        const controller = aiAnalyze.createNewAiAbortController();

        const options = {
          hostname: urlObj.hostname,
          port: 443,
          path: urlObj.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${currentKey}`,
            'Accept': 'text/event-stream'
          },
          signal: controller.signal
        };

        const req = https.request(options, (res) => {
          if (res.statusCode !== 200) {
            let errBody = '';
            res.on('data', (chunk) => { errBody += chunk; });
            res.on('end', () => {
              // 与原代码保持一致：用 aiAnalyze.hasActiveAiRequest() 判断是否已 abort
              if (!aiAnalyze.hasActiveAiRequest()) return;
              if (retryCount < AI_MAX_RETRIES && (res.statusCode === 429 || res.statusCode >= 500)) {
                retryCount++;
                const nextKey = getNextApiKey();
                console.log(`[AI-AutoDiagnose] API Key 出错(${res.statusCode})，第 ${retryCount} 次重试`);
                doRequest(nextKey);
                return;
              }
              if (!sender.isDestroyed()) {
                sender.send('ai:streamError', { error: tr("API返回 {0}: {1}", { 0: res.statusCode, 1: errBody.slice(0, 500) }) });
              }
              // 重试耗尽/不可重试：清空 controller（通过 abort + 置 null）
              aiAnalyze.abortAiRequest();
            });
            return;
          }

          let buffer = '';
          const decoder = new StringDecoder('utf8');
          res.on('data', (chunk) => {
            buffer += decoder.write(chunk);
            const linesArr = buffer.split('\n');
            buffer = linesArr.pop();

            for (const ln of linesArr) {
              const trimmed = ln.trim();
              if (!trimmed || !trimmed.startsWith('data: ')) continue;

              const data = trimmed.slice(6);
              if (data === '[DONE]') {
                aiAnalyze.pushAiMessages(userContent, fullResponse);
                aiAnalyze.setAiLastResult(fullResponse);
                if (!sender.isDestroyed()) {
                  sender.send('ai:streamEnd', {});
                }
                aiAnalyze.abortAiRequest();
                return;
              }

              try {
                const json = JSON.parse(data);
                const delta = json.choices?.[0]?.delta?.content;
                if (delta && !sender.isDestroyed()) {
                  fullResponse += delta;
                  sender.send('ai:streamChunk', { text: delta });
                }
              } catch {}
            }
          });

          res.on('end', () => {
            const tail = decoder.end();
            if (tail) buffer += tail;
            if (buffer.trim()) {
              const trimmed = buffer.trim();
              if (trimmed.startsWith('data: ') && trimmed.slice(6) !== '[DONE]') {
                try {
                  const json = JSON.parse(trimmed.slice(6));
                  const delta = json.choices?.[0]?.delta?.content;
                  if (delta && !sender.isDestroyed()) {
                    fullResponse += delta;
                    sender.send('ai:streamChunk', { text: delta });
                  }
                } catch {}
              }
            }
            if (aiAnalyze.hasActiveAiRequest() && !sender.isDestroyed()) {
              if (fullResponse) {
                aiAnalyze.pushAiMessages(userContent, fullResponse);
                aiAnalyze.setAiLastResult(fullResponse);
              }
              sender.send('ai:streamEnd', {});
              aiAnalyze.abortAiRequest();
            }
          });

          res.on('error', (e) => {
            if (e.name === 'AbortError' || !aiAnalyze.hasActiveAiRequest()) return;
            if (retryCount < AI_MAX_RETRIES && !fullResponse) {
              retryCount++;
              const nextKey = getNextApiKey();
              console.log(`[AI-AutoDiagnose] 流式网络错误，第 ${retryCount} 次重试`);
              doRequest(nextKey);
              return;
            }
            if (!sender.isDestroyed()) {
              sender.send('ai:streamError', { error: e.message });
            }
            aiAnalyze.abortAiRequest();
          });
        });

        req.on('error', (e) => {
          if (e.name === 'AbortError') {
            if (fullResponse) {
              aiAnalyze.pushAiMessages(userContent, fullResponse);
              aiAnalyze.setAiLastResult(fullResponse);
            }
            if (!sender.isDestroyed()) {
              sender.send('ai:streamEnd', {});
            }
            aiAnalyze.abortAiRequest();
            return;
          }
          if (retryCount < AI_MAX_RETRIES && !fullResponse) {
            retryCount++;
            const nextKey = getNextApiKey();
            console.log(`[AI-AutoDiagnose] 连接错误(${e.message})，第 ${retryCount} 次重试`);
            doRequest(nextKey);
            return;
          }
          if (!sender.isDestroyed()) {
            sender.send('ai:streamError', { error: e.message });
          }
          aiAnalyze.abortAiRequest();
        });

        req.write(requestBody);
        req.end();
      }

      doRequest(AGNES_API_KEYS[getAgnesKeyIndex()]);
      return { ok: true, autoDiagnose: true, issueCount: issues.length };
    } catch (error) {
      console.error('Auto-diagnose analyze error:', error);
      return { ok: false, error: error.message };
    }
  });

  // 切换自动诊断开关
  ipcMain.handle('auto-diagnose:toggle', async (event, args) => {
    if (typeof args?.enabled === 'boolean') {
      autoDiagnoseEnabled = args.enabled;
      if (!autoDiagnoseEnabled) {
        // 关闭时清空所有去抖时间戳，下次重新开启时能立即触发
        resetAutoDiagnoseLastFire();
      } else {
        resetAutoDiagnoseLastFire();
        const sender = event.sender;
        // 扫描当前日志源的所有日志
        const logStore = getLogStore();
        const currentEntries = logStore.realtime.length > 0 ? logStore.realtime : logStore.file;
        const epoch = diagnosticEpoch;
        if (currentEntries.length > 0) {
          console.log(`[AutoDiagnose] 重新开启，扫描已有日志 ${currentEntries.length} 条`);
          setTimeout(() => {
            if (epoch !== diagnosticEpoch || !autoDiagnoseEnabled) return;
            // autoDiagnoseScanFile 现在是 async 函数，使用 .catch 处理 Promise rejection
            autoDiagnoseScanFile(currentEntries).catch(e => {
              console.error('[AutoDiagnose] 重新扫描失败:', e.message);
            });
          }, 300);
        }
      }
    }
    return { ok: true, enabled: autoDiagnoseEnabled };
  });

  // 获取自动诊断状态
  ipcMain.handle('auto-diagnose:status', async () => {
    // 返回规则数量，供前端展示规则库状态。
    const rules = publicRules();
    return { ok: true, enabled: autoDiagnoseEnabled, ruleCount: rules.filter(rule => rule.enabled).length, rules, incomplete: diagnosticIncomplete };
  });

  // 清空自动诊断去抖时间戳（用户手动清除后可立即再次触发）
  ipcMain.handle('auto-diagnose:clear', async () => {
    resetAutoDiagnoseLastFire();
    return { ok: true };
  });

  // 重新扫描指定日志条目（搜索完成 / 返回原日志时触发，保持自动诊断与显示区域同步）
  // args.entries: 要扫描的条目数组；为 null 时使用 logStore[source]
  // args.source: 日志源标识（'realtime' | 'file' | 'search'）
  ipcMain.handle('auto-diagnose:rescan', async (event, args) => {
    if (!autoDiagnoseEnabled) {
      return { ok: false, error: tr("自动诊断未开启") };
    }
    const { entries: passedEntries, source: passedSource } = args || {};
    const source = passedSource || 'file';

    // 确定要扫描的条目：优先使用传入的，否则根据 source 从对应 logStore 取
    let entriesToScan = passedEntries;
    if (!entriesToScan) {
      const logStore = getLogStore();
      // 返回原日志场景：根据 source 选择对应日志源，避免误扫到另一源的残留数据
      if (source === 'realtime') {
        entriesToScan = logStore.realtime;
      } else if (source === 'file') {
        entriesToScan = logStore.file;
      } else {
        // 未知 source 时退回原逻辑：优先 realtime，其次 file
        entriesToScan = logStore.realtime.length > 0 ? logStore.realtime : logStore.file;
      }
    }

    if (!entriesToScan || entriesToScan.length === 0) {
      return { ok: false, error: tr("无日志可扫描") };
    }

    // 清空去抖时间戳，确保重新扫描时能立即触发各类问题
    resetAutoDiagnoseLastFire();
    const epoch = diagnosticEpoch;

    console.log(`[AutoDiagnose] 日志显示区域变更，重新扫描 ${entriesToScan.length} 条（源: ${source}）`);

    // 延迟 100ms 让渲染进程先重置 UI 到 "监控中" 状态
    setTimeout(() => {
      if (epoch !== diagnosticEpoch || !autoDiagnoseEnabled) return;
      autoDiagnoseScanFile(entriesToScan, source).catch(e => {
        console.error('[AutoDiagnose] 重新扫描失败:', e.message);
      });
    }, 100);

    return { ok: true, count: entriesToScan.length };
  });
}

module.exports = {
  _detectIssueForTests: detectIssue,
  disposeDiagnostics: () => { diagnosticMatcher?.dispose(); diagnosticMatcher = null; ruleTestMatcher?.dispose(); ruleTestMatcher = null; configuredRevision = -1; resetAutoDiagnoseLastFire(); },
  register,
  autoDiagnoseOnLine,
  autoDiagnoseScanFile,
  resetAutoDiagnoseLastFire,
  isAutoDiagnoseEnabled: () => autoDiagnoseEnabled,
};
