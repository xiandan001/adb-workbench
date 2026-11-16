import { tr } from './i18n.js';

export function nextEnabledActionIndex(actions, current, key) {
  const enabled = actions.map((action, index) => action.disabled ? -1 : index).filter(index => index >= 0);
  if (!enabled.length) return -1;
  if (key === 'Home') return enabled[0];
  if (key === 'End') return enabled.at(-1);
  const at = enabled.indexOf(current), direction = key === 'ArrowUp' ? -1 : 1;
  if (at < 0) return direction < 0 ? enabled.at(-1) : enabled[0];
  return enabled[(at + direction + enabled.length) % enabled.length];
}

export function artifactTechnicalActions(item, { onOpenPath, onDelete }) {
  const target = Object.freeze({ ...item });
  return [
    target.reportPath && { id: 'report', label: tr('打开报告'), onSelect: () => onOpenPath(target.reportPath) },
    target.summaryPath && { id: 'data', label: tr('打开数据'), onSelect: () => onOpenPath(target.summaryPath) },
    target.rootPath && { id: 'directory', label: tr('打开目录'), onSelect: () => onOpenPath(target.rootPath) },
    { id: 'delete', label: tr('删除产物'), danger: true, onSelect: () => onDelete(target) },
  ].filter(Boolean);
}

export function taskTechnicalActions(task, { onOpenPath, onOpenAnalysis, onCompareParent }) {
  const target = Object.freeze({ id: task.id, parentTaskId: task.parentTaskId });
  const origin = task.analysisOrigin && Object.freeze({ casebookId: task.analysisOrigin.casebookId, historyId: task.analysisOrigin.historyId,
    caseId: task.analysisOrigin.caseId, turnId: task.analysisOrigin.turnId });
  const canOpenOrigin = origin && (origin.casebookId || origin.historyId || (origin.caseId && origin.turnId));
  const reportPath = task.stressReportPath, dataPath = task.runResultPath || task.stressResultPath, artifactDir = task.artifactDir;
  return [
    canOpenOrigin && onOpenAnalysis && { id: 'analysis-origin', label: tr('查看原分析'), onSelect: () => onOpenAnalysis(origin) },
    !['running', 'queued'].includes(task.status) && task.mode === 'replay' && target.parentTaskId && onCompareParent
      && { id: 'compare', label: tr('与原失败运行比较'), onSelect: () => onCompareParent(target) },
    reportPath && { id: 'report', label: tr('打开报告'), onSelect: () => onOpenPath(reportPath) },
    dataPath && { id: 'data', label: tr('运行数据'), onSelect: () => onOpenPath(dataPath) },
    artifactDir && { id: 'directory', label: tr('证据目录'), onSelect: () => onOpenPath(artifactDir) },
  ].filter(Boolean);
}
