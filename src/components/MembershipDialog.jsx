import { useLayoutEffect, useRef } from 'react';
import { Lock } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n';
import { trapAppMessageFocus } from '../shared/appMessageDialog';
import { canUseMembershipFeature } from '../shared/membershipEntitlements';
import MemberCenter from './MemberCenter';

export default function MembershipDialog({ feature, capability, theme, status, onRetry, onActivated, onReturn, showToast }) {
  useLocale();
  const dialog = useRef(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);

  return <dialog ref={dialog} aria-label={tr('会员中心')} onKeyDown={trapAppMessageFocus}
    onCancel={event => {
      event.preventDefault();
      const back = event.currentTarget.querySelector('[data-membership-return]');
      if (back && !back.disabled) back.click();
    }}
    className={`m-auto max-h-[calc(100dvh-2rem)] w-[min(64rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border p-4 shadow-2xl backdrop:bg-black/55 sm:p-6 ${theme.card} ${theme.text}`}>
    {feature && (!capability || !canUseMembershipFeature(status, capability)) && <p className="mb-4 flex items-center gap-2 break-words text-sm"><Lock size={15} className="shrink-0 text-amber-500" />{tr('{0}需要会员版', { 0: feature })}</p>}
    <MemberCenter theme={theme} vipStatus={status} capability={capability} onRetry={onRetry} onActivated={onActivated} onReturn={onReturn} showToast={showToast} />
  </dialog>;
}
