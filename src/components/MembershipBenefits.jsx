import { useState } from 'react';
import { Brain, Check, ClipboardCheck, Crown, History, Lock, Minus, Package, Smartphone } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n';
import { isDarkTheme } from '../shared/theme';
import { getMembershipBenefitGroups, readMembershipComparison, saveMembershipComparison } from '../shared/membershipBenefits.js';

const groupIcons = { devices: Smartphone, packages: Package, quality: ClipboardCheck, ai: Brain, records: History };

function FeatureValue({ value }) {
  const isAvailable = value === true;
  const isUnavailable = value === false;
  return (
    <span className="inline-flex min-w-0 items-center justify-center gap-1.5">
      {isAvailable && <Check size={14} className="shrink-0 text-emerald-500" aria-hidden="true" />}
      {isUnavailable && <Minus size={14} className="shrink-0 opacity-60" aria-hidden="true" />}
      <span className="[overflow-wrap:anywhere]">{isAvailable ? tr("可用") : isUnavailable ? tr("不可用") : value}</span>
    </span>
  );
}

export default function MembershipBenefits({ theme }) {
  useLocale();
  const isDark = isDarkTheme(theme);
  const [showAll, setShowAll] = useState(() => readMembershipComparison());
  const groups = getMembershipBenefitGroups(showAll);
  const changeView = (next) => {
    setShowAll(next);
    saveMembershipComparison(next);
  };
  return (
    <section aria-labelledby="membership-benefits-heading" className={`min-w-0 rounded-xl border p-4 shadow-sm sm:p-5 ${isDark ? 'border-[#3E4145] bg-slate-800/80' : 'border-slate-200 bg-white'}`}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="membership-benefits-heading" className={`text-lg font-semibold ${theme.text}`}>{tr("权益对比")}</h3>
          <p className={`mt-1 text-xs ${theme.textMuted}`}>{tr("按常用场景整理基础版与会员版差异")}</p>
        </div>
        <div className={`flex max-w-full flex-wrap gap-1 rounded-lg border p-1 ${isDark ? 'border-[#3E4145] bg-[#2D2F33]' : 'border-slate-200 bg-slate-50'}`}>
          {[[false, tr("只看差异")], [true, tr("查看全部")]].map(([value, label]) => (
            <button key={String(value)} type="button" aria-pressed={showAll === value}
              onClick={() => changeView(value)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 ${showAll === value ? theme.button.primary : theme.button.secondary}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className={`overflow-hidden rounded-lg border ${isDark ? 'border-[#3E4145]' : 'border-slate-200'}`}>
        <table className="w-full table-fixed border-collapse text-sm [overflow-wrap:anywhere]">
          <colgroup><col className="w-[40%]" /><col className="w-[30%]" /><col className="w-[30%]" /></colgroup>
          <thead className={isDark ? 'bg-[#2D2F33]' : 'bg-slate-50'}>
            <tr className={`text-xs ${theme.textMuted}`}>
              <th scope="col" className="px-2.5 py-3 text-start sm:px-4">{tr("功能场景")}</th>
              <th scope="col" className="px-1.5 py-3"><span className="inline-flex items-center gap-1"><Lock size={13} className="shrink-0" aria-hidden="true" />{tr("基础版")}</span></th>
              <th scope="col" className={`px-1.5 py-3 ${isDark ? 'text-amber-400' : 'text-amber-700'}`}><span className="inline-flex items-center gap-1"><Crown size={13} className="shrink-0" aria-hidden="true" />{tr("会员版")}</span></th>
            </tr>
          </thead>
          {groups.map(group => {
            const Icon = groupIcons[group.id];
            const border = isDark ? 'border-[#3E4145]' : 'border-slate-100';
            return (
              <tbody key={group.id}>
                <tr className={`border-t ${border} ${isDark ? 'bg-[#202124]/50' : 'bg-slate-50/70'}`}>
                  <th scope="rowgroup" colSpan={3} className={`px-2.5 py-2.5 text-start sm:px-4 ${theme.text}`}>
                    <span className="flex items-center gap-2"><Icon size={15} className="shrink-0 text-amber-500" aria-hidden="true" />{group.title}</span>
                  </th>
                </tr>
                {group.items.map(item => (
                  <tr key={item.id} className={`border-t ${border}`}>
                    <th scope="row" className={`px-2.5 py-2.5 text-start font-normal sm:px-4 ${theme.text}`}>{item.name}</th>
                    <td className={`px-1.5 py-2.5 text-center text-xs ${theme.textMuted}`}><FeatureValue value={item.free} /></td>
                    <td className={`px-1.5 py-2.5 text-center text-xs ${isDark ? 'text-amber-400' : 'text-amber-700'}`}><FeatureValue value={item.vip} /></td>
                  </tr>
                ))}
              </tbody>
            );
          })}
        </table>
      </div>
      <p className={`mt-3 text-xs leading-5 ${theme.textMuted}`}>{tr("会员到期后，仍可在 AI 工具管理中停止本地路由，并恢复已有的受支持备份。")}</p>
    </section>
  );
}
