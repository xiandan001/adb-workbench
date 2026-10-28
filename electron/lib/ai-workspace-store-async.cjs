const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { tr } = require('./localization.cjs');
const { sanitize } = require('./ai-workspace-evidence.cjs');
const { validateReport, UUID } = require('./ai-workspace-history.cjs');
const limits = require('./ai-workspace-limits.cjs');
const fail = (code = 'AI_REPORT', message = tr('报告无效、已损坏或超过本地保存限制。')) => Object.assign(new Error(message), { code, safe: true });
const cancelled = flag => { if (flag && Atomics.load(flag, 0)) throw fail('CANCELLED', tr('操作已取消')); };

function normalizeReview(value) {
  const fields = { rootCause: 2000, solution: 4000, verification: 2000, packageName: 200, version: 80 };
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['status', 'tags', ...Object.keys(fields)].includes(key))
    || !['verified', 'rejected', 'unverified'].includes(value.status) || !Array.isArray(value.tags) || value.tags.length > 8) throw fail('AI_CASEBOOK_REVIEW', tr('案例验证信息无效或过长。'));
  const result = { status: value.status };
  for (const [key, max] of Object.entries(fields)) {
    if (typeof value[key] !== 'string' || value[key].length > max) throw fail('AI_CASEBOOK_REVIEW', tr('案例验证信息无效或过长。'));
    result[key] = sanitize(value[key].trim());
    if (result[key].length > max) throw fail('AI_CASEBOOK_REVIEW', tr('案例验证信息无效或过长。'));
  }
  if (value.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 32)) throw fail('AI_CASEBOOK_REVIEW', tr('案例验证信息无效或过长。'));
  result.tags = [...new Set(value.tags.map(tag => sanitize(tag.trim())))];
  if (result.status !== 'unverified' && !result.verification) throw fail('AI_CASEBOOK_REVIEW', tr('标记已验证或误判前，请填写实际验证依据。'));
  return result;
}

