import { tr } from '../../shared/i18n.js';
const PUBLIC_FIELDS = ['id', 'name', 'protocol', 'baseUrl', 'model', 'claudeModels', 'cliConfig', 'contextWindow', 'targetApps', 'hasCredential', 'hasQuotaCredential', 'quota'];
export function providerFingerprint(provider) { return JSON.stringify(PUBLIC_FIELDS.map(key => [key, provider?.[key] ?? null])); }
export function providerFeedbackToken(provider, epoch) { return { providerId: provider.id, fingerprint: providerFingerprint(provider), epoch }; }
export function providerFeedbackCurrent(token, provider, epoch) {
  return Boolean(provider && token && token.providerId === provider.id && token.epoch === epoch && token.fingerprint === providerFingerprint(provider));
}
export function connectionCompletionNotice(result, feedback) {
  if (result?.cancelled) return tr("已取消连接测试");
  if (feedback?.status === 'error') return tr("连接测试失败：{0}", { 0: feedback.message });
  if (feedback?.status === 'partial') return tr("只读检查完成：接口已响应，模型调用尚未验证");
  return result?.mode === 'inference' ? tr("模型连接测试成功，已收到有效响应") : tr("只读接口检查成功，尚未验证模型调用");
}
export function connectionFeedback(result) {
  if (result?.reachable !== true) throw new Error(tr("未能确认接口响应，请核对地址、协议及密钥"));
  if (result.mode === 'inference' && result.status === 'verified' && result.inferenceVerified === true) {
    const latency = Number.isFinite(result.latencyMs) ? ` · ${result.latencyMs} ms` : '';
    const usage = Number.isSafeInteger(result.outputTokens) ? tr(" · 输出 {0} tokens", { 0: result.outputTokens }) : '';
    return { status: 'verified', message: tr("模型调用成功 · {0}{1}{2}。{3}", { 0: result.model, 1: latency, 2: usage, 3: result.hasTextResponse ? tr("已收到模型文本回复。") : tr("接口接受请求，输出达到本次测试上限。") }) };
  }
  if (result.status === 'partial' && result.modelsSupported === false) return { status: 'partial', message: tr("已收到接口响应，但此接口不支持模型列表；尚未验证密钥或模型。可手动配置模型，未发起付费推理请求。") };
  if (result.status !== 'verified' || result.modelsSupported !== true) throw new Error(tr("无法确认本次连接检查结果，请重试"));
  const count = Number.isSafeInteger(result.modelCount) && result.modelCount >= 0 ? tr(" · {0} 个模型", { 0: result.modelCount }) : '';
  const latency = Number.isFinite(result.latencyMs) ? ` · ${result.latencyMs} ms` : '';
  return { status: 'verified', message: tr("模型列表读取成功{0}{1}。未验证密钥权限或模型调用，未发起付费推理请求。", { 0: count, 1: latency }) };
}
export function providerHomeTool(tools, providers, choice) {
  const available = tools.filter(tool => tool.configSupported || tool.launchSupported);
  return available.find(tool => tool.id === choice) || available.find(tool => providers.some(provider => provider.targetApps?.includes(tool.id) && tool.protocols?.includes(provider.protocol))) || available[0];
}
export function providerStatusRows(native, context, checking) {
  return context.active && context.ready && !checking && native?.context === context ? native.value.providers : [];
}
