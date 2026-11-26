import { tr } from './i18n.js';
import catalog from '../../electron/lib/rs232-protocol-catalog.json' with { type: 'json' };
import tcl from '../../electron/lib/rs232-protocol-tcl.json' with { type: 'json' };
import { formatHex } from './serialFormat.js';

const commands = new Map([...catalog.commands, ...tcl.commands].map(command => [command.id, command]));
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
  if (item.protocol === 'tcl') return ({
    waiting: tr('已发送，等待接收回执'),
    accepted: tr('设备已接收，等待结果'),
    completed: tr('设备报告执行完成'),
    result: tr('设备已返回结果'),
    timeout: item.ackRecordId ? tr('等待执行结果超时') : tr('等待接收回执超时'),
    ambiguous: tr('TCL 应答无法唯一关联'),
    rejected: tr('设备拒绝执行'),
    'transport-error': tr('设备报告传输错误（未重发）'),
  })[item.status] || legacyStatus(item);
  return legacyStatus(item);
}
function legacyStatus(item) {
  return ({ writing: tr('正在写入，等待回复'), waiting: tr('等待关联回复'), 'reply-before-write': tr('回复已到，写入结果待确认'), matched: tr('收到关联回复'), timeout: tr('5 秒内未收到唯一关联回复'), ambiguous: tr('同码请求无法唯一关联'), 'write-failed': tr('写入结果不确定'), 'session-ended': tr('会话已结束，回复未确认') })[item.status] || tr('状态未知');
}
export function serialTransactionValue(item) {
  if (item.protocol === 'tcl' && Number.isSafeInteger(item.resultBytes) && typeof item.resultPreview === 'string') {
    return tr('结果 {0} B · {1}', { 0: item.resultBytes, 1: formatHex(item.resultPreview) + (item.resultPreview.length < 2 * item.resultBytes ? ' …' : '') });
  }
  if (!Number.isInteger(item.value)) return '';
  const label = item.valueKind === 'power' ? [tr('待机'), tr('开机'), tr('休眠')][item.value]
    : item.valueKind === 'mute' ? [tr('静音'), tr('非静音')][item.value]
      : item.valueKind === 'volume' && item.value <= 100 ? tr('音量 {0}', { 0: item.value }) : '';
  return label || tr('未识别状态值 0x{0}', { 0: item.value.toString(16).toUpperCase().padStart(2, '0') });
}

export function serialTransactionEvidence(item) {
  if (item.protocol !== 'tcl') return [['TX', item.txRecordId], ['RX', item.rxRecordId]];
  return [['TX', item.txRecordId], ['ACK1', item.ackRecordId], [tr('完成'), item.completionRecordId],
    [item.resultBytes === undefined ? 'RX' : 'ACK2', item.completionRecordId === item.rxRecordId ? 0 : item.rxRecordId]]
    .filter(([label, id]) => label === 'TX' || id);
}
