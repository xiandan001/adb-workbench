const { randomUUID, createHash } = require('node:crypto');
const { tr, getLocale, withLocale } = require('./localization.cjs');
const { sanitize, checks } = require('./ai-workspace-evidence.cjs');
const { parsePlan, parseAnalysis, parseTask, prompts } = require('./ai-workspace-schema.cjs');

const TTL = 15 * 60 * 1000;
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const fail = (code, message) => Object.assign(new Error(message), { code, safe: true });
function shortText(value, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail('AI_INPUT', tr('请输入问题或目标，最多 4000 字。'));
  return sanitize(value.trim());
}

function createAiWorkspaceService({ client, evidence, membership, saveTask, confirmSave, now = Date.now }) {
  const cases = new Map();
  let activeAi = 0;
  function getCase(id) {
    if (!UUID.test(id || '')) throw fail('AI_CASE', tr('分析会话无效，请重新打开 AI 工作区。'));
    for (const [key, value] of cases) if (!value.operation && now() - value.touched > TTL) cases.delete(key);
    if (!cases.has(id)) {
      if (cases.size >= 12) throw fail('AI_CASE_LIMIT', tr('分析会话过多，请关闭不用的分析后重试。'));
      cases.set(id, { touched: now() });
    }
    const state = cases.get(id); state.touched = now(); return state;
  }
  async function entitled() {
    const status = await membership();
    if (!status?.activated || status.scope !== 'vip') throw fail('AI_MEMBERSHIP', tr('此功能使用现有会员权益，请先在会员中心激活。'));
  }
  async function operate(args, action) {
    const state = getCase(args.caseId);
    if (state.operation) throw fail('AI_BUSY', tr('当前会话仍在处理中，请等待或取消。'));
    const controller = new AbortController(); state.operation = controller;
    const assertCurrent = () => {
      if (controller.signal.aborted || cases.get(args.caseId) !== state) throw fail('CANCELLED', tr('操作已取消'));
    };
    try { return await action(state, controller.signal, assertCurrent); }
    finally { if (state.operation === controller) state.operation = null; state.touched = now(); }
  }
  async function infer(prompt, payload, signal, assertCurrent) {
    await entitled(); assertCurrent();
    if (activeAi >= 2) throw fail('AI_CONCURRENCY', tr('已有两个 AI 请求正在运行，请稍后重试。'));
    activeAi++;
    try {
      const result = await client({ systemPrompt: prompt, userContent: JSON.stringify(payload), signal, maxTokens: 3000 });
      assertCurrent();
      if (!result.ok) throw fail(result.code || 'AI_REQUEST', result.error || tr('AI 请求未完成，请稍后手动重试。'));
      return result;
    } finally { activeAi--; }
  }
  const methods = {
    async sources() {
      const status = await membership();
      return { sources: evidence.list(), checks: checks(), entitled: Boolean(status?.activated && status.scope === 'vip') };
    },
    plan: args => operate(args, async (state, signal, assertCurrent) => {
      const question = shortText(args.question);
      const answer = await infer(prompts.plan, { question, availableChecks: checks().map(({ id }) => id) }, signal, assertCurrent);
      const plan = parsePlan(answer.text);
      state.preview = null;
      return { plan, usage: answer.usage };
    }),
    collect: args => operate(args, async (state, signal, assertCurrent) => {
      if (!['diagnose', 'analysis'].includes(args.mode)) throw fail('AI_MODE', tr('分析模式无效。'));
      const question = shortText(args.question);
      state.preview = null; state.cache = null;
      const collected = await evidence.collect({ deviceId: args.deviceId, selectedChecks: args.checks || [],
        sourceIds: args.sourceIds || [], text: args.text || '', signal });
      assertCurrent();
      const preview = { id: randomUUID(), question, ...collected, expiresAt: new Date(now() + TTL).toISOString() };
      state.preview = { ...preview, locale: getLocale(), mode: args.mode };
      return { preview };
    }),
    analyze: args => operate(args, async (state, signal, assertCurrent) => {
      const preview = state.preview;
      if (args.consent !== true || !preview || args.previewId !== preview.id || now() >= Date.parse(preview.expiresAt)) throw fail('AI_PREVIEW_EXPIRED', tr('请重新生成并确认证据预览后再分析。'));
      const payload = { question: preview.question, evidence: preview.entries };
      const locale = getLocale();
      const key = createHash('sha256').update(JSON.stringify([locale, payload])).digest('hex');
      await entitled(); assertCurrent();
      if (state.cache?.key === key && now() - state.cache.at < 5 * 60 * 1000) return { result: state.cache.result, usage: state.cache.usage, cached: true };
      const answer = await withLocale(locale, () => infer(prompts.analysis, payload, signal, assertCurrent));
      const result = parseAnalysis(answer.text, preview.entries.map(entry => entry.id));
      state.cache = { key, result, usage: answer.usage, at: now() };
      return { result, usage: answer.usage, cached: false };
    }),
    generateTask: args => operate(args, async (state, signal, assertCurrent) => {
      const goal = shortText(args.goal);
      state.draft = null;
      const answer = await infer(prompts.task, { goal }, signal, assertCurrent);
      const draft = { id: randomUUID(), ...parseTask(answer.text) };
      state.draft = { ...draft, expiresAt: now() + TTL };
      return { draft, usage: answer.usage };
    }),
    saveTask: args => operate(args, async (state, _signal, assertCurrent) => {
      await entitled(); assertCurrent();
      const draft = state.draft;
      if (!draft || args.draftId !== draft.id || now() >= draft.expiresAt) throw fail('AI_DRAFT_EXPIRED', tr('任务草案已失效，请重新生成。'));
      if (!await confirmSave(draft)) return { cancelled: true };
      assertCurrent();
      if (state.draft !== draft || now() >= draft.expiresAt) throw fail('AI_DRAFT_EXPIRED', tr('任务草案已失效，请重新生成。'));
      const script = await saveTask({ name: draft.name, description: draft.description, steps: draft.steps });
      state.draft = null;
      return { script };
    }),
    async cancel(args) { getCase(args.caseId).operation?.abort(); return { cancelled: true }; },
    async close(args) { const state = cases.get(args.caseId); state?.operation?.abort(); cases.delete(args.caseId); return {}; },
  };
  return {
    async call(method, args = {}) {
      try {
        if (!Object.hasOwn(methods, method) || !args || typeof args !== 'object' || Array.isArray(args)) throw fail('AI_OPERATION', tr('AI 操作无效。'));
        return { ok: true, ...await methods[method](args) };
      } catch (error) {
        return { ok: false, code: error.code || 'AI_WORKSPACE_FAILED', cancelled: error.code === 'CANCELLED',
          error: error.safe || String(error.code || '').startsWith('AI_') || error.code === 'CANCELLED' ? error.message : tr('AI 操作未完成，请检查输入后重试。') };
      }
    },
    dispose() { for (const state of cases.values()) state.operation?.abort(); cases.clear(); },
  };
}

module.exports = { createAiWorkspaceService };
