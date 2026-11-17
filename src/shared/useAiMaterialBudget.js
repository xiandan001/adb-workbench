import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createMaterialBudgetQueue } from './aiMaterialBudget.js';

export default function useAiMaterialBudget({ current, mode, active }) {
  const [summary, setSummary] = useState(null), [retryNonce, setRetryNonce] = useState(0), latest = useRef(null), queue = useRef(null);
  useLayoutEffect(() => { latest.current = { current, mode, active }; }, [current, mode, active]);
  useEffect(() => {
    const instance = createMaterialBudgetQueue({ createWorker: () => new Worker(new URL('../workers/ai-material-budget-worker.js', import.meta.url), { type: 'module' }),
      onSummary(value) { const latestValue = latest.current;
        if (latestValue?.active && latestValue.mode !== 'task' && latestValue.current.caseId === value.caseId && latestValue.current.revision === value.revision) setSummary(value);
      } });
    queue.current = instance;
    return () => { queue.current = null; instance.dispose(); };
  }, []);
  const unknownSources = (mode === 'diagnose' ? current.checks.length : current.sourceIds.length)
    + (current.contextRef ? 1 : 0) + (current.handoffId ? 1 : 0) + (current.basketItems?.length || 0);
  useEffect(() => {
    if (!active || mode === 'task') { queue.current?.cancel(); return; }
    queue.current?.schedule({ caseId: current.caseId, revision: current.revision, text: mode === 'analysis' ? current.text : '', question: current.question, unknownSources });
    return () => queue.current?.cancel();
  }, [active, mode, current.caseId, current.revision, current.text, current.question, unknownSources, retryNonce]);
  return { summary: summary?.caseId === current.caseId && summary?.revision === current.revision ? summary : null,
    retry: () => { setSummary(null); setRetryNonce(value => value + 1); } };
}