async function atomicWriteAsync(filename, content, { io = fs, flag } = {}) {
  cancelled(flag);
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
  let handle;
  try {
    let stat;
    try { stat = await io.lstat(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw fail();
    handle = await io.open(temporary, 'wx', 0o600);
    await handle.writeFile(content, 'utf8'); await handle.sync(); await handle.close(); handle = null;
    cancelled(flag);
    await io.rename(temporary, filename);
  } finally {
    if (handle) await handle.close();
    try { await io.unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function createAsyncReportStore({ directory, casebook = false, io = fs, now = Date.now }) {
  const root = path.resolve(directory), indexFile = path.join(root, 'index.json');
  const countLimit = casebook ? 50 : limits.reports, totalLimit = casebook ? 64 * 1024 * 1024 : limits.historyBytes;
  const indexLimit = casebook ? 512 * 1024 : 128 * 1024;
  const filename = id => { if (!UUID.test(id || '')) throw fail(); return path.join(root, `${id}.json`); };
  async function ready(create = false) {
    let stat;
    try { stat = await io.lstat(root); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return false;
      let ancestor = path.dirname(root);
      for (;;) {
        try { const ancestorStat = await io.lstat(ancestor); if (!ancestorStat.isDirectory() || ancestorStat.isSymbolicLink() || path.resolve(await io.realpath(ancestor)) !== ancestor) throw fail(); break; }
        catch (error) { if (error.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw error; ancestor = path.dirname(ancestor); }
      }
      await io.mkdir(root, { recursive: true }); stat = await io.lstat(root);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(await io.realpath(root)) !== root) throw fail();
    return true;
  }
  async function read(filename, max) {
    const stat = await io.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw fail();
    const handle = await io.open(filename, 'r');
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > max || opened.dev !== stat.dev || opened.ino !== stat.ino) throw fail();
      const buffer = Buffer.allocUnsafe(max + 1); let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset > max) throw fail();
      return JSON.parse(buffer.subarray(0, offset).toString('utf8'));
    } finally { await handle.close(); }
  }
  async function index() {
    if (!await ready()) return [];
    let data;
    try { data = await read(indexFile, indexLimit); } catch (error) { if (error.code === 'ENOENT') return []; throw fail(); }
    if (data?.version !== 1 || !Array.isArray(data.items) || data.items.length > countLimit) throw fail();
    const ids = new Set();
    for (const item of data.items) {
      if (!UUID.test(item?.id || '') || ids.has(item.id) || typeof item.name !== 'string' || item.name.length > 80
        || typeof item.question !== 'string' || item.question.length > 4000 || !Number.isFinite(Date.parse(item.createdAt))
        || !['analysis', 'followup', 'comparison'].includes(item.kind) || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > limits.reportBytes) throw fail();
      if (casebook && (!Number.isSafeInteger(item.revision) || item.revision < 1 || typeof item.searchText !== 'string' || item.searchText.length > 3000
        || !['verified', 'rejected', 'unverified'].includes(item.status) || typeof item.packageName !== 'string' || item.packageName.length > 200 || typeof item.version !== 'string' || item.version.length > 80
        || !Array.isArray(item.tags) || item.tags.length > 8 || item.tags.some(tag => typeof tag !== 'string' || tag.length > 32))) throw fail();
      ids.add(item.id);
    }
    return data.items;
  }
  function metadata(report, bytes) {
    const base = { id: report.id, name: report.name, createdAt: report.createdAt, kind: report.kind, question: report.preview.question, bytes };
    if (!casebook) return base;
    const review = report.review;
    return { ...base, revision: report.revision, updatedAt: report.updatedAt, status: review.status, packageName: review.packageName, version: review.version, tags: review.tags,
      searchText: [report.name, review.packageName, review.version, ...review.tags, report.preview.question, review.rootCause, review.solution].join(' ').slice(0, 3000).toLocaleLowerCase() };
  }
  const publicItem = ({ bytes: _bytes, searchText: _search, ...item }) => item;
  async function load(id) {
    const item = (await index()).find(item => item.id === id); if (!item) throw fail();
    try {
      const report = validateReport(await read(filename(id), limits.reportBytes));
      if (report.id !== id || report.name !== item.name) throw fail();
      if (casebook) { report.review = normalizeReview(report.review); if (report.revision !== item.revision || report.review.status !== item.status || report.review.packageName !== item.packageName || report.review.version !== item.version) throw fail(); }
      return report;
    } catch { throw fail(); }
  }
  async function list(args = {}) {
    const query = args.query ?? '';
    if (typeof query !== 'string' || query.length > 200 || (args.status && !['verified', 'rejected', 'unverified'].includes(args.status))
      || (args.packageName && (typeof args.packageName !== 'string' || args.packageName.length > 200))) throw fail();
    return (await index()).filter(item => !casebook || ((!args.status || item.status === args.status) && (!args.packageName || item.packageName === args.packageName)
      && (!query.trim() || item.searchText.includes(query.trim().toLocaleLowerCase())))).map(publicItem);
  }
  async function save(reportValue, name, review, flag) {
    cancelled(flag);
    if (typeof name !== 'string' || name.trim().length > 80) throw fail();
    const timestamp = new Date(now()).toISOString();
    const report = validateReport({ ...structuredClone(reportValue), turnId: reportValue.turnId || reportValue.id, id: randomUUID(), name: sanitize(name.trim() || reportValue.preview.question.slice(0, 80)), savedAt: timestamp,
      ...(casebook ? { review: normalizeReview(review), revision: 1, updatedAt: timestamp } : {}) });
    const content = JSON.stringify(report), bytes = Buffer.byteLength(content);
    await ready(true); const items = await index();
    if (items.length >= countLimit || items.reduce((sum, item) => sum + item.bytes, bytes) > totalLimit) throw fail('AI_CASEBOOK_LIMIT', tr('本地报告数量或空间已满，请先导出或删除不再需要的内容。'));
    const item = metadata(report, bytes), target = filename(report.id);
    await atomicWriteAsync(target, content, { io, flag });
    try { await atomicWriteAsync(indexFile, JSON.stringify({ version: 1, items: [item, ...items] }), { io, flag }); }
    catch (error) { await io.unlink(target); throw error; }
    return publicItem(item);
  }
  async function update(id, revision, review, flag) {
    if (!casebook) throw fail();
    const report = await load(id);
    if (!Number.isSafeInteger(revision) || revision !== report.revision) throw fail('AI_CASEBOOK_CONFLICT', tr('案例已被更新，请重新打开后再保存。'));
    const next = { ...report, review: normalizeReview(review), revision: revision + 1, updatedAt: new Date(now()).toISOString() };
    const content = JSON.stringify(next), bytes = Buffer.byteLength(content), items = await index();
    if (bytes > limits.reportBytes || items.reduce((sum, item) => sum + (item.id === id ? 0 : item.bytes), bytes) > totalLimit) throw fail();
    const item = metadata(next, bytes), target = filename(id), original = JSON.stringify(report);
    await atomicWriteAsync(target, content, { io, flag });
    try { await atomicWriteAsync(indexFile, JSON.stringify({ version: 1, items: items.map(value => value.id === id ? item : value) }), { io, flag }); }
    catch (error) { await atomicWriteAsync(target, original, { io }); throw error; }
    return publicItem(item);
  }
  async function remove(id, flag) {
    cancelled(flag);
    const items = await index(); if (!items.some(item => item.id === id)) throw fail();
    const target = filename(id), retired = path.join(root, `.${id}.${randomUUID()}.removed`);
    let stat;
    try { stat = await io.lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw fail();
    if (stat) await io.rename(target, retired);
    try { await atomicWriteAsync(indexFile, JSON.stringify({ version: 1, items: items.filter(item => item.id !== id) }), { io, flag }); }
    catch (error) { if (stat) await io.rename(retired, target); throw error; }
    if (stat) await io.unlink(retired);
  }
  async function similar(reportValue, limit = 5) {
    const report = validateReport(reportValue);
    const query = `${report.preview.question} ${report.result.summary}`.toLocaleLowerCase();
    const terms = [...new Set(query.match(/[a-z][a-z0-9_.]{2,}|[\u3400-\u9fff]{2,12}/g) || [])].slice(0, 30);
    const packageName = report.preview.diagnostic?.packageName || '';
    return (await index()).map(item => {
      const matches = terms.filter(term => item.searchText.includes(term)).slice(0, 8);
      const packageMatch = Boolean(packageName && item.packageName === packageName);
      return { ...publicItem(item), matchTerms: matches, packageMatch, score: matches.length + (packageMatch ? 10 : 0) };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.min(5, Math.max(1, Number(limit) || 5)));
  }
  return { list, load, save, update, delete: remove, similar };
}
module.exports = { createAsyncReportStore, atomicWriteAsync, normalizeReview, cancelled };
