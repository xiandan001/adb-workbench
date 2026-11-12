const fs = require('node:fs/promises');
const path = require('node:path');
const { tr } = require('./localization.cjs');
const { validateReport, UUID } = require('./ai-workspace-history.cjs');
const { atomicWriteAsync } = require('./ai-workspace-store-async.cjs');

const BASKET_LIMITS = Object.freeze({ items: 8, bytes: 1024 * 1024 });
const fail = (code = 'AI_BASKET_INVALID', message = tr('本地证据篮无效或已损坏；原文件已保留。')) => Object.assign(new Error(message), { code, safe: true });
const fields = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
const text = (value, limit) => typeof value === 'string' && value.length <= limit && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const ENTRY_FIELDS = ['id', 'source', 'label', 'evidenceKind', 'target', 'capturedAt', 'timeBasis', 'text', 'numbered', 'platform', 'targetKey', 'truncated', 'redactions',
  'lineCount', 'originalLineCount', 'selectedLineCount', 'retainedLineCount', 'selectionWarning', 'windowInfo', 'originalLineNumbers', 'events', 'timeWarning', 'provenance', 'diagnostic', 'unavailable'];

function validateBasket(value) {
  if (!fields(value, ['version', 'revision', 'items']) || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !Array.isArray(value.items) || value.items.length > BASKET_LIMITS.items || Buffer.byteLength(JSON.stringify(value)) > BASKET_LIMITS.bytes) throw fail();
  const ids = new Set();
  for (const item of value.items) {
    if (!fields(item, ['id', 'origin', 'title', 'question', 'deviceId', 'createdAt', 'provenance', 'truncated', 'entries']) || !UUID.test(item.id || '') || ids.has(item.id)
      || !text(item.origin, 40) || !text(item.title, 240) || !text(item.question, 4000) || !text(item.deviceId, 160)
      || !text(item.createdAt, 40) || !Number.isFinite(Date.parse(item.createdAt)) || typeof item.truncated !== 'boolean'
      || !fields(item.provenance, ['trust', 'origin', 'binding']) || !['renderer-view', 'server-snapshot'].includes(item.provenance.trust)
      || !text(item.provenance.origin, 80) || item.provenance.binding !== undefined && !/^[a-f\d]{64}$/.test(item.provenance.binding)
      || !Array.isArray(item.entries) || !item.entries.length || item.entries.length > 32) throw fail();
    for (const entry of item.entries) {
      if (!fields(entry, ENTRY_FIELDS) || entry.provenance && (!fields(entry.provenance, ['trust', 'origin', 'binding'])
        || entry.provenance.binding !== undefined && !/^[a-f\d]{64}$/.test(entry.provenance.binding))
        || entry.events?.some(event => !fields(event, ['line', 'timestamp', 'clockBasis']))
        || entry.windowInfo && !fields(entry.windowInfo, ['originalRecords', 'retainedRecords', 'byteLimit'])
        || entry.diagnostic && !fields(entry.diagnostic, ['packageName', 'symptom'])) throw fail();
    }
    try {
      validateReport({ id: item.id, kind: 'analysis', createdAt: item.createdAt, preview: { id: item.id, question: item.question, entries: item.entries },
        result: { summary: 'Frozen evidence', findings: [], hypotheses: [], nextSteps: [], limitations: [] } });
    } catch { throw fail(); }
    ids.add(item.id);
  }
  return structuredClone(value);
}

function createEvidenceBasketStore({ filename, io = fs }) {
  const target = path.resolve(filename), directory = path.dirname(target);
  let tail = Promise.resolve();
  async function read() {
    try {
      const parent = await io.lstat(directory);
      if (!parent.isDirectory() || parent.isSymbolicLink() || path.resolve(await io.realpath(directory)) !== directory) throw fail();
      const stat = await io.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BASKET_LIMITS.bytes) throw fail();
      const handle = await io.open(target, 'r');
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size > BASKET_LIMITS.bytes || opened.dev !== stat.dev || opened.ino !== stat.ino) throw fail();
        const buffer = Buffer.alloc(BASKET_LIMITS.bytes + 1); let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        if (offset > BASKET_LIMITS.bytes) throw fail();
        return validateBasket(JSON.parse(buffer.subarray(0, offset).toString('utf8')));
      } finally { await handle.close(); }
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, revision: 0, items: [] };
      throw fail(error.code === 'AI_BASKET_INVALID' ? error.code : 'AI_BASKET_INVALID');
    }
  }
  function publicBasket(value) {
    return { revision: value.revision, bytes: Buffer.byteLength(JSON.stringify(value)), items: value.items.map(({ entries, ...item }) => ({ ...item,
      bytes: Buffer.byteLength(JSON.stringify(entries)), lineCount: entries.reduce((sum, entry) => sum + entry.lineCount, 0) })) };
  }
  function mutate(change) {
    const result = tail.catch(() => {}).then(async () => {
      const current = await read(), next = change(current);
      next.revision = current.revision + 1;
      if (next.items.length > BASKET_LIMITS.items || Buffer.byteLength(JSON.stringify(next)) > BASKET_LIMITS.bytes) throw fail('AI_BASKET_LIMIT', tr('证据篮已达 8 项或 1 MiB 上限，请先移除材料。'));
      validateBasket(next);
      await atomicWriteAsync(target, JSON.stringify(next), { io });
      return publicBasket(next);
    });
    tail = result; return result;
  }
  return {
    async list() { await tail.catch(() => {}); return publicBasket(await read()); },
    append(item) { return mutate(current => ({ ...current, items: [...current.items, structuredClone(item)] })); },
    remove(id) {
      return mutate(current => {
        if (!UUID.test(id || '') || !current.items.some(item => item.id === id)) throw fail();
        return { ...current, items: current.items.filter(item => item.id !== id) };
      });
    },
    clear() { return mutate(current => ({ ...current, items: [] })); },
    async resolve(revision) {
      await tail.catch(() => {}); const value = await read();
      if (!Number.isSafeInteger(revision) || revision !== value.revision) throw fail('AI_BASKET_CHANGED', tr('证据篮已变化，请重新采集并核对预览。'));
      return { ...publicBasket(value), entries: value.items.flatMap(item => item.entries) };
    },
  };
}
module.exports = { createEvidenceBasketStore, validateBasket, BASKET_LIMITS };
