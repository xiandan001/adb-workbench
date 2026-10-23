const TOOLS = [
  ['claude', 'Claude Code', ['anthropic']],
  ['codex', 'Codex', ['openai-responses']],
  ['gemini', 'Gemini CLI', ['gemini']],
  ['opencode', 'OpenCode', ['openai-chat', 'openai-responses', 'anthropic', 'gemini']],
  ['claude-desktop', 'Claude Desktop', ['anthropic']], ['grokbuild', 'Grok Build', ['openai-responses']],
  ['openclaw', 'OpenClaw', ['openai-chat', 'openai-responses', 'anthropic', 'gemini']],
  ['hermes', 'Hermes', ['openai-chat', 'openai-responses', 'anthropic']], ['pi', 'Pi', ['openai-chat', 'openai-responses', 'anthropic', 'gemini']],
  ['mcode', 'MCode', ['openai-chat', 'openai-responses', 'anthropic']],
  ['kimi', 'Kimi Code', ['openai-chat', 'openai-responses', 'anthropic', 'gemini']], ['agy', 'Antigravity'],
];

function getAiToolsCatalog() {
  return TOOLS.map(([id, label, protocols]) => ({
    id, label, configSupported: Boolean(protocols), launchSupported: id === 'agy', protocols: [...(protocols || (id === 'agy' ? ['gemini'] : []))],
    ...(protocols ? {} : { reason: '通过「项目与 CLI」的受管终端启动，使用独立配置目录，不修改全局登录配置。' }),
  }));
}

module.exports = { getAiToolsCatalog };
