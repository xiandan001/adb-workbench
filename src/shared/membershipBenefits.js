import limits from '../../electron/lib/membership-limits.json' with { type: 'json' };
import { tr } from './i18n.js';

const comparisonKey = 'adb-workbench.membership-comparison.v1';

export function readMembershipComparison(storage = globalThis.localStorage) {
  try { return storage?.getItem(comparisonKey) === 'all'; }
  catch { return false; }
}

export function saveMembershipComparison(showAll, storage = globalThis.localStorage) {
  try { storage?.setItem(comparisonKey, showAll ? 'all' : 'differences'); }
  catch { /* Keep the current view if the session cannot store preferences. */ }
}

export function getMembershipBenefitGroups(showAll) {
  const groups = [
    {
      id: 'devices',
      title: tr("设备与历史"),
      items: [
        { id: 'device-count', name: tr("同时管理设备数量"), free: tr("{0} 台", { 0: limits.freeDeviceLimit }), vip: tr("不限") },
        { id: 'connection-history', name: tr("连接历史记录"), free: tr("最近 {0} 条", { 0: limits.freeConnectionHistoryLimit }), vip: tr("本机保留的最近 {0} 条", { 0: limits.storedConnectionHistoryLimit }) }
      ]
    },
    {
      id: 'packages',
      title: tr("App 包管理"),
      items: [
        { id: 'app-basics', name: tr("应用列表、详情、启动与清单快照"), free: true, vip: true },
        { id: 'install', name: tr("安装、推送和文件浏览"), free: true, vip: true },
        { id: 'app-management', name: tr("应用权限面板、批量管理及 APK 导出"), free: false, vip: true }
      ]
    },
    {
      id: 'quality',
      title: tr("质量与自动化"),
      items: [
        { id: 'regression', name: tr("回归基线与差异报告"), free: true, vip: true },
        { id: 'tasks', name: tr("任务执行与常规产物"), free: true, vip: true },
        { id: 'inspection', name: tr("设备巡检报告与证据包"), free: false, vip: true },
        { id: 'performance', name: tr("性能监控面板"), free: tr("基础采样"), vip: tr("高频采样、进程监控、阈值编辑与导出") }
      ]
    },
    {
      id: 'ai',
      title: tr("日志与 AI"),
      items: [
        { id: 'local-diagnosis', name: tr("本地规则诊断"), free: true, vip: true },
        { id: 'rules', name: tr("自定义诊断规则管理"), free: false, vip: true },
        { id: 'ai-analysis', name: tr("内置 AI 分析与自然语言日志搜索"), free: false, vip: true },
        { id: 'mcp', name: tr("MCP 服务集成"), free: false, vip: true },
        { id: 'ai-tools', name: tr("AI 工具配置与启动"), free: false, vip: true }
      ]
    },
    {
      id: 'records',
      title: tr("会员记录"),
      items: [
        { id: 'activation-records', name: tr("激活记录与复制历史"), free: true, vip: true }
      ]
    }
  ];
  if (showAll) return groups;
  return groups.map(group => ({ ...group, items: group.items.filter(item => item.free !== item.vip) }))
    .filter(group => group.items.length);
}
