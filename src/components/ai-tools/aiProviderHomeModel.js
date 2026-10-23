const PUBLIC_FIELDS = ['id', 'name', 'protocol', 'baseUrl', 'model', 'claudeModels', 'contextWindow', 'targetApps', 'hasCredential', 'hasQuotaCredential', 'quota'];
export function providerFingerprint(provider) { return JSON.stringify(PUBLIC_FIELDS.map(key => [key, provider?.[key] ?? null])); }
export function providerFeedbackToken(provider, epoch) { return { providerId: provider.id, fingerprint: providerFingerprint(provider), epoch }; }
export function providerFeedbackCurrent(token, provider, epoch) {
  return Boolean(provider && token && token.providerId === provider.id && token.epoch === epoch && token.fingerprint === providerFingerprint(provider));
}
export function connectionFeedback(result) {
  if (result?.reachable !== true) throw new Error('未能确认接口响应，请核对地址、协议及密钥');
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
