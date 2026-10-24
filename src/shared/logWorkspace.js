import { tr } from './i18n.js';
export const LOG_PRESETS_KEY = 'logFilterPresets.v1';
export const MAX_LOG_PRESETS = 20;
export const MAX_EVIDENCE_ENTRIES = 100000;
const FILTER_TEXT_KEYS = ['text', 'excludeText', 'regex', 'regexFlags', 'pkg', 'tag', 'minLevel'];
const BUFFERS = ['main', 'system', 'radio', 'events', 'crash', 'kernel'];

export function normalizeLogFilter(value = {}) {
  const filter = {};
  for (const key of FILTER_TEXT_KEYS) {
    if (typeof value[key] === 'string' && value[key]) filter[key] = value[key];
  }
  if (Number.isFinite(value.pid)) filter.pid = value.pid;
  return filter;
}

export function normalizeLogBuffers(value) {
  const buffers = Array.isArray(value) ? [...new Set(value.filter(item => BUFFERS.includes(item)))] : [];
  return buffers.length ? buffers : ['main'];
}

export function readLogPresets(storage) {
  const data = JSON.parse(storage.getItem(LOG_PRESETS_KEY) || '[]');
  if (!Array.isArray(data)) throw new Error(tr("过滤预设格式无效"));
  return data.filter(item => item && typeof item.id === 'string' && typeof item.name === 'string')
    .map(item => ({ id: item.id, name: item.name, filter: normalizeLogFilter(item.filter), buffers: normalizeLogBuffers(item.buffers) }));
}

export function saveLogPreset(storage, presets, { name, filter, buffers }, id) {
  const title = name.trim();
  if (!title || title.length > 40) throw new Error(tr("请输入 1–40 字的预设名称"));
  if (presets.length >= MAX_LOG_PRESETS) throw new Error(tr("最多保存 20 个预设，请先删除不再使用的预设"));
  const next = [...presets, { id, name: title, filter: normalizeLogFilter(filter), buffers: normalizeLogBuffers(buffers) }];
  storage.setItem(LOG_PRESETS_KEY, JSON.stringify(next));
  return next;
}

export function deleteLogPreset(storage, presets, id) {
  const next = presets.filter(item => item.id !== id);
  storage.setItem(LOG_PRESETS_KEY, JSON.stringify(next));
  return next;
}

// References belong to captured raw entries, never to a filtered row index.
export function captureLogEvidence(entries, previous = [], deviceId = '') {
  const evidence = [...previous];
  const identityOf = (entry, device) => JSON.stringify([entry.id, entry.raw, entry.source || '', device || '']);
  const byIdentity = new Map(previous.map(item => [identityOf(item, item.deviceId), item]));
  const references = new Map();
  let nextNumber = previous.reduce((max, item) => Math.max(max, Number(item.ref?.slice(1)) || 0), 0) + 1;
  for (const entry of entries) {
    const identity = identityOf(entry, deviceId);
    let saved = byIdentity.get(identity);
    if (!saved) {
      if (evidence.length >= MAX_EVIDENCE_ENTRIES) throw new Error(tr("证据已达 100,000 条上限，请保存本次会话后清空 AI 对话再开始新分析；未丢弃任何证据"));
      saved = { ...entry, ref: `L${nextNumber++}`, deviceId };
      evidence.push(saved);
      byIdentity.set(identity, saved);
    }
    references.set(entry.id, saved.ref);
  }
  return { evidence, references };
}

export function findEvidenceReferences(content, allowedRefs, evidence) {
  const allowed = allowedRefs instanceof Set ? allowedRefs : new Set(allowedRefs || []);
  const byRef = evidence instanceof Map ? evidence : new Map(evidence.map(entry => [entry.ref, entry]));
  return [...new Set(String(content || '').match(/\[L[1-9]\d*\]/g) || [])].map(token => {
    const ref = token.slice(1, -1);
    return { ref, entry: allowed.has(ref) ? byRef.get(ref) : undefined };
  });
}

export function fingerprintLogLines(lines) {
  let hash = 2166136261;
  for (const line of lines) {
    for (let index = 0; index < line.length; index += 1) hash = Math.imul(hash ^ line.charCodeAt(index), 16777619);
    hash = Math.imul(hash ^ 10, 16777619);
  }
  return `${lines.length}:${hash >>> 0}`;
}
