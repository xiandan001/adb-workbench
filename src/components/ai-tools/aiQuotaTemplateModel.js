import { tr } from '../../shared/i18n.js';
import { parseTree } from 'jsonc-parser';

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype', '__TAURI_CHANNEL_MARKER__', '__TAURI_TO_IPC_KEY__']);
const HEADERS = ['Accept', 'Content-Type', 'New-Api-User', 'X-Organization-Id', 'X-Project-Id'];
const bytes = value => new TextEncoder().encode(value).length;
const control = value => Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function shape(value, allowed, required = []) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw new Error(tr("配置字段无效；只允许 kind、request、extract，密钥及授权域名请填写外层专用字段。"));
}
function bounded(value) {
  let nodes = 0;
  const validText = item => {
    if (bytes(item) > 16 * 1024) throw new Error(tr("JSON 单个文本不能超过 16 KiB。"));
    if (new TextDecoder().decode(new TextEncoder().encode(item)) !== item || item.startsWith('__CHANNEL__:') || item === '__TAURI_CHANNEL_MARKER__') throw new Error(tr("JSON 包含无效字符或传输占位符。"));
  };
  const visit = (item, depth) => {
    if (++nodes > 10000 || depth > 20) throw new Error(tr("JSON 层级或节点数超过限制。"));
    if (typeof item === 'string') {
      validText(item);
    } else if (typeof item === 'number' && !Number.isFinite(item)) throw new Error(tr("JSON 数值必须有限。"));
    else if (item && typeof item === 'object') {
      if (Array.isArray(item) ? item.length > 64 : Object.keys(item).length > 256) throw new Error(tr("JSON 数组或对象字段超过限制。"));
      for (const [key, child] of Object.entries(item)) {
        if (FORBIDDEN.has(key)) throw new Error(tr("JSON 包含保留属性，未使用此配置。"));
        if (!Array.isArray(item)) validText(key);
        visit(child, depth + 1);
      }
    }
  };
  visit(value, 0);
  if (bytes(JSON.stringify(value)) > 64 * 1024) throw new Error(tr("查询配置不能超过 64 KiB。"));
}
function noDuplicates(text) {
  const errors = []; const tree = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  if (!tree || errors.length) throw new Error(tr("请填写合法 JSON；不支持注释、尾随逗号或 JavaScript 脚本。"));
  const nodes = [tree];
  while (nodes.length) {
    const node = nodes.pop();
    if (node.type === 'object') {
      const keys = new Set();
      for (const property of node.children || []) { const key = property.children?.[0]?.value; if (keys.has(key)) throw new Error(tr("JSON 存在重复字段，请保留唯一值。")); keys.add(key); }
    }
    for (const child of node.children || []) nodes.push(child);
  }
}
function jsonPath(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || !/^(?:\$\.)?[A-Za-z_][A-Za-z0-9_]*(?:\[\d{1,4}\]|\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(value)) throw new Error(tr("提取路径只支持 data.balance、$.data.balance 或数组下标，不支持表达式。"));
  if (value.replace(/^\$\./, '').replace(/\[(\d+)\]/g, '.$1').split('.').some(part => FORBIDDEN.has(part))) throw new Error(tr("提取路径包含保留属性。"));
}
function validateTemplate(value) {
  shape(value, ['kind', 'request', 'extract'], ['request', 'extract']); bounded({ adapter: 'custom', ...value });
  if (value.kind !== undefined && !['balance', 'plan'].includes(value.kind)) throw new Error(tr("kind 只能是 balance 或 plan。"));
  const request = value.request; shape(request, ['path', 'method', 'headers', 'body'], ['path', 'method']);
  if (typeof request.path !== 'string' || !request.path.startsWith('/') || request.path.startsWith('//') || request.path.includes('\\') || request.path.includes('#') || control(request.path) || request.path.length > 2048 || !['GET', 'POST'].includes(request.method)) throw new Error(tr("request 需要以 / 开始的相对路径及 GET / POST 方法。"));
  let url; try { url = new URL(request.path, 'https://quota.invalid'); } catch { throw new Error(tr("查询相对路径无效。")); }
  if (url.origin !== 'https://quota.invalid') throw new Error(tr("查询路径不能切换域名。"));
  for (const key of url.searchParams.keys()) if (/api[_-]?key|token|secret|password|authorization|cookie|^auth$|^key$/i.test(key)) throw new Error(tr("URL 查询参数不能存放凭据，请使用外层独立额度密钥。"));
  if (request.method === 'GET' && request.body !== undefined) throw new Error(tr("GET 查询不能填写 body。"));
  if (request.headers !== undefined) {
    shape(request.headers, HEADERS);
    for (const [name, header] of Object.entries(request.headers)) {
      if (typeof header !== 'string' || header.length > 128 || control(header)) throw new Error(tr("请求头值无效。"));
      if (['Accept', 'Content-Type'].includes(name) ? !/^application\/json(?:;\s*charset=utf-8)?$/i.test(header) : name === 'New-Api-User' ? !/^\d{1,20}$/.test(header) : !/^[A-Za-z0-9_-]{1,128}$/.test(header)) throw new Error(tr("仅支持公开 JSON 类型、数字用户标识或组织 / 项目标识请求头。"));
    }
  }
  const scan = body => { if (!body || typeof body !== 'object') return; for (const [key, child] of Object.entries(body)) { if (/authorization|api[-_]?key|token|secret|password|cookie/i.test(key)) throw new Error(tr("body 不能存放凭据，请使用外层独立额度密钥。")); scan(child); } };
  scan(request.body); shape(value.extract, ['metrics'], ['metrics']); const metrics = value.extract.metrics;
  if (!Array.isArray(metrics) || !metrics.length || metrics.length > 32) throw new Error(tr("extract.metrics 需要 1–32 个指标。"));
  for (const metric of metrics) {
    shape(metric, ['label', 'unit', 'remaining', 'used', 'total', 'resetAt'], ['label', 'unit']);
    if (typeof metric.label !== 'string' || !metric.label.trim() || metric.label.length > 80 || control(metric.label) || typeof metric.unit !== 'string' || !metric.unit.trim() || metric.unit.length > 16 || control(metric.unit) || !['remaining', 'used', 'total'].some(key => Object.hasOwn(metric, key))) throw new Error(tr("指标需要有效名称、单位及 remaining / used / total 中至少一个提取路径。"));
    for (const field of ['remaining', 'used', 'total', 'resetAt']) if (metric[field] !== undefined) jsonPath(metric[field]);
  }
  return value;
}

export function parseQuotaTemplate(text) {
  if (typeof text !== 'string' || !text.trim() || bytes(text) > 256 * 1024) throw new Error(tr("请填写不超过 256 KiB 的声明式 JSON 查询模板。"));
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(tr("请填写合法 JSON，不支持注释或 JavaScript 脚本。")); }
  validateTemplate(value); noDuplicates(text); return value;
}
export function stringifyQuotaTemplate(quota) {
  const value = quota?.request && quota?.extract ? { ...(quota.kind !== undefined ? { kind: quota.kind } : {}), request: quota.request, extract: quota.extract } : {
    kind: 'balance', request: { path: '/replace-with-real-quota-path', method: 'GET' }, extract: { metrics: [{ label: tr("余额"), unit: 'USD', remaining: 'data.replace_with_real_balance_field' }] },
  };
  return JSON.stringify(value, null, 2);
}
