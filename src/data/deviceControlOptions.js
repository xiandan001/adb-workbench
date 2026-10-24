import { tr } from '../shared/i18n.js';
const COLORS = [
  ['emerald', tr("翠绿")], ['cyan', tr("青色")], ['blue', tr("蓝色")], ['pink', tr("粉色")], ['rose', tr("玫红")],
  ['green', tr("绿色")], ['orange', tr("橙色")], ['amber', tr("琥珀")], ['purple', tr("紫色")], ['red', tr("红色")]
];

export function gradientOptions(position, current) {
  const options = COLORS.map(([color, label]) => ({ value: `${position}-${color}-${position === 'from' ? '400' : '500'}`, label }));
  if (current && !options.some(option => option.value === current)) options.unshift({ value: current, label: tr("当前渐变颜色") });
  return options;
}

export const CARD_BACKGROUNDS = [
  ['bg-white', tr("白色")], ['bg-slate-800/80', tr("深灰半透明")], ['bg-pink-50', tr("粉色")],
  ['bg-blue-50', tr("蓝色")], ['bg-green-50', tr("绿色")], ['bg-orange-50', tr("橙色")], ['bg-purple-50', tr("紫色")]
].map(([value, label]) => ({ value, label }));

export const TERMINAL_BACKGROUNDS = [
  ['bg-[#202124]', tr("深灰")], ['bg-black', tr("纯黑")],
  ['bg-gradient-to-br from-pink-900 to-rose-900', tr("粉紫渐变")],
  ['bg-gradient-to-br from-slate-800 to-slate-900', tr("灰渐变")],
  ['bg-gradient-to-br from-blue-900 to-slate-900', tr("蓝渐变")],
  ['bg-gradient-to-br from-green-900 to-slate-900', tr("绿渐变")]
].map(([value, label]) => ({ value, label }));
