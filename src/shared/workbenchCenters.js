import { tr } from './i18n.js';

export const WORKBENCH_CENTER_PAGES_KEY = 'adb-workbench.center-pages.v1';

const centers = [
  {
    id: 'test-center',
    title: () => tr('测试中心'),
    pages: [
      { id: 'quality', label: () => tr('质量') },
      { id: 'tasks', label: () => tr('任务') },
      { id: 'artifacts', label: () => tr('产物') },
    ],
  },
  {
    id: 'diagnostics-center',
    title: () => tr('诊断中心'),
    pages: [
      { id: 'troubleshoot', label: () => tr('问题排查') },
      { id: 'performance', label: () => tr('性能监控') },
    ],
  },
  {
    id: 'ai-center',
    title: () => tr('AI 中心'),
    pages: [
      { id: 'ai-workspace', label: () => tr('AI 工作区') },
      { id: 'ai-tools', label: () => tr('工具管理') },
    ],
  },
];

const hasLeaf = (center, leaf) => center.pages.some(page => page.id === leaf);
const findLeafCenter = leaf => centers.find(center => hasLeaf(center, leaf));

export function getWorkbenchCenter(activeTab) {
  const center = findLeafCenter(activeTab);
  return center ? {
    id: center.id, title: center.title(),
    pages: center.pages.map(page => ({ id: page.id, label: page.label() })),
  } : null;
}

function validRememberedLeaf(center, preferences) {
  if (!preferences || typeof preferences !== 'object' || !Object.hasOwn(preferences, center.id)) return null;
  const leaf = preferences[center.id];
  return hasLeaf(center, leaf) ? leaf : null;
}

export function centerPage(centerId, preferences) {
  const center = centers.find(item => item.id === centerId);
  return center ? validRememberedLeaf(center, preferences) || center.pages[0].id : null;
}

function normalizedPages(preferences) {
  const remembered = {};
  for (const center of centers) {
    const leaf = validRememberedLeaf(center, preferences);
    if (leaf) remembered[center.id] = leaf;
  }
  return remembered;
}

export function readWorkbenchCenterPages(storage) {
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    const serialized = target?.getItem(WORKBENCH_CENTER_PAGES_KEY);
    return typeof serialized === 'string' && serialized.length <= 4096 ? normalizedPages(JSON.parse(serialized)) : {};
  } catch {
    return {};
  }
}

export function rememberWorkbenchCenterPage(preferences, activeTab, storage) {
  const center = findLeafCenter(activeTab);
  const remembered = normalizedPages(preferences);
  if (!center || remembered[center.id] === activeTab) return remembered;
  remembered[center.id] = activeTab;
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    target?.setItem(WORKBENCH_CENTER_PAGES_KEY, JSON.stringify(remembered));
  } catch {
    // Keep the most recent selection in memory if disk preferences are unavailable.
  }
  return remembered;
}

export function nextWorkbenchCenterPage(center, activeTab, key) {
  const pages = center?.pages || [];
  const index = pages.findIndex(page => page.id === activeTab);
  if (index === -1) return null;
  if (key === 'Home') return pages[0].id;
  if (key === 'End') return pages.at(-1).id;
  const offset = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0;
  return offset ? pages[(index + offset + pages.length) % pages.length].id : null;
}
