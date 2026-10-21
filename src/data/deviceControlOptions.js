const COLORS = [
  ['emerald', '翠绿'], ['cyan', '青色'], ['blue', '蓝色'], ['pink', '粉色'], ['rose', '玫红'],
  ['green', '绿色'], ['orange', '橙色'], ['amber', '琥珀'], ['purple', '紫色'], ['red', '红色']
];

export function gradientOptions(position, current) {
  const options = COLORS.map(([color, label]) => ({ value: `${position}-${color}-${position === 'from' ? '400' : '500'}`, label }));
  if (current && !options.some(option => option.value === current)) options.unshift({ value: current, label: '当前渐变颜色' });
  return options;
}

export const CARD_BACKGROUNDS = [
  ['bg-white', '白色'], ['bg-slate-800/80', '深灰半透明'], ['bg-pink-50', '粉色'],
  ['bg-blue-50', '蓝色'], ['bg-green-50', '绿色'], ['bg-orange-50', '橙色'], ['bg-purple-50', '紫色']
].map(([value, label]) => ({ value, label }));

export const TERMINAL_BACKGROUNDS = [
  ['bg-[#202124]', '深灰'], ['bg-black', '纯黑'],
  ['bg-gradient-to-br from-pink-900 to-rose-900', '粉紫渐变'],
  ['bg-gradient-to-br from-slate-800 to-slate-900', '灰渐变'],
  ['bg-gradient-to-br from-blue-900 to-slate-900', '蓝渐变'],
  ['bg-gradient-to-br from-green-900 to-slate-900', '绿渐变']
].map(([value, label]) => ({ value, label }));
