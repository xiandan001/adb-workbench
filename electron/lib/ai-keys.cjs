const path = require('node:path');
const { tr } = require('./localization.cjs');

// Only public defaults and numeric slot handles cross into the application code.
// Neither packaged nor development execution reads a plaintext credential file.
const nativeModule = 'veylo-builtin-ai.node';
const isPackaged = /(?:^|[\\/])app\.asar(?:[\\/]|$)/.test(__filename);
const nativePath = isPackaged
  ? path.join(process.resourcesPath || path.resolve(__dirname, '../../..'), nativeModule)
  : path.resolve(__dirname, '../../build/generated/builtin-ai', nativeModule);

let builtin;
try {
  const candidate = require(nativePath);
  if (typeof candidate.url === 'string' && typeof candidate.model === 'string' && Number.isSafeInteger(candidate.keyCount) &&
    ['currentSlot', 'nextSlot', 'initialSlot', 'dispatch'].every(name => typeof candidate[name] === 'function')) builtin = candidate;
} catch { /* Module failure must never restore the old plaintext loader. */ }

const AGNES_API_URL = builtin?.url || 'https://apihub.agnes-ai.com/v1/chat/completions';
const AGNES_MODEL = builtin?.model || 'agnes-3.0-flash';
const keyCount = builtin?.keyCount || 0;

function dispatchBuiltinRequest(options, callback) {
  if (!builtin || !Number.isSafeInteger(options?.builtinKeySlot) || options.builtinKeySlot < 0 || options.builtinKeySlot >= keyCount) {
    throw Object.assign(new Error(tr('内置 AI 暂不可用，请稍后重试。')), { code: 'AI_BUILTIN_UNAVAILABLE' });
  }
  return builtin.dispatch(options.builtinKeySlot, options, callback);
}

// 模型上下文窗口上限（tokens），用于前端展示上下文使用率
const AI_MODEL_MAX_CONTEXT_TOKENS = require('./ai-model-request-limits.cjs').contextTokens;

const AI_MAX_LOG_LINES = 10000;
// 对话上下文最大消息数（超出时保留最早的 system + 最近的消息）
const AI_MAX_CONTEXT_MESSAGES = 20;
// 字节转 token 估算比例：英文约 4 bytes/token，中文约 2 bytes/token，logcat 混合取 3
const AI_BYTES_PER_TOKEN = 3;

// AI 对话上下文字节总量上限：基于模型 token 上限估算（524288 tokens × 3 bytes/token ≈ 1.57MB）
const AI_MAX_CONTEXT_BYTES = Math.floor(AI_MODEL_MAX_CONTEXT_TOKENS * AI_BYTES_PER_TOKEN);

// Map-Reduce: 大日志分块分析配置
const AI_CHUNK_LINES = 2000;                      // 每块最大行数
const AI_MAPREDUCE_THRESHOLD_BYTES = 400 * 1024;  // 日志超 400KB 触发 Map-Reduce（约 100K tokens）
const AI_MAPREDUCE_MAX_CHUNKS = 5;                // 最多分 5 块（防止 API 调用过多）

// 上下文压缩：历史对话字节数达到模型上限 80% 时触发压缩（留 20% 余量给新日志和 system prompt）
const AI_CONTEXT_COMPRESS_THRESHOLD = Math.floor(AI_MODEL_MAX_CONTEXT_TOKENS * AI_BYTES_PER_TOKEN * 0.8);
const AI_COMPRESSED_MSG_MAX_BYTES = 2 * 1024;     // 超过 2KB 的历史消息会被压缩为摘要

module.exports = {
  AGNES_API_URL,
  AGNES_MODEL,
  keyCount,
  AI_MAX_LOG_LINES,
  AI_MAX_CONTEXT_MESSAGES,
  AI_MAX_CONTEXT_BYTES,
  AI_BYTES_PER_TOKEN,
  AI_CHUNK_LINES,
  AI_MAPREDUCE_THRESHOLD_BYTES,
  AI_MAPREDUCE_MAX_CHUNKS,
  AI_CONTEXT_COMPRESS_THRESHOLD,
  AI_COMPRESSED_MSG_MAX_BYTES,
  AI_MODEL_MAX_CONTEXT_TOKENS,
  getCurrentKeySlot: () => builtin?.currentSlot() ?? -1,
  getNextKeySlot: () => builtin?.nextSlot() ?? -1,
  getInitialKeySlot: () => builtin?.initialSlot() ?? -1,
  dispatchBuiltinRequest,
};
