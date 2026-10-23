const PUBLIC_FIELDS = ['id', 'name', 'protocol', 'baseUrl', 'model', 'claudeModels', 'cliConfig', 'contextWindow', 'targetApps', 'hasCredential', 'hasQuotaCredential', 'quota'];
export function providerFingerprint(provider) { return JSON.stringify(PUBLIC_FIELDS.map(key => [key, provider?.[key] ?? null])); }
export function providerFeedbackToken(provider, epoch) { return { providerId: provider.id, fingerprint: providerFingerprint(provider), epoch }; }
export function providerFeedbackCurrent(token, provider, epoch) {
  return Boolean(provider && token && token.providerId === provider.id && token.epoch === epoch && token.fingerprint === providerFingerprint(provider));
}
export function retainProviderFeedback(records, providers, epoch, activated) {
  if (!activated) return {};
  return Object.fromEntries(providers.flatMap(provider => {
    const entry = records[provider.id]; return providerFeedbackCurrent(entry?.token, provider, epoch) ? [[provider.id, entry]] : [];
  }));
}
export function connectionCompletionNotice(result, feedback) {
  if (result?.cancelled) return '已取消连接测试';
  if (feedback?.status === 'error') return `连接测试失败：${feedback.message}`;
  if (feedback?.status === 'partial') return '只读检查完成：接口已响应，模型调用尚未验证';
  return result?.mode === 'inference' ? '模型连接测试成功，已收到有效响应' : '只读接口检查成功，尚未验证模型调用';
}
export function connectionFeedback(result) {
  if (result?.reachable !== true) throw new Error('未能确认接口响应，请核对地址、协议及密钥');
  if (result.mode === 'inference' && result.status === 'verified' && result.inferenceVerified === true) {
    const latency = Number.isFinite(result.latencyMs) ? ` · ${result.latencyMs} ms` : '';
    const usage = Number.isSafeInteger(result.outputTokens) ? ` · 输出 ${result.outputTokens} tokens` : '';
    return { status: 'verified', message: `模型调用成功 · ${result.model}${latency}${usage}。${result.hasTextResponse ? '已收到模型文本回复。' : '接口接受请求，输出达到本次测试上限。'}` };
  }
  if (result.status === 'partial' && result.modelsSupported === false) return { status: 'partial', message: '已收到接口响应，但此接口不支持模型列表；尚未验证密钥或模型。可手动配置模型，未发起付费推理请求。' };
  if (result.status !== 'verified' || result.modelsSupported !== true) throw new Error('无法确认本次连接检查结果，请重试');
  const count = Number.isSafeInteger(result.modelCount) && result.modelCount >= 0 ? ` · ${result.modelCount} 个模型` : '';
  const latency = Number.isFinite(result.latencyMs) ? ` · ${result.latencyMs} ms` : '';
  return { status: 'verified', message: `模型列表读取成功${count}${latency}。未验证密钥权限或模型调用，未发起付费推理请求。` };
}
export function providerHomeTool(tools, providers, choice) {
  const available = tools.filter(tool => tool.configSupported || tool.launchSupported);
  return available.find(tool => tool.id === choice) || available.find(tool => providers.some(provider => provider.targetApps?.includes(tool.id) && tool.protocols?.includes(provider.protocol))) || available[0];
}
export function providerStatusRows(native, context, checking) {
  return context.active && context.ready && !checking && native?.context === context ? native.value.providers : [];
}
