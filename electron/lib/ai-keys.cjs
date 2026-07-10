// AI Key 加载与轮询管理（被 ai-analyze / auto-diagnose / smart-search / mcp 共享）
// 多 API Key 轮询：从本地私有文件 electron/api-keys.cjs 读取，避免 Key 进入 Git 仓库
// 该文件已加入 .gitignore，但会被 electron-builder 打包进应用，因此发布版本仍可正常使用
// 注意：必须使用 .cjs 扩展名！因为 package.json 声明了 "type": "module"，
//       .js 文件会被当作 ESM，require() 无法获取 module.exports 内容。
// 若文件缺失，则尝试从环境变量 AGNES_API_KEYS（逗号分隔）读取

const AGNES_API_URL = 'https://apihub.agnes-ai.com/v1/chat/completions';

let AGNES_API_KEYS = [];
try {
  const localKeys = require('../api-keys.cjs');
  if (Array.isArray(localKeys?.AGNES_API_KEYS) && localKeys.AGNES_API_KEYS.length > 0) {
    AGNES_API_KEYS = localKeys.AGNES_API_KEYS;
  }
} catch (e) {
  console.warn('[AI] 未找到 electron/api-keys.cjs，将尝试从环境变量读取 API Keys');
}
if (AGNES_API_KEYS.length === 0 && process.env.AGNES_API_KEYS) {
  AGNES_API_KEYS = process.env.AGNES_API_KEYS.split(',').map(k => k.trim()).filter(Boolean);
}
if (AGNES_API_KEYS.length === 0) {
  console.error('[AI] 未配置 Agnes API Keys，AI 日志分析功能将不可用。请创建 electron/api-keys.js 或设置 AGNES_API_KEYS 环境变量。');
}

// 轮询索引：随机起点，避免所有实例首次都打到同一个 Key
let agnesKeyIndex = AGNES_API_KEYS.length > 0 ? Math.floor(Math.random() * AGNES_API_KEYS.length) : 0;

// 加载时快照：MCP 的 ai_analyze 非流式接口使用此 Key（与原 main.cjs 行为保持一致）
const AGNES_API_KEY = AGNES_API_KEYS.length > 0 ? AGNES_API_KEYS[agnesKeyIndex] : '';

// 获取当前 Key（不递增）
function getCurrentApiKey() {
  if (AGNES_API_KEYS.length === 0) return '';
  return AGNES_API_KEYS[agnesKeyIndex];
}

// 获取下一个 API Key（轮询）
function getNextApiKey() {
  if (AGNES_API_KEYS.length === 0) return '';
  agnesKeyIndex = (agnesKeyIndex + 1) % AGNES_API_KEYS.length;
  return AGNES_API_KEYS[agnesKeyIndex];
}

const AGNES_MODEL = 'agnes-2.0-flash';

// 模型上下文窗口上限（tokens），用于前端展示上下文使用率
const AI_MODEL_MAX_CONTEXT_TOKENS = 524288;

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
  AGNES_API_KEYS,
  AGNES_API_KEY,
  AGNES_MODEL,
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
  getAgnesKeyIndex: () => agnesKeyIndex,
  getCurrentApiKey,
  getNextApiKey,
};
