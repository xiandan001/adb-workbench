const { tr } = require('./localization.cjs');

// Ten minutes to inspect the frozen preview plus the existing one-minute
// request deadline. The worker has a slightly longer watchdog, not a network timer.
const AI_BRIDGE_TOTAL_MS = 11 * 60 * 1000;
function skipped(deadline = false) {
  return { ok: false, cancelled: true, skipped: true, summary: '', code: deadline ? 'AI_REVIEW_TIMEOUT' : 'AI_SEND_CANCELLED',
    skipReason: deadline ? tr('AI 审阅等待已超时，已保留本地任务结果。') : tr('AI 分析已取消，已保留本地任务结果。') };
}
function normalizeSummary(result) {
  return result?.cancelled || ['AI_SEND_CANCELLED', 'AI_SEND_EXPIRED', 'CANCELLED'].includes(result?.code) ? skipped() : result;
}
function createTaskAiBridge({ generate, isActive, totalMs = AI_BRIDGE_TOTAL_MS }) {
  const requests = new Map();
  return {
    async run(id, taskId, options = {}) {
      if (!id || requests.has(id) || requests.size >= 16 || !taskId || !isActive(taskId)) return skipped();
      const controller = new AbortController();
      const entry = { taskId, controller, deadline: false }; requests.set(id, entry);
      let abort;
      const cancelled = new Promise(resolve => { abort = () => resolve(skipped(entry.deadline)); controller.signal.addEventListener('abort', abort, { once: true }); });
      const timer = setTimeout(() => { entry.deadline = true; controller.abort(); }, totalMs); timer.unref?.();
      try {
        const result = await Promise.race([cancelled, Promise.resolve().then(() => {
          if (controller.signal.aborted || !isActive(taskId)) return skipped();
          return generate({ ...options, timeoutMs: Math.min(60000, Math.max(1000, Number(options.timeoutMs) || 60000)), signal: controller.signal });
        })]);
        return controller.signal.aborted || !isActive(taskId) ? skipped(entry.deadline) : normalizeSummary(result);
      } catch (error) { return controller.signal.aborted ? skipped(entry.deadline) : { ok: false, error: error.message }; }
      finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); if (requests.get(id) === entry) requests.delete(id); }
    },
    cancelRequest(id, taskId) { const item = requests.get(id); if (item?.taskId === taskId) item.controller.abort(); },
    cancelTask(taskId) { for (const item of requests.values()) if (item.taskId === taskId) item.controller.abort(); },
    cleanup() { for (const item of requests.values()) item.controller.abort(); },
  };
}
module.exports = { createTaskAiBridge, normalizeSummary, AI_BRIDGE_TOTAL_MS };
