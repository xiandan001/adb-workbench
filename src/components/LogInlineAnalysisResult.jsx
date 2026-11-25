import { useMemo } from 'react';
import { tr, useLocale } from '../shared/i18n.js';
import { splitLogAnalysisSections } from '../shared/logInlineAnalysis.js';
import LogEvidence from './LogEvidence.jsx';

export default function LogInlineAnalysisResult({ content, allowedRefs, evidence, isDark = false, renderMarkdown, onLocateEvidence }) {
  useLocale(); const result = useMemo(() => splitLogAnalysisSections(content), [content]);
  const render = text => renderMarkdown ? renderMarkdown(text) : <pre className="whitespace-pre-wrap break-words text-sm leading-6">{text}</pre>;
  if (!result.structured) return <div>{render(result.fullText)}<LogEvidence content={result.fullText} allowedRefs={allowedRefs} evidence={evidence} isDark={isDark} onLocate={onLocateEvidence} /></div>;
  return <div className="space-y-3">
    <p className={`text-[11px] leading-5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{tr('以下分区沿用 AI 返回的实际标题，不代表推测已被证实。')}</p>
    {result.sections.map((section, index) => <section key={index} className="min-w-0 rounded-lg border border-slate-400/20 p-3">{section.heading && <h4 className="mb-2 break-words text-sm font-semibold">{section.heading}</h4>}{render(section.content)}<LogEvidence content={section.content} allowedRefs={allowedRefs} evidence={evidence} isDark={isDark} onLocate={onLocateEvidence} /></section>)}
    <details className="rounded-lg border border-slate-400/20 p-3"><summary className="cursor-pointer text-xs font-medium">{tr('查看完整原始分析报告')}</summary><div className="mt-3">{render(result.fullText)}</div></details>
  </div>;
}
