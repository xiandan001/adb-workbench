import { tr } from './i18n.js';
import catalog from '../../electron/lib/rs232-protocol-catalog.json' with { type: 'json' };

const commands = new Map(catalog.commands.map(command => [command.id, command]));
export function serialTransactionRecord(entries, id) {
  let low = 0, high = entries.length;
  while (low < high) { const middle = (low + high) >>> 1; if (entries[middle].id < id) low = middle + 1; else high = middle; }
  return entries[low]?.id === id ? entries[low] : undefined;
}
export function mergeSerialTransactions(current = [], incoming = {}, replace = false) {
  if (!Object.hasOwn(incoming, 'transactions')) return current;
  const first = incoming.firstTransactionId, last = incoming.lastTransactionId;
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first) return [];
  const values = new Map((replace ? [] : current).filter(item => item.id >= first && item.id <= last).map(item => [item.id, item]));
  for (const item of incoming.transactions || []) if (Number.isSafeInteger(item.id) && item.id >= first && item.id <= last) values.set(item.id, item);
  return [...values.values()].sort((a, b) => a.id - b.id).slice(-200);
}
export function serialTransactionsComplete(rows, incoming) {
  if (!Object.hasOwn(incoming, 'transactions')) return true;
  const first = incoming.firstTransactionId, last = incoming.lastTransactionId;
  return first === 0 && last === 0 ? rows.length === 0 : rows.length === last - first + 1 && rows[0]?.id === first && rows.at(-1)?.id === last;
}
export const serialTransactionName = (item, locale) => commands.get(item.commandId)?.labels?.[locale] || item.commandId;
export function serialTransactionStatus(item) {
  return ({ writing: tr('正在写入，等待回复'), waiting: tr('等待关联回复'), 'reply-before-write': tr('回复已到，写入结果待确认'), matched: tr('收到关联回复'), timeout: tr('5 秒内未收到唯一关联回复'), ambiguous: tr('同码请求无法唯一关联'), 'write-failed': tr('写入结果不确定'), 'session-ended': tr('会话已结束，回复未确认') })[item.status] || tr('状态未知');
}
export function serialTransactionValue(item) {
  if (!Number.isInteger(item.value)) return '';
  const label = item.valueKind === 'power' ? [tr('待机'), tr('开机'), tr('休眠')][item.value]
    : item.valueKind === 'mute' ? [tr('静音'), tr('非静音')][item.value]
      : item.valueKind === 'volume' && item.value <= 100 ? tr('音量 {0}', { 0: item.value }) : '';
  return label || tr('未识别状态值 0x{0}', { 0: item.value.toString(16).toUpperCase().padStart(2, '0') });
}
