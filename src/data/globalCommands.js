import { tr } from '../shared/i18n.js';
export const COMMAND_ACTIONS = [
  { value: 'tab:devices', get label() { return tr("打开设备列表"); } },
  { value: 'tab:ssh', get label() { return tr("打开 SSH 工作区"); } },
  { value: 'tab:ai-tools', get label() { return tr("打开 AI 工具管理"); } },
  { value: 'environmentCheck', get label() { return tr("打开环境自检弹窗"); } },
  { value: 'tab:troubleshoot', get label() { return tr("打开问题排查"); } },
  { value: 'tab:artifacts', get label() { return tr("打开产物中心"); } },
  { value: 'tab:quality', get label() { return tr("打开质量中心"); } },
  { value: 'tab:history', get label() { return tr("打开连接历史"); } },
  { value: 'tab:tasks', get label() { return tr("打开任务中心"); } },
  { value: 'tab:performance', get label() { return tr("打开性能监控"); } },
  { value: 'tab:settings', get label() { return tr("打开偏好设置"); } },
  { value: 'logAnalyzer', get label() { return tr("打开日志分析"); } },
  { value: 'refreshDevices', get label() { return tr("刷新设备列表"); } }
];

export const DEFAULT_COMMAND_SHORTCUT = {
  ctrl: true,
  alt: false,
  shift: false,
  meta: false,
  key: 'k'
};

export function normalizeCommandSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    enabled: source.enabled !== false,
    shortcut: Object.prototype.hasOwnProperty.call(source, 'shortcut')
      ? normalizeCommandShortcut(source.shortcut)
      : { ...DEFAULT_COMMAND_SHORTCUT },
    customCommands: Array.isArray(source.customCommands)
      ? source.customCommands
        .filter(command => command && command.title && command.action)
        .map(command => ({
          id: String(command.id || `custom-${Date.now()}`),
          title: String(command.title || '').slice(0, 40),
          description: String(command.description || '').slice(0, 80),
          action: String(command.action || COMMAND_ACTIONS[0].value),
          group: tr("自定义")
        }))
      : []
  };
}

export function actionLabel(action) {
  return COMMAND_ACTIONS.find(item => item.value === action)?.label || tr("自定义命令");
}

export function normalizeCommandShortcut(value) {
  if (!value || typeof value !== 'object') return null;
  const key = normalizeShortcutKey(value.key);
  if (!key) return null;
  return {
    ctrl: value.ctrl === true,
    alt: value.alt === true,
    shift: value.shift === true,
    meta: value.meta === true,
    key
  };
}

export function eventToCommandShortcut(event) {
  const key = normalizeShortcutKey(event.key);
  if (!key || isModifierKey(key)) return null;
  if (!event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) return null;
  return {
    ctrl: event.ctrlKey === true,
    alt: event.altKey === true,
    shift: event.shiftKey === true,
    meta: event.metaKey === true,
    key
  };
}

export function isCommandShortcutMatch(event, shortcut) {
  const normalized = normalizeCommandShortcut(shortcut);
  if (!normalized || event.isComposing) return false;
  return event.ctrlKey === normalized.ctrl &&
    event.altKey === normalized.alt &&
    event.shiftKey === normalized.shift &&
    event.metaKey === normalized.meta &&
    normalizeShortcutKey(event.key) === normalized.key;
}

export function formatCommandShortcut(shortcut) {
  const normalized = normalizeCommandShortcut(shortcut);
  if (!normalized) return tr("未设置");
  const parts = [];
  if (normalized.ctrl) parts.push('Ctrl');
  if (normalized.alt) parts.push('Alt');
  if (normalized.shift) parts.push('Shift');
  if (normalized.meta) parts.push('Win');
  parts.push(formatShortcutKey(normalized.key));
  return parts.join('+');
}

function normalizeShortcutKey(key) {
  const text = String(key || '').trim();
  if (!text) return '';
  if (text === ' ') return 'space';
  if (text.length === 1) return text.toLowerCase();
  return text.toLowerCase();
}

function formatShortcutKey(key) {
  const text = String(key || '').trim().toLowerCase();
  if (text === 'space') return 'Space';
  if (text.startsWith('arrow')) return text.replace('arrow', 'Arrow');
  if (text.length === 1) return text.toUpperCase();
  return text.slice(0, 1).toUpperCase() + text.slice(1);
}

function isModifierKey(key) {
  return ['control', 'ctrl', 'alt', 'shift', 'meta', 'win', 'os'].includes(String(key || '').toLowerCase());
}
