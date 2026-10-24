const { tr } = require('./localization.cjs');
const { types } = require('node:util');

const REPOSITORY = 'xiandan001/adb-workbench';
const LOG_LIMIT = 16 * 1024;
const CATEGORIES = Object.freeze({ general: '其他问题', startup: '启动与更新', devices: '设备与投屏', serial: '串口 / RS232', ssh: 'SSH 工作区', 'ai-tools': 'AI 工具', ui: '界面与交互' });
const fail = (code, message) => Object.assign(new Error(message), { code });
function exact(value, keys) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const own = Reflect.ownKeys(value); const descriptors = Object.getOwnPropertyDescriptors(value);
  return own.length === keys.length && own.every(key => keys.includes(key) && Object.hasOwn(descriptors[key], 'value'));
}
function redactText(value) {
  return String(value)
    .replace(/-----BEGIN [A-Z\d ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z\d ]*PRIVATE KEY-----|$)/g, tr("[私钥已隐藏]"))
    .replace(/\b(?:github_pat_[A-Za-z\d_]{10,}|gh[pousrf]_[A-Za-z\d_]{10,}|sk-[A-Za-z\d_-]{10,})\b/g, tr("[密钥已隐藏]"))
    .replace(/\bBearer\s+[^\s"'<>]+/gi, tr("Bearer [已隐藏]"))
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|authorization|cookie|token|密码|激活码)\s*["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi, tr("$1\"[已隐藏]\""))
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|authorization|cookie|token|密码|激活码)\s*["']?\s*[:=]\s*)[^\s,;"'<>]+/gi, tr("$1[已隐藏]"))
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, tr("$1[凭据已隐藏]@"))
    .replace(/\b[A-Z]:[\\/][^\s"'<>]*/gi, tr("[本地路径已隐藏]"))
    .replace(/\\\\[^\s"'<>]+/g, tr("[网络路径已隐藏]"))
    .replace(/\/(?:home|Users)\/[^\s"'<>]+/g, tr("[用户路径已隐藏]"))
    .replace(/\b[A-Z\d._%+-]+@[A-Z\d.-]+\.[A-Z]{2,}\b/gi, tr("[邮箱已隐藏]"))
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, match => match.split('.').every(part => Number(part) <= 255) ? tr("[IP已隐藏]") : match)
    .replace(/\beyJ[A-Za-z\d_-]{8,}\.[A-Za-z\d_-]{8,}\.[A-Za-z\d_-]{8,}\b/g, tr("[令牌已隐藏]"))
    .replace(/\r\n?/g, '\n');
}
function field(value, label, max, required = false) {
  if (typeof value !== 'string' || value.length > max || Array.from(value).some(character => {
    const code = character.charCodeAt(0); return code === 127 || code < 32 && ![9, 10, 13].includes(code);
  })) throw fail('FEEDBACK_INPUT', tr("{0}格式无效或内容过长", { 0: label }));
  const result = value.trim(); if (required && !result) throw fail('FEEDBACK_INPUT', tr("请填写{0}", { 0: label }));
  return redactText(result);
}
function normalizeForm(value) {
  if (!exact(value, ['title', 'category', 'description', 'steps', 'expected', 'includeEnvironment', 'includeLogs'])
    || !Object.hasOwn(CATEGORIES, value.category) || typeof value.includeEnvironment !== 'boolean' || typeof value.includeLogs !== 'boolean') throw fail('FEEDBACK_INPUT', tr("问题上报参数无效"));
  const title = field(value.title, tr("问题标题"), 120, true);
  if (title.includes('\n')) throw fail('FEEDBACK_INPUT', tr("问题标题不能换行"));
  return { title, category: value.category, description: field(value.description, tr("问题描述"), 4000, true),
    steps: field(value.steps, tr("复现步骤"), 4000), expected: field(value.expected, tr("预期结果"), 2000),
    includeEnvironment: value.includeEnvironment, includeLogs: value.includeLogs };
}
function environmentForReport(value) {
  const shapes = { app: ['name', 'version', 'electron', 'chrome', 'node', 'packaged', 'uptimeSeconds'],
    os: ['platform', 'name', 'version', 'build', 'architecture', 'locale'], computer: ['manufacturer', 'model', 'cpu', 'logicalCores', 'memoryBytes'] };
  const clean = input => typeof input === 'string' ? redactText(input.slice(0, 240))
    : typeof input === 'boolean' || typeof input === 'number' && Number.isFinite(input) ? input : null;
  const result = { collectedAt: typeof value?.collectedAt === 'string' ? value.collectedAt.slice(0, 32) : null };
  for (const [group, names] of Object.entries(shapes)) result[group] = Object.fromEntries(names.map(name => [name, clean(value?.[group]?.[name])]));
  result.displays = Array.isArray(value?.displays) ? value.displays.slice(0, 16).map(display => Object.fromEntries(['width', 'height', 'scaleFactor'].map(key => [key, typeof display?.[key] === 'number' ? clean(display[key]) : null]))) : [];
  result.unavailable = Array.isArray(value?.unavailable) ? value.unavailable.filter(item => typeof item === 'string' && /^(?:app|os|computer|displays)(?:\.[A-Za-z]+)?$/.test(item)).slice(0, 30) : [];
  return result;
}
function fenced(text) {
  const maximum = Math.max(2, ...Array.from(text.matchAll(/`+/g), match => match[0].length));
  const fence = '`'.repeat(maximum + 1); return `${fence}text\n${text || tr("未填写")}\n${fence}`;
}
function buildReport(form, environment, log, reportId) {
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(reportId)) throw fail('FEEDBACK_INPUT', tr("报告标识无效"));
  const lines = [`<!-- workbench-report:${reportId} -->`, tr("## 问题描述"), fenced(form.description), tr("## 复现步骤"), fenced(form.steps), tr("## 预期结果"), fenced(form.expected), tr("## 所属模块\n{0}", { 0: tr(CATEGORIES[form.category]) })];
  const env = form.includeEnvironment ? environmentForReport(environment) : null;
  if (env) lines.push(tr("## 环境信息"), fenced(JSON.stringify(env, null, 2)));
  let summary = { included: false, bytes: 0, lines: 0, truncated: false };
  if (form.includeLogs) {
    const text = typeof log?.text === 'string' ? redactText(log.text) : '';
    if (Buffer.byteLength(text) > LOG_LIMIT) throw fail('FEEDBACK_LOG_LIMIT', tr("诊断日志超过提交上限，请重新生成预览"));
    summary = { included: true, bytes: Buffer.byteLength(text), lines: text ? text.trimEnd().split('\n').length : 0, truncated: Boolean(log?.truncated) };
    lines.push('<details>', tr("<summary>卓控台应用诊断日志 · {0} 行{1}</summary>", { 0: summary.lines, 1: summary.truncated ? tr(" · 仅最近记录") : '' }), '', fenced(text || tr("本次暂无可用的应用诊断日志")), '</details>');
  }
  lines.push(tr("报告编号：{0}", { 0: reportId }));
  const body = lines.join('\n\n');
  if (Buffer.byteLength(body) > 60 * 1024 || body.length > 60000) throw fail('FEEDBACK_REPORT_LIMIT', tr("报告内容过长，请缩短问题描述"));
  return { title: `[${tr(CATEGORIES[form.category])}] ${form.title}`, body, environment: env, log: summary };
}
function issueUrl(value) {
  let url; try { url = new URL(value); } catch { throw fail('FEEDBACK_URL', tr("问题链接无效")); }
  if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash
    || !new RegExp(`^/${REPOSITORY}/issues/[1-9]\\d*$`).test(url.pathname)) throw fail('FEEDBACK_URL', tr("只能打开本仓库的问题链接"));
  return url.href;
}
module.exports = { REPOSITORY, LOG_LIMIT, CATEGORIES, fail, exact, redactText, normalizeForm, environmentForReport, buildReport, issueUrl };
