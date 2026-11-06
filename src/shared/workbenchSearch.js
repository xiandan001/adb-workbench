import { tr } from './i18n.js';

export function searchDestinations() {
  const settings = [
    ['settings-commands', tr('快捷命令')], ['settings-cast', tr('投屏')],
    ['settings-paths', tr('保存路径')], ['settings-appearance', tr('外观')],
    ['settings-data', tr('数据迁移')], ['settings-update', tr('更新')],
    ['settings-danger', tr('高危操作')],
  ].map(([id, title]) => ({ id: `setting:${id}`, title, group: tr('偏好设置'),
    description: `${tr('偏好设置')} → ${title}`, destination: { kind: 'settings', id } }));
  const paths = [
    ['screenshotPath', tr('截图保存位置'), tr('截图路径')],
    ['screenRecordPath', tr('录屏保存位置'), tr('录屏路径')],
    ['inspectionPath', tr('巡检报告保存位置'), tr('巡检路径')],
    ['performancePath', tr('性能报告保存位置'), tr('性能路径')],
    ['taskCenterPath', tr('任务产物保存位置'), tr('任务路径')],
    ['qualityCenterPath', tr('质量报告保存位置'), tr('质量路径')],
  ].map(([field, title, keyword]) => ({ id: `path:${field}`, title, keywords: [keyword], group: tr('偏好设置'),
    description: `${tr('偏好设置')} → ${tr('保存路径')}`, destination: { kind: 'settings', id: 'settings-paths', field } }));
  const tools = [['providers', tr('供应商')], ['projects', tr('项目启动')], ['sessions', tr('会话与本机用量')],
    ['quota', tr('额度与余额')], ['config', tr('配置应用')], ['mcp', 'MCP'], ['prompts', tr('提示词')],
    ['skills', 'Skills'], ['backups', tr('配置备份')], ['portable', tr('加密迁移')]]
    .map(([tab, title]) => ({ id: `ai-tool:${tab}`, title, group: tr('AI 工具管理'),
      description: `${tr('AI 工具管理')} → ${title}`, destination: { kind: 'ai-tool', tab } }));
  return [...settings, ...paths, ...tools];
}

export function searchRecords({ artifacts = [], reports = [], cases = [], tasks = [] } = {}) {
  const records = (items, kind, title, group, detail) => (Array.isArray(items) ? items : []).slice(0, 200)
    .filter(item => typeof item?.id === 'string' && item.id && item.id.length <= 200)
    .map(item => ({ id: `${kind}:${item.id}`, title: String(title(item) || group).slice(0, 240), group,
      description: String(detail(item) || group).slice(0, 500), destination: { kind, id: item.id },
      keywords: ['artifact', 'history'].includes(kind) ? [tr('最近报告'), tr('上次报告')] : kind === 'task' ? [tr('最近运行')] : [],
      createdAt: item.createdAt || item.startedAt || '' }));
  return [
    ...records(artifacts, 'artifact', item => item.title, tr('产物中心'), item => [item.typeLabel, item.deviceId, item.subtitle].filter(Boolean).join(' · ')),
    ...records(reports, 'history', item => item.name, tr('分析报告'), item => item.question),
    ...records(cases, 'casebook', item => item.name, tr('本地验证案例库'), item => [item.packageName, ...(item.tags || [])].join(' · ')),
    ...records(tasks, 'task', item => item.scriptName, tr('任务中心'), item => [item.scriptName, item.createdAt].filter(Boolean).join(' · ')),
  ].sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
}

export function filterSearchItems(items, query, limit = 60) {
  const terms = String(query || '').trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const matches = items.map((item, order) => {
    const title = String(item.title || '').toLocaleLowerCase();
    const text = [title, item.description, item.group, ...(item.keywords || [])].join(' ').toLocaleLowerCase();
    return { item, order, matches: terms.every(term => text.includes(term)), score: terms.length && terms.every(term => title.includes(term)) ? 1 : 0 };
  }).filter(item => item.matches);
  return matches.sort((a, b) => b.score - a.score || a.order - b.order).slice(0, limit).map(item => item.item);
}

export function selectedSearchIndex(items, selectedId) {
  return selectedId === null ? (items.length ? 0 : -1) : items.findIndex(item => item.id === selectedId);
}
