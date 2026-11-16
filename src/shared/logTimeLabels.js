import { getLocale, tr } from './i18n.js';

export function logClockLabel(basis) {
  if (basis === 'received' || basis === 'host-received') return tr('本机接收时间');
  if (basis === 'explicit-offset') return tr('日志时间（含时区）');
  if (basis === 'mixed') return tr('混合时间基准，未比较先后');
  if (basis?.includes('year-unknown')) return tr('设备本地时间（年份未知）');
  return basis && basis !== 'unknown' ? tr('日志本地时间（时区未核实）') : tr('时间未知');
}
export function logTimeText(value, reliableDate = true) {
  if (!Number.isFinite(value)) return tr('时间未知');
  const options = reliableDate ? { dateStyle: 'short', timeStyle: 'medium' } : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' };
  return new Date(value).toLocaleString(getLocale(), options);
}
export function logTimeWarningText(code) {
  return { TIME_ANCHOR_UNKNOWN: tr('所选时间基准没有可用时间，未假造时间范围。'), UNKNOWN_TIME_EXCLUDED: tr('部分记录没有所选时间基准，未纳入时间筛选。'),
    SOURCE_LOCAL_TIME: tr('日志本地时区尚未核实，不据此判断跨设备先后。'), SOURCE_YEAR_UNKNOWN: tr('日志未提供年份；仅使用同一来源内的相对时间，不作绝对日期或跨设备判断。') }[code] || '';
}
