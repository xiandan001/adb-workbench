import { useEffect } from 'react';
import { tr, useLocale } from '../shared/i18n.js';

export default function LogWindowTitle() {
  const locale = useLocale();
  useEffect(() => { document.title = tr('AI 日志助手', {}, locale); }, [locale]);
  return null;
}
