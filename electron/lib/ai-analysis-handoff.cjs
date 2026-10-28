const { randomUUID, createHash } = require('node:crypto');
const { tr, getLocale } = require('./localization.cjs');
const { boundedText } = require('./ai-workspace-evidence.cjs');
const { runWorkspaceJob } = require('./ai-workspace-processor.cjs');
const { sanitize } = require('./ai-outbound-policy.cjs');

const LIMITS = Object.freeze({ ttl: 10 * 60 * 1000, contexts: 8, totalBytes: 4 * 1024 * 1024, sourceBytes: 512 * 1024 });
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const fail = message => Object.assign(new Error(message), { code: 'AI_HANDOFF' });
function field(value, maximum, optional = false) {
  if (optional && value == null) return '';
  if (typeof value !== 'string' || value.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw fail(tr('AI 上下文格式无效或超过大小限制。'));
  return value;
}
function contextReference(value) {
  if (value == null) return undefined;
  if (!value || Array.isArray(value) || Object.keys(value).some(key => !['caseId', 'turnId', 'historyId', 'casebookId', 'findingIndex'].includes(key))) throw fail(tr('AI 上下文引用无效。'));
  for (const key of ['caseId', 'turnId', 'historyId', 'casebookId']) if (value[key] !== undefined && !uuid.test(value[key])) throw fail(tr('AI 上下文引用无效。'));
  if (value.findingIndex !== undefined && (!Number.isInteger(value.findingIndex) || value.findingIndex < 0 || value.findingIndex >= 100)) throw fail(tr('AI 上下文引用无效。'));
  return { ...value };
}
function targetMetadata(values) {
  if (values == null) return undefined;
  if (!Array.isArray(values) || values.length > 10) throw fail(tr('AI 上下文引用无效。'));
  return values.map(value => {
    if (!value || typeof value.token !== 'string' || value.token.length > 160 || !value.token
      || !Number.isFinite(Date.parse(value.capturedAt)) || !Number.isFinite(Date.parse(value.expiresAt))) throw fail(tr('AI 上下文引用无效。'));
    return { token: value.token, label: sanitize(field(value.label, 240)), deviceId: field(value.deviceId, 160), capturedAt: value.capturedAt, expiresAt: value.expiresAt };
  });
}
function createHandoffBroker({ getOwner, freeze, publish, readReference, now = Date.now }) {
  const contexts = new Map(), watched = new WeakSet(), generations = new WeakMap(); let preparing = 0, lifecycle = 0;
  function watch(owner) {
    if (watched.has(owner)) return;
    watched.add(owner); generations.set(owner, 0);
    const discard = () => {
      generations.set(owner, (generations.get(owner) || 0) + 1);
      for (const [id, entry] of contexts) if (entry.owner === owner) contexts.delete(id);
    };
    owner.once?.('destroyed', discard);
    owner.on?.('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) discard(); });
  }
  function purge() {
    for (const [id, entry] of contexts) if (entry.expiresAt <= now() || entry.owner !== getOwner() || entry.owner.isDestroyed()) contexts.delete(id);
  }
  function metadata(entry) {
    const { entries: _entries, owner: _owner, generation: _generation, ...visible } = entry;
    return { ...visible, handoffId: entry.id, expiresAt: new Date(entry.expiresAt).toISOString(), contextRef: entry.contextRef ? { ...entry.contextRef } : undefined,
      taskTargets: entry.taskTargets?.map(target => ({ ...target })), provenance: { ...entry.provenance } };
  }
  async function create(input, trust, binding, foreground = false) {
    const owner = getOwner();
    if (!owner || owner.isDestroyed()) throw fail(tr('AI 工作区窗口不可用。'));
    watch(owner);
    const generation = generations.get(owner), initialLifecycle = lifecycle;
    const current = () => getOwner() === owner && !owner.isDestroyed() && generations.get(owner) === generation && lifecycle === initialLifecycle;
    purge();
    if (contexts.size + preparing >= LIMITS.contexts) throw fail(tr('AI 上下文暂存已满，请稍后重试。'));
    const origin = field(input?.origin, 40), title = field(input?.title, 240), question = field(input?.question, 4000, true);
    const text = field(input?.text, LIMITS.sourceBytes, true), deviceId = field(input?.deviceId, 160, true);
    if (Buffer.byteLength(text) > LIMITS.sourceBytes) throw fail(tr('AI 上下文超过 512 KiB，请缩小选段；未静默截断。'));
    const contextRef = trust === 'server-snapshot' ? contextReference(input.contextRef) : undefined;
    const taskTargets = trust === 'server-snapshot' ? targetMetadata(input.taskTargets) : undefined;
    if (!text.trim() && !taskTargets?.length) throw fail(tr('没有可带入 AI 工作区的上下文。'));
    const capturedAt = now(), provenance = { trust, origin, ...(binding ? { binding } : {}) };
    preparing++;
    try {
      const result = await freeze({ sources: [{ kind: origin.startsWith('log-') ? 'log' : origin, label: title,
        target: trust === 'server-snapshot' ? deviceId : '', deviceId: trust === 'server-snapshot' ? deviceId : '',
        text: text || taskTargets.map(target => target.label).join('\n'), capturedAt, provenance,
        truncated: input.truncated === true, timeBasis: trust === 'server-snapshot' && input.timeBasis || tr('冻结上下文；来源时钟与设备事实需按来源说明核对') }],
        selection: { maxLines: 2000, contextLines: 0 }, now: capturedAt }, { locale: getLocale() });
      if (!current()) throw fail(tr('AI 工作区窗口已变化，请重新带入上下文。'));
      purge();
      if (result.bytes > 1024 * 1024 || [...contexts.values()].reduce((sum, entry) => sum + entry.bytes, result.bytes) > LIMITS.totalBytes) throw fail(tr('AI 上下文暂存已满，请稍后重试。'));
      // Label/question redaction shares the worker, without promoting view metadata into device facts.
      const labels = await freeze({ sources: [{ kind: 'text', label: title, target: '', text: question || title, capturedAt, provenance }],
        selection: { maxLines: 2000, contextLines: 0 }, now: capturedAt }, { locale: getLocale() });
      if (!current()) throw fail(tr('AI 工作区窗口已变化，请重新带入上下文。'));
      const storedBytes = result.bytes + labels.bytes + Buffer.byteLength(JSON.stringify(taskTargets || [])) + 4096;
      if ([...contexts.values()].reduce((sum, entry) => sum + entry.bytes, storedBytes) > LIMITS.totalBytes) throw fail(tr('AI 上下文暂存已满，请稍后重试。'));
      const id = randomUUID();
      const entry = { id, owner, generation, origin, title: labels.entries[0].label,
        question: labels.entries[0].text.replace(/^\[L\d+\] /gm, ''), deviceId,
        ...(contextRef ? { contextRef } : {}), ...(taskTargets ? { taskTargets } : {}), entries: result.entries,
        provenance, createdAt: new Date(capturedAt).toISOString(), expiresAt: capturedAt + LIMITS.ttl,
        bytes: storedBytes, lineCount: result.entries.reduce((sum, item) => sum + item.lineCount, 0), truncated: result.truncated };
      contexts.set(id, entry); publish(owner, { handoffId: id }, { foreground });
      return { handoffId: id };
    } finally { preparing--; }
  }
  function resolve(id) {
    purge(); const entry = contexts.get(id);
    if (!uuid.test(String(id)) || !entry || entry.owner !== getOwner() || entry.generation !== generations.get(entry.owner)) throw fail(tr('AI 上下文已过期或来源窗口已变化，请重新带入。'));
    return entry;
  }
  return {
    createInternal: input => create(input, 'server-snapshot'),
    async createFromRenderer(args) {
      if (!args || Boolean(args.reference) === Boolean(args.view)) throw fail(tr('AI 上下文格式无效或超过大小限制。'));
      if (args.reference) {
        const shapes = { serial: ['kind', 'workspace', 'sessionId'], ssh: ['kind', 'sessionId', 'terminalId'], artifact: ['kind', 'artifactId', 'name'], 'task-run': ['kind', 'taskId'] };
        const reference = args.reference, keys = shapes[reference.kind];
        if (!keys || Object.keys(reference).length !== keys.length || keys.some(key => typeof reference[key] !== 'string' || !reference[key] || reference[key].length > (key === 'artifactId' ? 2048 : 512))) throw fail(tr('AI 上下文引用无效。'));
        return create(await readReference(reference), 'server-snapshot', createHash('sha256').update(JSON.stringify(reference)).digest('hex'), true);
      }
      const view = args.view;
      if (!view || Object.keys(view).some(key => !['origin', 'title', 'question', 'text', 'deviceId'].includes(key))
        || !['log-filter', 'log-marker', 'log-diagnostic', 'serial-selection', 'ssh-selection', 'device-error'].includes(view.origin)) throw fail(tr('AI 上下文格式无效或超过大小限制。'));
      return create(view, 'renderer-view', undefined, true);
    },
    get: id => metadata(resolve(id)),
    async resolveForWorkspace(id) {
      const entry = resolve(id);
      return { ...metadata(entry), entries: entry.entries.map(item => ({ ...item, provenance: { ...item.provenance },
        windowInfo: item.windowInfo ? { ...item.windowInfo } : undefined,
        originalLineNumbers: item.originalLineNumbers?.slice(), events: item.events?.map(event => ({ ...event })) })) };
    },
    cleanup: () => { lifecycle++; contexts.clear(); },
  };
}
function captureSerialRows(rows) {
  const parts = []; let bytes = 0, truncated = rows.length > 2000;
  for (let index = rows.length - 1; index >= 0 && parts.length < 2000; index--) {
    const row = rows[index], remaining = LIMITS.sourceBytes - bytes - 1;
    if (remaining <= 0) { truncated = true; break; }
    const part = boundedText(`[${row.time}] ${row.direction}: ${row.text || row.hex || ''}`, remaining);
    parts.push(part.text); bytes += Buffer.byteLength(part.text) + 1;
    if (part.truncated) { truncated = true; break; }
  }
  return { text: parts.reverse().join('\n'), truncated: truncated || parts.length < rows.length };
}
async function readReference(reference) {
  if (!reference || typeof reference !== 'object') throw fail(tr('AI 上下文引用无效。'));
  if (reference.kind === 'serial') {
    if (!['rs232', 'terminal'].includes(reference.workspace)) throw fail(tr('AI 上下文引用无效。'));
    const state = require('./serial.cjs').snapshots()[reference.workspace];
    if (!state?.sessionId || state.sessionId !== reference.sessionId) throw fail(tr('所选会话已变化，请重新选择上下文。'));
    return { origin: 'serial', title: `${tr('串口会话快照')} · ${reference.workspace === 'terminal' ? tr('串口终端') : tr('RS232调试')} · ${state.path || ''}`,
      timeBasis: tr('每行前缀为本机接收或发送时间，非设备事件时间'), question: tr('请分析这段已选择的串口上下文。'), deviceId: '',
      ...captureSerialRows((state.entries || []).filter(row => row.sessionId === state.sessionId)) };
  }
  if (reference.kind === 'ssh') {
    const ssh = require('./ssh.cjs');
    const source = ssh.getAnalysisSources().find(item => item.sessionId === reference.sessionId && item.terminalId === reference.terminalId);
    if (!source) throw fail(tr('所选会话已变化，请重新选择上下文。'));
    return { origin: 'ssh', title: `${tr('SSH 终端快照')} · ${source.name} · ${source.title}`.slice(0, 240),
      timeBasis: tr('终端缓冲快照；无可靠逐行时间，不可据此确定跨源先后顺序'), question: tr('请分析这段已选择的 SSH 上下文。'), deviceId: '', ...ssh.readAnalysisTerminal(source) };
  }
  if (reference.kind === 'artifact') return require('./artifact-center.cjs').readAnalysisArtifact(reference.artifactId, reference.name);
  if (reference.kind === 'task-run') return require('./task-center.cjs').getRunEvidence(reference.taskId);
  throw fail(tr('AI 上下文引用无效。'));
}
let broker;
function publishHandoff(ctx, owner, payload, { foreground = false } = {}) {
  const window = ctx.getMainWindow();
  if (!window || window.isDestroyed() || window.webContents !== owner) throw fail(tr('AI 工作区窗口不可用。'));
  owner.send('ai-handoff:available', payload);
  // Only the explicit contextual-entry IPC asks to foreground the destination.
  // Internal completion/progress producers never gain focus by publishing data.
  if (foreground) { if (window.isMinimized?.()) window.restore(); window.show(); window.focus(); }
}
function runtime() {
  if (!broker) {
    const ctx = require('./app-context.cjs');
    broker = createHandoffBroker({ getOwner: () => ctx.getMainWindow()?.webContents,
      freeze: (args, options) => runWorkspaceJob('freeze', args, options), readReference,
      publish: (owner, value, options) => publishHandoff(ctx, owner, value, options) });
  }
  return broker;
}
function register(ipcMain) {
  const ctx = require('./app-context.cjs');
  for (const method of ['create', 'get']) ipcMain.handle(`ai-handoff:${method}`, async (event, args) => {
    const windows = method === 'get' ? [ctx.getMainWindow()] : [ctx.getMainWindow(), ctx.getLogAnalyzerWindow()];
    const allowed = windows.some(window => window && !window.isDestroyed() && window.webContents === event.sender && event.senderFrame === window.webContents.mainFrame);
    if (!allowed) return { ok: false, code: 'AI_HANDOFF_OWNER', error: tr('仅允许在应用主窗口或日志窗口带入 AI 上下文。') };
    try { return method === 'get' ? { ok: true, handoff: runtime().get(args?.handoffId) } : { ok: true, ...await runtime().createFromRenderer(args) }; }
    catch (error) { return { ok: false, code: error.code, error: error.message }; }
  });
}
module.exports = { createHandoffBroker, publishHandoff, LIMITS, register, createInternal: input => runtime().createInternal(input),
  resolveForWorkspace: id => runtime().resolveForWorkspace(id), cleanup: () => broker?.cleanup() };
