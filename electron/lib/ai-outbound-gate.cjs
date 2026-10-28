const { randomUUID } = require('node:crypto');
const { tr } = require('./localization.cjs');
const { LIMITS, fail } = require('./ai-outbound-policy.cjs');

const cancelled = () => Object.assign(fail('AI_SEND_CANCELLED', tr('AI 发送已取消。')), { name: 'AbortError', cancelled: true });
function createOutboundGate({ prepare, membership, publish = () => {}, activity = {}, now = Date.now } = {}) {
  const operations = new Map(), previews = new Map();
  let closed = false;
  const live = owner => owner && !owner.isDestroyed();
  function notice(owner) { if (live(owner)) { try { publish(owner); } catch { /* Closed windows never authorize sends. */ } } }
  function usage(operation) {
    return { actual: { ...operation.actual }, observedRequests: operation.observed, sentRequests: operation.sent,
      estimatedInputTokens: operation.estimated, complete: operation.sent > 0 && operation.observed === operation.sent };
  }
  function publicOperation(operation) {
    return { id: operation.id, kind: operation.kind, title: operation.title, stage: operation.stage, status: operation.status,
      startedAt: operation.startedAt, endedAt: operation.endedAt, usage: usage(operation) };
  }
  function maybeFinish(operation) {
    if (operation.status !== 'running' || !operation.producerDone || operation.tasks.size) return;
    operation.status = operation.controller.signal.aborted ? 'cancelled' : operation.failed ? 'failed' : 'completed';
    operation.endedAt = now();
    activity.finish?.(operation.id, { status: operation.status, detail: operation.error || tr('AI 请求已结束。') });
    const terminal = [...operations.values()].filter(item => item.status !== 'running').sort((a, b) => b.endedAt - a.endedAt);
    for (const item of terminal.slice(12)) operations.delete(item.id);
    notice(operation.owner);
  }
  function begin(owner, { title = tr('AI 日志分析'), kind = 'analysis', deviceId = '', locale, contentFormat } = {}) {
    if (closed) throw cancelled();
    if (!live(owner)) throw fail('AI_SEND_OWNER', tr('AI 发送窗口已关闭，未发送。'));
    if ([...operations.values()].filter(item => item.status === 'running').length >= 16) throw fail('AI_SEND_QUEUE', tr('待处理 AI 请求过多，请先取消或完成现有请求。'));
    const operation = { id: randomUUID(), owner, title, kind, locale, contentFormat: contentFormat === 'workspace-json' ? contentFormat : undefined, startedAt: now(), status: 'running', stage: tr('准备发送预览'),
      controller: new AbortController(), tasks: new Set(), batches: new Set(), producerDone: false, failed: false,
      actual: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, observed: 0, sent: 0, estimated: 0 };
    activity.begin?.({ id: operation.id, kind: 'ai', title, deviceId, target: { page: kind === 'summary' ? 'ai-workspace' : 'logs' }, cancel: () => cancel(operation) });
    operations.set(operation.id, operation);
    notice(owner);
    return operation;
  }
  function batch(operation, title, concurrency = 3) {
    if (operation.controller.signal.aborted || operation.status !== 'running') throw cancelled();
    const value = { id: randomUUID(), operation, title: title || operation.title, concurrency: Math.min(3, Math.max(1, concurrency)), tasks: [], sealed: false, active: 0, cursor: 0, state: 'preparing' };
    operation.batches.add(value);
    return value;
  }
  function settle(task, error, value) {
    if (task.done) return; task.done = true;
    task.batch.operation.tasks.delete(task);
    if (error) task.reject(error); else task.resolve(value);
    maybeFinish(task.batch.operation);
  }
  function rejectBatch(value, error) {
    if (value.state === 'rejected' || value.state === 'completed') return;
    value.state = 'rejected'; clearTimeout(value.timer); previews.delete(value.id);
    value.operation.failed = error.code !== 'AI_SEND_CANCELLED';
    value.operation.error = error.message;
    for (const task of value.tasks) if (!task.started) { task.body = null; task.prepared = null; settle(task, error); }
    value.prepared = null; value.operation.batches.delete(value);
    notice(value.operation.owner);
  }
  function drain(value) {
    const operation = value.operation;
    if (value.state !== 'authorized' || operation.controller.signal.aborted) return;
    while (value.active < value.concurrency && value.cursor < value.tasks.length) {
      const task = value.tasks[value.cursor++];
      if (task.done) continue;
      task.started = true; value.active++; operation.sent++;
      operation.stage = tr('正在发送已确认的 AI 请求');
      activity.update?.(operation.id, { stage: operation.stage }); notice(operation.owner);
      Promise.resolve().then(() => {
        if (!live(operation.owner) || operation.controller.signal.aborted) throw cancelled();
        return task.run(task.prepared.body, operation.controller.signal);
      }).then(result => {
        if (result?.usage) {
          operation.observed++;
          for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) operation.actual[key] += result.usage[key];
        }
        if (result?.ok === false) operation.failed = true;
        settle(task, null, result);
      }, error => {
        operation.failed = error.name !== 'AbortError'; operation.error = error.message;
        settle(task, error);
      }).finally(() => {
        value.active--;
        if (value.tasks.every(task => task.done)) { value.state = 'completed'; operation.batches.delete(value); }
        drain(value); maybeFinish(operation); notice(operation.owner);
      });
    }
  }
  async function seal(value) {
    if (value.sealed || value.state === 'rejected') return; value.sealed = true;
    const operation = value.operation;
    try {
      if (operation.controller.signal.aborted || !live(operation.owner)) throw cancelled();
      if (previews.size >= LIMITS.pendingBatches) throw fail('AI_SEND_QUEUE', tr('待处理 AI 请求过多，请先取消或完成现有请求。'));
      previews.set(value.id, value);
      const prepared = await prepare(value.tasks.map(task => task.body), { locale: operation.locale, signal: operation.controller.signal, contentFormat: operation.contentFormat });
      if (operation.controller.signal.aborted || !live(operation.owner)) throw cancelled();
      value.prepared = prepared;
      value.tasks.forEach((task, index) => { task.prepared = prepared.requests[index]; task.body = null; });
      operation.estimated += prepared.estimatedInputTokens;
      value.state = 'waiting'; value.expiresAt = now() + LIMITS.previewMs;
      operation.stage = tr('等待确认 AI 发送预览');
      value.timer = setTimeout(() => rejectBatch(value, fail('AI_SEND_EXPIRED', tr('AI 发送预览已过期，请重新准备。'))), LIMITS.previewMs);
      value.timer.unref?.();
      activity.update?.(operation.id, { stage: operation.stage }); notice(operation.owner);
    } catch (error) { rejectBatch(value, error); }
  }
  function submit(operation, selectedBatch, body, run) {
    if (operations.get(operation?.id) !== operation || operation.status !== 'running' || operation.controller.signal.aborted) return Promise.reject(cancelled());
    const value = selectedBatch || batch(operation);
    if (value.operation !== operation || value.sealed || value.state !== 'preparing') return Promise.reject(fail('AI_SEND_CHANGED', tr('AI 请求批次已冻结，新增内容需要新的预览。')));
    if (typeof body !== 'string' || Buffer.byteLength(body) > LIMITS.requestBytes || value.tasks.length >= LIMITS.requests
      || value.tasks.reduce((bytes, task) => bytes + Buffer.byteLength(task.body || ''), Buffer.byteLength(body)) > LIMITS.batchBytes) {
      const error = fail('AI_SEND_LIMIT', tr('AI 批次最多 16 个请求、8 MiB，请缩小筛选范围；未发送。'));
      rejectBatch(value, error); operation.failed = true; operation.error = error.message;
      return Promise.reject(error);
    }
    const promise = new Promise((resolve, reject) => {
      const task = { body, run, resolve, reject, batch: value, done: false, started: false };
      value.tasks.push(task); operation.tasks.add(task);
    });
    if (!value.scheduled) { value.scheduled = true; queueMicrotask(() => void seal(value)); }
    return promise;
  }
  function owned(owner, previewId) {
    const value = previews.get(previewId);
    if (!value || value.operation.owner !== owner || !live(owner) || value.state !== 'waiting' || now() >= value.expiresAt) {
      throw fail('AI_SEND_EXPIRED', tr('AI 发送预览已过期，请重新准备。'));
    }
    return value;
  }
  function metadata(value) {
    return { id: value.id, operationId: value.operation.id, title: value.title, expiresAt: value.expiresAt,
      requestCount: value.prepared.requests.length, bytes: value.prepared.bytes, redactions: value.prepared.redactions,
      estimatedInputTokens: value.prepared.estimatedInputTokens };
  }
  function list(owner) {
    return { pending: [...previews.values()].filter(value => value.operation.owner === owner && value.state === 'waiting').map(metadata),
      operations: [...operations.values()].filter(operation => operation.owner === owner).map(publicOperation).slice(-12) };
  }
  function get(owner, { previewId, index = 0 } = {}) {
    const value = owned(owner, previewId);
    if (!Number.isInteger(index) || index < 0 || index >= value.prepared.requests.length) throw fail('AI_SEND_INPUT', tr('AI 请求内容无效，未发送。'));
    const request = value.prepared.requests[index];
    value.viewed ||= new Set(); value.viewed.add(index);
    return { ...metadata(value), selectedRequest: { index, messages: request.messages.map(message => ({ ...message })),
      parameters: { ...request.parameters }, digest: request.digest, bytes: request.bytes, redactions: request.redactions,
      estimatedInputTokens: request.estimatedInputTokens } };
  }
  async function decide(owner, { previewId, decision } = {}) {
    const value = owned(owner, previewId);
    if (decision === 'cancel') { cancel(value.operation); return { ok: true, cancelled: true }; }
    if (decision !== 'send') throw fail('AI_SEND_CONSENT', tr('请明确确认完整发送预览。'));
    if (value.viewed?.size !== value.prepared.requests.length) throw fail('AI_SEND_CONSENT', tr('请明确确认完整发送预览。'));
    value.state = 'deciding';
    try {
      const entitled = await membership();
      if (!entitled?.activated || entitled.scope !== 'vip') throw fail('AI_SEND_VIP', tr('AI 分析需要有效会员授权。'));
      if (value.operation.controller.signal.aborted || !live(owner) || now() >= value.expiresAt) throw cancelled();
      value.state = 'authorized'; previews.delete(value.id); clearTimeout(value.timer);
      drain(value); notice(owner); return { ok: true, operationId: value.operation.id };
    } catch (error) { rejectBatch(value, error); return { ok: false, code: error.code, error: error.message }; }
  }
  function cancel(operation) {
    if (!operation || operation.status !== 'running') return { ok: true };
    operation.controller.abort(); operation.producerDone = true;
    for (const value of operation.batches) rejectBatch(value, cancelled());
    for (const task of [...operation.tasks]) settle(task, cancelled());
    maybeFinish(operation); notice(operation.owner); return { ok: true };
  }
  function finishProducer(operation, failed = false) { operation.producerDone = true; operation.failed ||= failed; maybeFinish(operation); }
  return { begin, batch, submit, list, get, decide, cancel, finishProducer,
    cancelOwned(owner, kinds) { for (const operation of operations.values()) if (operation.owner === owner && (!kinds || kinds.includes(operation.kind))) cancel(operation); },
    discardOwner(owner) { for (const operation of operations.values()) if (operation.owner === owner) { cancel(operation); operations.delete(operation.id); } },
    cleanup() { closed = true; for (const operation of operations.values()) cancel(operation); operations.clear(); previews.clear(); } };
}
module.exports = { createOutboundGate, cancelled };
