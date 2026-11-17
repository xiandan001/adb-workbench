const { PLAN_REQUESTS, REDUCE_LEVELS } = require('./ai-workspace-request-plan.cjs');
const { residentBudget } = require('./ai-context-budget.cjs');
const { tr } = require('./localization.cjs');

async function runLegacyRequestPlan({ lines, prompt, reducePrompt, intro, maxLines, plan, send, withBatch, onProgress = () => {} }) {
  let current = await plan({ prompt, lines, intro, maxLines }), count = 0, levels = 0, completed = 0;
  const totalChunks = current.requests.length;
  while (true) {
    count += current.requests.length;
    if (count >= PLAN_REQUESTS) throw Object.assign(new Error(tr('AI 分块计划超过 64 个请求或 4 层汇总，未自动截断或继续发送。')), { code: 'AI_CONTEXT_PLAN_LIMIT' });
    const release = residentBudget.reserve(current.requests.reduce((sum, request) => sum + request.bytes, 0));
    const summaries = [];
    try {
      onProgress(levels ? 'reduce' : 'map', 0, current.requests.length);
      for (let start = 0; start < current.requests.length; start += 16) {
        const batch = current.requests.slice(start, start + 16);
        const results = await withBatch(tr('确认发送固定日志分块'), () => Promise.all(batch.map(request => send({ ...request, timeoutMs: 90000, temperature: 0.2 }))));
        for (let index = 0; index < results.length; index++) {
          const result = results[index];
          if (!result.ok) throw Object.assign(new Error(result.error || tr('AI 分块结果不完整，未生成最终结论。')),
            { code: result.code || 'AI_CONTEXT_INCOMPLETE', name: result.cancelled ? 'AbortError' : 'Error' });
          summaries.push(`${JSON.stringify(batch[index].mapping)}\n${result.summary}`);
          onProgress(levels ? 'reduce' : 'map', ++completed, totalChunks);
        }
      }
    } finally { release(); }
    const reduced = await plan({ prompt: reducePrompt, intro: '', lines: [intro || '', ...summaries].filter(Boolean) });
    if (reduced.requests.length === 1) return { systemPrompt: reducePrompt, userContent: reduced.requests[0].userContent, maxTokens: reduced.requests[0].maxTokens, totalChunks };
    if (++levels >= REDUCE_LEVELS) throw Object.assign(new Error(tr('AI 分块计划超过 64 个请求或 4 层汇总，未自动截断或继续发送。')), { code: 'AI_CONTEXT_PLAN_LIMIT' });
    current = reduced;
  }
}

module.exports = { runLegacyRequestPlan };
