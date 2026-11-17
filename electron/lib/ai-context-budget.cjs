const { residentBytes } = require('./ai-context-limits.json');
const { tr } = require('./localization.cjs');

function createByteBudget(maximum) {
  let bytes = 0;
  return {
    reserve(size) {
      if (!Number.isSafeInteger(size) || size < 0 || size + bytes > maximum) throw Object.assign(new Error(tr('AI 本地材料占用已达上限，请完成或取消现有操作后重试；未删除材料。')), { code: 'AI_CONTEXT_MEMORY', safe: true });
      bytes += size; let active = true;
      return () => { if (active) { active = false; bytes -= size; } };
    },
    get bytes() { return bytes; },
  };
}

const residentBudget = createByteBudget(residentBytes);
module.exports = { createByteBudget, residentBudget };
