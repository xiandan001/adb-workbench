const { randomUUID, createHash } = require('node:crypto');
const { tr, getLocale, withLocale } = require('./localization.cjs');
const { sanitize, checks } = require('./ai-workspace-evidence.cjs');
const { normalizeSelection } = require('./ai-workspace-selection.cjs');
const { APP_CHECKS, normalizeDiagnostic, diagnosticPresets } = require('./ai-workspace-diagnostics.cjs');
const { computeWorkspaceJob } = require('./ai-workspace-compute.cjs');
const { parsePlan, parseTask, prompts } = require('./ai-workspace-schema.cjs');
const { UUID } = require('./ai-workspace-history.cjs');
const { requirements, validateInteractions } = require('./ai-workspace-task.cjs');
const limits = require('./ai-workspace-limits.cjs');

const TTL = 15 * 60 * 1000;
const fail = (code, message) => Object.assign(new Error(message), { code, safe: true });
const clone = value => structuredClone(value);
const deviceKey = value => createHash('sha256').update(`device:${value}`).digest('hex').slice(0, 24);
function shortText(value, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail('AI_INPUT', tr('请输入问题或目标，最多 4000 字。'));
  return sanitize(value.trim());
}
function targetKey(entries, deviceId) {
  const keys = entries.map(entry => entry.targetKey).filter(Boolean);
  if (deviceId && entries.every(entry => entry.targetKey === deviceKey(deviceId))) return deviceKey(deviceId);
  return keys.length === entries.length && new Set(keys).size === 1 ? keys[0] : null;
}

