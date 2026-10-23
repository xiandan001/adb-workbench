// Endpoints match the pinned upstream provider catalog; models are deliberately not guessed.
export const AI_PROVIDER_PRESETS = Object.freeze([
  { value: 'anthropic', label: 'Anthropic 官方', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  { value: 'openai', label: 'OpenAI / Codex API', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
  { value: 'gemini', label: 'Google Gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' },
  { value: 'deepseek', label: 'DeepSeek', protocol: 'openai-chat', baseUrl: 'https://api.deepseek.com/v1', quota: 'deepseek' },
  { value: 'openrouter', label: 'OpenRouter', protocol: 'openai-chat', baseUrl: 'https://openrouter.ai/api/v1', quota: 'openrouter' },
  { value: 'siliconflow', label: '硅基流动（中国站）', protocol: 'openai-chat', baseUrl: 'https://api.siliconflow.cn/v1', quota: 'siliconflow' },
]);
export function applyProviderPreset(draft, value) {
  const preset = AI_PROVIDER_PRESETS.find(item => item.value === value);
  if (!preset) throw new Error('供应商模板不存在');
  return { ...draft, name: preset.label, protocol: preset.protocol, baseUrl: preset.baseUrl, model: '', contextWindow: '',
    apiKey: '', quotaKey: '', clearKey: false, clearQuotaKey: false, quota: preset.quota ? { adapter: preset.quota } : null };
}
