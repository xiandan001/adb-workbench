import { tr } from './i18n.js';

export function resolveTaskArtifact(items, taskId) {
  const matches = items.filter(item => item.type === 'task' && item.taskId === taskId && typeof item.id === 'string' && item.id);
  if (!taskId || matches.length !== 1) throw new Error(tr('未找到唯一的本次运行产物，请确认结果已保存后重试。'));
  return matches[0];
}
export async function exportTaskResult(taskId, api) {
  const result = await api?.artifactsList?.();
  if (!result?.ok) throw new Error(result?.error || tr('产物列表加载失败'));
  return api.artifactExport(resolveTaskArtifact(result.items || [], taskId).id);
}
export async function exportTaskComparison(beforeTaskId, afterTaskId, api) {
  const result = await api?.artifactsList?.();
  if (!result?.ok) throw new Error(result?.error || tr('产物列表加载失败'));
  return api.artifactExportComparison({ beforeId: resolveTaskArtifact(result.items || [], beforeTaskId).id, afterId: resolveTaskArtifact(result.items || [], afterTaskId).id });
}
