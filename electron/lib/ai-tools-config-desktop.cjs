const { tr } = require('./localization.cjs');
const { fail } = require('./ai-tools-file-safety.cjs');

// App-owned namespace, intentionally not CC Switch's profile id.
const DESKTOP_PROFILE_ID = 'f56ec0a3-9cb3-4d59-8f90-d9f0c7bd44bf';
const DESKTOP_PROFILE_NAME = '卓控台 AI 工具';

function projectDesktopConfig(role, content, provider, { patchJson, parseJsonc }) {
  if (!/^(?:anthropic\/)?claude-(?:sonnet|opus|haiku|fable)-[A-Za-z0-9][A-Za-z0-9_.-]*$/i.test(provider.model)) throw fail('AI_TOOLS_DESKTOP_MODEL', tr("Claude Desktop 直连只支持可识别的 Claude 模型名，不会伪造模型映射"));
  if (role === 'normal' || role === 'third-party') return patchJson(content, [{ keys: ['deploymentMode'], value: '3p' }]);
  if (role === 'profile') return { ...patchJson(content, [
    { keys: ['inferenceGatewayBaseUrl'], value: provider.baseUrl },
    { keys: ['inferenceGatewayApiKey'], value: provider.apiKey, secret: true },
    { keys: ['inferenceGatewayAuthScheme'], value: 'bearer' },
    { keys: ['inferenceProvider'], value: 'gateway' },
    { keys: ['inferenceModels'], value: [provider.model] },
  ]), warnings: [tr("Claude Desktop 将切换至第三方网关模式；保留已有网络/安全策略，不添加通配网络授权。应用后请重新打开 Desktop。")] };
  const value = parseJsonc(content);
  if (value.entries !== undefined && !Array.isArray(value.entries)) throw fail('AI_TOOLS_DESKTOP_META', tr("Claude Desktop 配置档列表格式无效"));
  const entries = value.entries || [];
  const indices = entries.map((row, index) => row?.id === DESKTOP_PROFILE_ID ? index : -1).filter(index => index >= 0);
  if (indices.length > 1 || (indices.length && entries[indices[0]].name !== DESKTOP_PROFILE_NAME)) throw fail('AI_TOOLS_DESKTOP_OWNER', tr("Claude Desktop 中同名标识已由其他配置档占用，未覆盖"));
  const assignments = [{ keys: ['appliedId'], value: DESKTOP_PROFILE_ID }];
  if (!indices.length) assignments.push({ keys: ['entries', entries.length], value: { id: DESKTOP_PROFILE_ID, name: DESKTOP_PROFILE_NAME } });
  return patchJson(content, assignments);
}

function validateDesktopOwnership(rows, parseJsonc) {
  if (!rows.find(row => row.role === 'profile')?.exists) return;
  const meta = rows.find(row => row.role === 'meta');
  const parsed = parseJsonc(meta.bytes?.toString('utf8') || '');
  if (!Array.isArray(parsed.entries) || !parsed.entries.some(row => row?.id === DESKTOP_PROFILE_ID && row.name === DESKTOP_PROFILE_NAME)) throw fail('AI_TOOLS_DESKTOP_OWNER', tr("已有 Desktop 配置档不能证明属于本应用，未覆盖；请先核对路径或恢复备份"));
}

module.exports = { projectDesktopConfig, validateDesktopOwnership, DESKTOP_PROFILE_ID };
