import { useState } from 'react';
import { tr, useLocale } from '../shared/i18n';
import { prepareLogHandoffContext } from '../shared/logHandoffContext';
import AiContextButton from './AiContextButton';

export default function LogFilterHandoff({ rows, deviceId, sourceTruncated = false, isDark = false }) {
  useLocale();
  const detailText = isDark ? 'text-slate-300' : 'text-slate-600';
  const [prepared, setPrepared] = useState(null), [created, setCreated] = useState(false);
  const describe = snapshot => tr('已准备最近 {0}/{1} 条筛选记录，{2} 行，{3} 字节。', {
    0: snapshot.retainedEntries, 1: snapshot.totalEntries, 2: snapshot.retainedLines, 3: snapshot.bytes,
  });
  const prepare = () => {
    const snapshot = prepareLogHandoffContext(rows, sourceTruncated);
    const { text, ...range } = snapshot;
    setPrepared(range); setCreated(false);
    const partial = snapshot.partialEntries ? tr('其中 {0} 条记录仅保留末尾片段。', { 0: snapshot.partialEntries }) : '';
    return { view: { origin: 'log-filter', deviceId: deviceId || '', text, truncated: snapshot.truncated,
      title: tr('日志筛选近期片段（{0}/{1} 条记录）', { 0: snapshot.retainedEntries, 1: snapshot.totalEntries }),
      question: `${describe(snapshot)}${partial}${tr('请仅分析这些局部内容，不要将其视为全部日志。')}` } };
  };
  return <div role="group" aria-label={tr('日志筛选上下文')} className="min-w-0 max-w-lg space-y-1">
    <AiContextButton disabled={!rows.length} context={prepare} onCreated={() => setCreated(true)} />
    <p className={`text-[11px] ${detailText}`}>{tr('仅带入最近最多 2,000 行 / 448 KiB；不会自动发送 AI。')}</p>
    {prepared && <p role="status" className={`break-words text-[11px] leading-5 ${detailText}`}>
      {describe(prepared)}{prepared.partialEntries > 0 && tr('其中 {0} 条记录仅保留末尾片段。', { 0: prepared.partialEntries })}
      {tr('仅代表上述局部内容，不是全部日志。')}{created && tr('已带入 AI 工作区；最终内容以脱敏预览为准。')}
    </p>}
  </div>;
}
