// Endpoints match the pinned upstream provider catalog; models are deliberately not guessed.
export const AI_PROVIDER_PRESETS = Object.freeze([
  { value: 'anthropic', label: 'Anthropic 官方', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', targetApps: ['claude'] },
  { value: 'zhipu-claude', label: '智谱 GLM · Claude Code', protocol: 'anthropic', baseUrl: 'https://open.bigmodel.cn/api/anthropic', targetApps: ['claude'], quota: 'zhipu' },
  { value: 'openai', label: 'OpenAI / Codex API', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1', targetApps: ['codex'] },
  { value: 'gemini', label: 'Google Gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', targetApps: ['gemini'] },
  { value: 'deepseek', label: 'DeepSeek', protocol: 'openai-chat', baseUrl: 'https://api.deepseek.com/v1', targetApps: ['opencode'], quota: 'deepseek' },
  { value: 'openrouter', label: 'OpenRouter', protocol: 'openai-chat', baseUrl: 'https://openrouter.ai/api/v1', targetApps: ['opencode'], quota: 'openrouter' },
  { value: 'siliconflow', label: '硅基流动（中国站）', protocol: 'openai-chat', baseUrl: 'https://api.siliconflow.cn/v1', targetApps: ['opencode'], quota: 'siliconflow' },
]);
export function applyProviderPreset(draft, value) {
  const preset = AI_PROVIDER_PRESETS.find(item => item.value === value);
  if (!preset) throw new Error('供应商模板不存在');
  const next = { ...draft, name: preset.label, protocol: preset.protocol, baseUrl: preset.baseUrl, model: '', contextWindow: '', targetApps: [...preset.targetApps],
    apiKey: '', quotaKey: '', clearKey: false, clearQuotaKey: false, quotaTemplate: '', quota: preset.quota ? { adapter: preset.quota } : null };
  delete next.claudeModels;
  delete next.cliConfig;
  return next;
}