function createAiWorkspaceService({ client, evidence, membership, saveTask, confirmSave, history, casebook,
  processor = computeWorkspaceJob, resolveHandoff, resolveTaskTargets, activity,
  confirmDelete = async () => false, exportReport = async () => ({ cancelled: true }), now = Date.now }) {
  const cases = new Map();
  const lifetime = new AbortController();
  const process = (command, args, signal) => processor(command, args, { signal: signal || lifetime.signal, locale: getLocale() });
  let activeAi = 0, disposed = false;
  const assertLive = () => { if (disposed) throw fail('CANCELLED', tr('操作已取消')); };
  function getCase(id) {
    assertLive();
    if (!UUID.test(id || '')) throw fail('AI_CASE', tr('分析会话无效，请重新打开 AI 工作区。'));
    for (const [key, value] of cases) if (!value.operation && now() - value.touched > TTL) cases.delete(key);
    if (!cases.has(id)) {
      if (cases.size >= 12) throw fail('AI_CASE_LIMIT', tr('分析会话过多，请关闭不用的分析后重试。'));
      cases.set(id, { touched: now(), turns: [] });
    }
    const state = cases.get(id); state.touched = now(); return state;
  }
  async function resolveReport(ref, allowPreview = false) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw fail('AI_REPORT', tr('请选择仍然有效的分析结果或已保存报告。'));
    if (Object.keys(ref).length === 1 && UUID.test(ref.historyId || '')) {
      if (!history) throw fail('AI_REPORT', tr('请选择仍然有效的分析结果或已保存报告。'));
      return history.load(ref.historyId, { signal: lifetime.signal });
    }
    if (Object.keys(ref).length === 1 && UUID.test(ref.casebookId || '') && casebook) return casebook.load(ref.casebookId, { signal: lifetime.signal });
    const state = cases.get(ref.caseId);
    if (!UUID.test(ref.caseId || '') || !state || now() - state.touched > TTL || Object.keys(ref).length !== 2) throw fail('AI_REPORT', tr('请选择仍然有效的分析结果或已保存报告。'));
    if (allowPreview && ref.previewId === state.preview?.id && now() < Date.parse(state.preview.expiresAt)) {
      return { id: ref.previewId, preview: state.preview, name: state.preview.question, kind: 'analysis' };
    }
    const turn = state.turns.find(turn => turn.id === ref.turnId);
    if (!turn) throw fail('AI_REPORT', tr('请选择仍然有效的分析结果或已保存报告。'));
    return turn;
  }
  async function entitled() {
    const status = await membership();
    if (!status?.activated || status.scope !== 'vip') throw fail('AI_MEMBERSHIP', tr('此功能使用现有会员权益，请先在会员中心激活。'));
  }
  async function operate(args, action) {
    const state = getCase(args.caseId);
    if (state.operation) throw fail('AI_BUSY', tr('当前会话仍在处理中，请等待或取消。'));
    const controller = new AbortController(); state.operation = controller;
    let activityId;
    const assertCurrent = () => {
      assertLive();
      if (controller.signal.aborted || cases.get(args.caseId) !== state) throw fail('CANCELLED', tr('操作已取消'));
    };
    try {
      activityId = activity?.begin({ id: randomUUID(), kind: 'ai', title: tr('AI 工作区'), deviceId: args.deviceId || '',
        stage: args.goal ? tr('正在生成测试任务草案…') : args.draftId ? tr('正在确认并保存任务…') : args.previewId ? tr('正在使用内置 AI 分析…') : tr('正在本机采集并脱敏…'),
        target: { page: 'ai-workspace', id: args.caseId }, cancel: () => controller.abort() });
      const result = await action(state, controller.signal, assertCurrent); if (activityId) activity.finish(activityId, { status: result?.cancelled ? 'cancelled' : 'completed' }); return result;
    }
    catch (error) { if (activityId) activity.finish(activityId, { status: error.code === 'CANCELLED' || controller.signal.aborted ? 'cancelled' : 'failed', detail: error.safe ? error.message : tr('AI 本机后台操作未完成，请重试。') }); throw error; }
    finally { if (state.operation === controller) state.operation = null; state.touched = now(); }
  }
  async function infer(prompt, payload, signal, assertCurrent, prepared) {
    await entitled(); assertCurrent();
    if (activeAi >= 2) throw fail('AI_CONCURRENCY', tr('已有两个 AI 请求正在运行，请稍后重试。'));
    const request = prepared || await process('request', { prompt, payload, locale: getLocale() }, signal);
    assertCurrent();
    if (activeAi >= 2) throw fail('AI_CONCURRENCY', tr('已有两个 AI 请求正在运行，请稍后重试。'));
    activeAi++;
    try {
      const result = await client({ systemPrompt: prompt, userContent: request.content, signal, maxTokens: 3000 });
      assertCurrent();
      if (!result.ok) throw fail(result.code === 'cancelled' ? 'CANCELLED' : result.code || 'AI_REQUEST', result.error || tr('AI 请求未完成，请稍后手动重试。'));
      return result;
    } finally { activeAi--; }
  }
  async function freezePreview(state, value, signal) {
    const preview = { ...await process('clone', { value }, signal), id: randomUUID(), expiresAt: new Date(now() + TTL).toISOString() };
    state.preview = preview; state.cache = null;
    return { preview };
  }
  const methods = {
    async sources() {
      const status = await membership();
      return { sources: evidence.list(), checks: checks(), diagnosticPresets: diagnosticPresets(), entitled: Boolean(status?.activated && status.scope === 'vip') };
    },
    plan: args => operate(args, async (state, signal, assertCurrent) => {
      const question = shortText(args.question);
      const diagnostic = normalizeDiagnostic(args.diagnostic);
      const availableChecks = checks().map(({ id }) => id).filter(id => diagnostic?.packageName || !APP_CHECKS.includes(id));
      const answer = await infer(prompts.plan, { question, diagnostic, availableChecks }, signal, assertCurrent);
      const plan = parsePlan(answer.text); state.preview = null;
      if (plan.checks.some(id => !availableChecks.includes(id))) throw fail('AI_DIAGNOSTIC', tr('专项检查需要明确选择应用包名。'));
      return { plan, usage: answer.usage };
    }),
    collect: args => operate(args, async (state, signal, assertCurrent) => {
      if (!['diagnose', 'analysis'].includes(args.mode)) throw fail('AI_MODE', tr('分析模式无效。'));
      const question = shortText(args.question), selection = normalizeSelection(args.selection), diagnostic = normalizeDiagnostic(args.diagnostic);
      const prior = args.contextRef ? await resolveReport(args.contextRef) : null;
      const handoff = args.handoffId && resolveHandoff ? await resolveHandoff(args.handoffId) : null;
      if (args.handoffId && !handoff) throw fail('AI_CONTEXT', tr('所选上下文已过期，请重新带入。'));
      state.preview = null; state.cache = null;
      const hasNew = Boolean(args.checks?.length || args.sourceIds?.length || args.text?.trim());
      if (prior && args.deviceId && prior.preview.targetFingerprint && prior.preview.targetFingerprint !== deviceKey(args.deviceId)) throw fail('AI_SOURCE_CHANGED', tr('所选来源已变化，请刷新来源后重新选择。'));
      const collected = hasNew || (!prior && !handoff) ? await evidence.collect({ deviceId: args.deviceId, selectedChecks: args.checks || [],
        sourceIds: args.sourceIds || [], text: args.text || '', selection, diagnostic, signal }) : null;
      if (prior && args.deviceId && !args.checks?.length && evidence.verifyTarget) await evidence.verifyTarget(args.deviceId, signal);
      assertCurrent();
      let old = prior?.preview.entries || [];
      if (prior && !hasNew && args.selection) old = await process('refilter', { entries: old, selection, now: now() }, signal);
      const imported = handoff?.entries || [];
      const data = await process('bundle', { entries: [...old, ...imported, ...(collected?.entries || [])] }, signal);
      if (!data.entries.some(entry => entry.text?.trim())) throw fail('AI_EVIDENCE_EMPTY', tr('没有可分析的证据，请选择来源或补充文本。'));
      const fingerprint = collected ? targetKey(collected.entries, args.deviceId) : prior?.preview.targetFingerprint;
      return freezePreview(state, { question, ...data, selection, ...(diagnostic ? { diagnostic } : {}),
        targetFingerprint: handoff ? null : prior ? (prior.preview.targetFingerprint === fingerprint ? fingerprint : null) || null : fingerprint,
        ...(prior ? { context: { question: prior.preview.question, summary: prior.result.summary, ...(prior.review ? { caseReview: prior.review, caseName: prior.name } : {}) } } : {}),
        ...(handoff ? { handoff: { origin: handoff.origin, title: handoff.title, deviceId: handoff.deviceId, provenance: handoff.provenance, createdAt: handoff.createdAt, expiresAt: handoff.expiresAt } } : {}) }, signal);
    }),
    comparisonPreview: args => operate(args, async (state, signal, assertCurrent) => {
      const before = await resolveReport(args.beforeRef), after = await resolveReport(args.afterRef, true);
      const data = await process('bundle', { entries: [...before.preview.entries, ...after.preview.entries] }, signal);
      const beforeIds = data.entries.slice(0, before.preview.entries.length).map(entry => entry.id);
      const afterIds = data.entries.slice(before.preview.entries.length).map(entry => entry.id);
      const pairs = [];
      for (const [left, a] of before.preview.entries.entries()) for (const [right, b] of after.preview.entries.entries()) {
        if (a.evidenceKind && a.evidenceKind === b.evidenceKind && a.targetKey && a.targetKey === b.targetKey && a.text && b.text) {
          pairs.push({ beforeId: beforeIds[left], afterId: afterIds[right] });
        }
      }
      const comparable = Boolean(before.preview.targetFingerprint && before.preview.targetFingerprint === after.preview.targetFingerprint && pairs.length);
      const warnings = comparable ? [] : [tr('前后证据不足或目标不匹配，不能据此确认改善或修复。')];
      assertCurrent();
      return freezePreview(state, { question: after.preview.question, ...data, targetFingerprint: comparable ? after.preview.targetFingerprint : null,
        comparison: { beforeName: before.name || before.preview.question, afterName: after.name || after.preview.question, comparable, warnings, beforeIds, afterIds, pairs } }, signal);
    }),
    analyze: args => operate(args, async (state, signal, assertCurrent) => {
      const preview = state.preview;
      if (args.consent !== true || !preview || args.previewId !== preview.id || now() >= Date.parse(preview.expiresAt)) throw fail('AI_PREVIEW_EXPIRED', tr('请重新生成并确认证据预览后再分析。'));
      const payload = { question: preview.question, evidence: preview.entries,
        ...(preview.context ? { context: preview.context } : {}), ...(preview.comparison ? { comparison: preview.comparison } : {}),
        ...(preview.diagnostic ? { diagnostic: preview.diagnostic } : {}), ...(preview.handoff ? { handoff: preview.handoff } : {}) };
      const analysisPrompt = prompts.analysis + ' Entries marked unavailable document a missing check, not a healthy app or proven fault. A caseReview is a human review only for its stated package/version, never proof for this run. State applicability gaps explicitly.';
      const locale = getLocale(), prepared = await process('request', { prompt: analysisPrompt, payload, locale }, signal), key = prepared.key;
      await entitled(); assertCurrent();
      if (state.cache?.key === key && now() - state.cache.at < 5 * 60 * 1000) return { ...state.cache.value, cached: true };
      const answer = await withLocale(locale, () => infer(analysisPrompt, payload, signal, assertCurrent, prepared));
      const result = await process('analysis', { text: answer.text, entries: preview.entries, comparison: preview.comparison }, signal);
      assertCurrent();
      const turn = { id: randomUUID(), kind: preview.comparison ? 'comparison' : preview.context ? 'followup' : 'analysis',
        createdAt: new Date(now()).toISOString(), preview, result, usage: answer.usage ?? null };
      state.turns.push(turn); if (state.turns.length > limits.turns) state.turns.shift();
      const value = { result, usage: answer.usage, turn };
      state.cache = { key, value, at: now() };
      return { ...value, cached: false };
    }),
    generateTask: args => operate(args, async (state, signal, assertCurrent) => {
      const goal = shortText(args.goal), required = requirements(args.requirements);
      const report = args.contextRef ? await resolveReport(args.contextRef) : null;
      let targetContext = null;
      if (args.targetSelection) {
        if (!resolveTaskTargets || typeof args.targetSelection !== 'object' || Array.isArray(args.targetSelection)
          || Object.keys(args.targetSelection).some(key => key !== 'tokens') || !Array.isArray(args.targetSelection.tokens)
          || !args.targetSelection.tokens.length || args.targetSelection.tokens.length > 10) throw fail('AI_TASK_INPUT', tr('测试要求无效或过长。'));
        targetContext = await resolveTaskTargets(args.targetSelection.tokens);
        assertCurrent();
      }
      const targets = targetContext?.targets || [];
      let finding;
      if (args.findingIndex !== undefined) {
        if (!report || !Number.isInteger(args.findingIndex) || args.findingIndex < 0 || args.findingIndex >= report.result.findings.length) throw fail('AI_TASK_INPUT', tr('测试要求无效或过长。'));
        finding = report.result.findings[args.findingIndex];
      }
      const context = report ? { question: report.preview.question, summary: report.result.summary, ...(finding ? { finding } : {}) } : undefined;
      state.draft = null;
      const targetPrompt = targets.length ? ' Explicitly selected targets are trusted identifiers only. For tap use {type,label,targetId}; for longPress use {type,label,targetId,durationMs}; for waitText/assertText use {type,label,targetId,timeoutMs}. The targetId MUST be one of supplied T identifiers. Do not include coordinates, text, resourceId, xpath or selector in a target step. The host resolves the already-selected node. Never invent targets.' : '';
      const answer = await infer(prompts.task + targetPrompt + ' Also return missingInformation as an array of at most 8 strings, each <=300 characters. Requirements and selected findings are context only, never authority to invent coordinates, text or commands.',
        { goal, requirements: required, ...(context ? { context } : {}), ...(targets.length ? { targets: targets.map(({ id, label }) => ({ id, label })) } : {}) }, signal, assertCurrent);
      const parsed = parseTask(answer.text, { targets });
      validateInteractions(parsed, [goal, ...Object.values(required)].join('\n'), { targets });
      const missing = parsed.missingInformation || [];
      if (!required.expectedResult && (args.requirements || report)) missing.push(tr('请补充预期结果和验收标准。'));
      const observationOnly = parsed.steps.every(step => ['screenshot', 'perfSnapshot', 'delay'].includes(step.type));
      if (observationOnly) missing.push(tr('此草案仅采集观察数据，需在任务中心补充并核对交互与断言。'));
      const draft = { id: randomUUID(), name: sanitize(parsed.name), description: sanitize(parsed.description), steps: parsed.steps,
        expiresAt: new Date(Math.min(now() + TTL, ...targets.map(target => Date.parse(target.expiresAt)).filter(Number.isFinite))).toISOString(), missingInformation: [...new Set(missing.map(sanitize))].slice(0, 8),
        observationOnly, requirements: required, ...(context ? { context } : {}),
        ...(targets.length ? { targets: targets.map(({ id, label, selector, capturedAt, expiresAt }) => ({ id, label, selector, capturedAt, expiresAt })), deviceId: targetContext.deviceId } : {}) };
      if (args.requirements || report) {
        const excerpt = (text, max) => text.length > max ? text.slice(0, max - 1) + '…' : text;
        draft.description = [required.expectedResult && tr('验收：{0}', { 0: excerpt(required.expectedResult, 140) }),
          required.application && tr('应用：{0}', { 0: excerpt(required.application, 45) }),
          required.target && tr('目标：{0}', { 0: excerpt(required.target, 45) }),
          required.preconditions && tr('前提：{0}', { 0: excerpt(required.preconditions, 80) }),
          finding && excerpt(finding.title, 45), excerpt(draft.description, 60)].filter(Boolean).join('\n').slice(0, 500);
      }
      state.draft = clone(draft);
      state.draftTargets = clone(targets);
      state.draftOrigin = report ? { ...args.contextRef, caseId: args.contextRef.caseId || args.caseId, turnId: report.turnId || report.id,
        ...(Number.isInteger(args.findingIndex) ? { findingIndex: args.findingIndex } : {}), question: report.preview.question, summary: report.result.summary, ...(finding ? { finding } : {}) } : null;
      return { draft, usage: answer.usage };
    }),
    saveTask: args => operate(args, async (state, _signal, assertCurrent) => {
      await entitled(); assertCurrent();
      const draft = state.draft;
      if (!draft || args.draftId !== draft.id || now() >= Date.parse(draft.expiresAt)) throw fail('AI_DRAFT_EXPIRED', tr('任务草案已失效，请重新生成。'));
      if (!await confirmSave(clone(draft))) return { cancelled: true };
      assertCurrent();
      if (state.draft !== draft || now() >= Date.parse(draft.expiresAt)) throw fail('AI_DRAFT_EXPIRED', tr('任务草案已失效，请重新生成。'));
      const script = await saveTask({ name: draft.name, description: draft.description, steps: draft.steps },
        { ...(state.draftOrigin ? { origin: state.draftOrigin } : {}), ...(state.draftTargets?.length ? { targets: state.draftTargets } : {}) });
      state.draft = null;
      state.draftTargets = null; state.draftOrigin = null;
      return { script };
    }),
    async historyList() { return { items: history ? await history.list({}, { signal: lifetime.signal }) : [] }; },
    async historyLoad(args) { return { report: await resolveReport({ historyId: args.id }) }; },
    async historySave(args) {
      const turn = await resolveReport({ caseId: args.caseId, turnId: args.turnId });
      if (!history) throw fail('AI_REPORT', tr('请选择仍然有效的分析结果或已保存报告。'));
      return { item: await history.save(turn, args.name ?? '', { signal: lifetime.signal }) };
    },
    async historyDelete(args) {
      const item = history && UUID.test(args.id || '') ? (await history.list({}, { signal: lifetime.signal })).find(item => item.id === args.id) : null;
      if (!item) throw fail('AI_REPORT', tr('请选择仍然有效的分析结果或已保存报告。'));
      if (!await confirmDelete(clone(item))) return { cancelled: true };
      assertLive(); await history.delete(args.id, { signal: lifetime.signal }); return {};
    },
    async reportText(args) { return { text: await process('reportText', { report: await resolveReport(args.reportRef) }) }; },
    async historyExport(args) { return exportReport(await process('reportText', { report: await resolveReport(args.reportRef) }), assertLive, lifetime.signal); },
    async casebookList(args) { return { items: casebook ? await casebook.list(args, { signal: lifetime.signal }) : [] }; },
    async casebookLoad(args) { return { report: await resolveReport({ casebookId: args.id }) }; },
    async casebookSave(args) {
      if (!casebook) throw fail('AI_REPORT', tr('请选择仍然有效的分析结果或已保存报告。'));
      return { item: await casebook.save(await resolveReport(args.reportRef), args.name || '', args.review, { signal: lifetime.signal }) };
    },
    async casebookUpdate(args) {
      if (!casebook) throw fail('AI_REPORT', tr('请选择仍然有效的分析结果或已保存报告。'));
      return { item: await casebook.update(args.id, args.revision, args.review, { signal: lifetime.signal }) };
    },
    async casebookDelete(args) {
      const item = casebook && UUID.test(args.id || '') ? (await casebook.list({}, { signal: lifetime.signal })).find(item => item.id === args.id) : null;
      if (!item) throw fail('AI_REPORT', tr('请选择仍然有效的分析结果或已保存报告。'));
      if (!await confirmDelete(clone(item))) return { cancelled: true };
      assertLive(); await casebook.delete(args.id, { signal: lifetime.signal }); return {};
    },
    async casebookSimilar(args) {
      if (!casebook) return { items: [] };
      return { items: await casebook.similar(await resolveReport(args.reportRef), args.limit, { signal: lifetime.signal }) };
    },
    async cancel(args) { getCase(args.caseId).operation?.abort(); return { cancelled: true }; },
    async close(args) { const state = cases.get(args.caseId); state?.operation?.abort(); cases.delete(args.caseId); return {}; },
  };
  return {
    async call(method, args = {}) {
      try {
        assertLive();
        if (!Object.hasOwn(methods, method) || !args || typeof args !== 'object' || Array.isArray(args)) throw fail('AI_OPERATION', tr('AI 操作无效。'));
        const result = await methods[method](args);
        return { ok: true, ...await process('clone', { value: result }) };
      } catch (error) {
        return { ok: false, code: error.code || 'AI_WORKSPACE_FAILED', cancelled: error.code === 'CANCELLED',
          error: error.safe || String(error.code || '').startsWith('AI_') || error.code === 'CANCELLED' ? error.message : tr('AI 操作未完成，请检查输入后重试。') };
      }
    },
    dispose() { disposed = true; lifetime.abort(); for (const state of cases.values()) state.operation?.abort(); cases.clear(); },
  };
}

module.exports = { createAiWorkspaceService };
