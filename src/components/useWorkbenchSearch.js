import { useEffect, useState } from 'react';
import { tr, useLocale } from '../shared/i18n';
import { searchRecords } from '../shared/workbenchSearch';

export default function useWorkbenchSearch(open) {
  const locale = useLocale();
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let current = true;
    const api = window.electronAPI;
    const readers = [
      ['artifacts', api?.artifactsList, value => value.items],
      ['reports', api?.aiWorkspaceHistoryList, value => value.items],
      ['cases', api?.aiWorkspaceCasebookList && (() => api.aiWorkspaceCasebookList({})), value => value.items],
      ['tasks', api?.taskState, value => [...(value.activeTasks || []), ...(value.history || [])]],
    ].filter(([, read]) => typeof read === 'function');
    const metadata = {};
    const load = async () => {
      await Promise.resolve();
      if (!current) return;
      setRecords([]); setError(''); setLoading(readers.length > 0);
      const results = await Promise.allSettled(readers.map(async ([key, read, items]) => {
        const result = await read();
        if (!current) return;
        if (!result?.ok) throw new Error(tr('部分本地记录暂时无法读取，重新打开搜索可重试。'));
        metadata[key] = items(result);
        setRecords(searchRecords(metadata));
      }));
      if (!current) return;
      if (results.some(result => result.status === 'rejected')) setError(tr('部分本地记录暂时无法读取，重新打开搜索可重试。'));
      setLoading(false);
    };
    void load();
    return () => { current = false; };
  }, [open, locale]);
  return { records, loading, error };
}
