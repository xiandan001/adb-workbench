import { useCallback, useState } from 'react';
import { tr, useLocale } from '../shared/i18n';
import { readQualityDraft, writeQualityDraft } from '../shared/qualityDraft';
import QualityCenter from './QualityCenter';

export default function QualityWorkspace(props) {
  useLocale();
  const deviceId = props.activeDeviceId || '';
  return <DeviceQualityDraft key={deviceId} {...props} deviceKey={deviceId} />;
}
function DeviceQualityDraft({ deviceKey, ...props }) {
  useLocale();
  const [initialDraft] = useState(() => readQualityDraft(localStorage, deviceKey));
  const [failed, setFailed] = useState(false);
  const persist = useCallback(form => { if (deviceKey) setFailed(!writeQualityDraft(localStorage, deviceKey, form)); }, [deviceKey]);
  return <>
    <p className={`mb-3 text-xs ${props.theme.textMuted}`}>{tr('本机保留最近 10 台设备的验证草稿；切换页面可继续，不会自动执行。')}</p>
    {failed && <p role="alert" className="mb-3 text-xs text-amber-500">{tr('验证草稿暂时无法保存，请保留当前页面后重试。')}</p>}
    <QualityCenter {...props} initialDraft={initialDraft} onDraftChange={persist} />
  </>;
}
