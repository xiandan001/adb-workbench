import { tr } from '../shared/i18n.js';
// 主题配置（6 套内置主题 + 字段说明）
// 每套主题包含：name/preview/primary/card/header/button{textMuted/input/terminal 等

const themes = {
  default: {
    get name() { return tr("简约默认"); },
    preview: 'bg-slate-50 border-slate-200',
    primary: 'emerald',
    card: 'bg-white border-slate-200',
    header: 'bg-white border-b border-slate-200',
    button: {
      primary: 'bg-emerald-500 hover:bg-emerald-600 text-white',
      secondary: 'bg-slate-100 hover:bg-slate-200 text-slate-700',
      outline: 'border border-slate-200 hover:border-emerald-400 text-slate-700'
    },
    text: 'text-slate-700',
    textMuted: 'text-slate-400',
    input: 'border-slate-200 bg-white',
      terminal: {
        bg: 'bg-[#202124]',
        output: 'bg-[#0D0E10]',
        text: 'text-[#E8EAED]',
        accent: 'text-emerald-400'
      }
  },
  cute: {
    get name() { return tr("可爱甜心"); },
    preview: 'bg-pink-50 border-pink-200',
    primary: 'pink',
    card: 'bg-white border-pink-100',
    header: 'bg-gradient-to-r from-pink-100 to-rose-50 border-b border-pink-200',
    button: {
      primary: 'bg-gradient-to-r from-pink-400 to-rose-400 hover:from-pink-500 hover:to-rose-500 text-white shadow-lg shadow-pink-200',
      secondary: 'bg-pink-50 hover:bg-pink-100 text-pink-600 border border-pink-200',
      outline: 'border border-pink-200 hover:border-pink-400 text-pink-600'
    },
    text: 'text-pink-700',
    textMuted: 'text-pink-400',
    input: 'border-pink-200 bg-pink-50/50',
    terminal: {
      bg: 'bg-gradient-to-br from-pink-900 to-rose-900',
      output: 'bg-pink-950/50',
      text: 'text-pink-100',
      accent: 'text-rose-300'
    }
  },
  tech: {
    get name() { return tr("科技未来"); },
    preview: 'bg-[#202124] border-[#3E4145]',
    primary: 'cyan',
    card: 'bg-slate-800/80 border-[#3E4145]',
    header: 'bg-[#202124]/90 border-b border-[#3E4145] backdrop-blur',
    button: {
      primary: 'bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-400 hover:to-blue-400 text-white shadow-lg shadow-cyan-500/30',
      secondary: 'bg-[#3E4145] hover:bg-slate-600 text-cyan-300 border border-[#5F6368]',
      outline: 'border border-cyan-500/50 hover:border-cyan-400 text-cyan-400'
    },
    text: 'text-[#E8EAED]',
    textMuted: 'text-slate-400',
    input: 'border-[#5F6368] bg-[#2D2F33] text-[#E8EAED]',
    terminal: {
      bg: 'bg-black',
      output: 'bg-[#0D0E10]',
      text: 'text-cyan-300',
      accent: 'text-cyan-400'
    }
  },
  ocean: {
    get name() { return tr("清新海洋"); },
    preview: 'bg-gradient-to-br from-blue-50 to-teal-50 border-blue-200',
    primary: 'blue',
    card: 'bg-white/90 border-blue-100 backdrop-blur',
    header: 'bg-gradient-to-r from-blue-100 to-teal-50 border-b border-blue-200',
    button: {
      primary: 'bg-gradient-to-r from-blue-500 to-teal-500 hover:from-blue-400 hover:to-teal-400 text-white shadow-lg shadow-blue-200',
      secondary: 'bg-blue-50 hover:bg-blue-100 text-blue-600 border border-blue-200',
      outline: 'border border-blue-300 hover:border-blue-500 text-blue-600'
    },
    text: 'text-slate-700',
    textMuted: 'text-blue-400',
    input: 'border-blue-200 bg-blue-50/30',
    terminal: {
      bg: 'bg-gradient-to-br from-slate-800 to-slate-900',
      output: 'bg-slate-900/80',
      text: 'text-[#E8EAED]',
      accent: 'text-cyan-400'
    }
  },
  forest: {
    get name() { return tr("自然森林"); },
    preview: 'bg-green-50 border-green-200',
    primary: 'green',
    card: 'bg-white border-green-100',
    header: 'bg-gradient-to-r from-green-100 to-emerald-50 border-b border-green-200',
    button: {
      primary: 'bg-gradient-to-r from-green-600 to-emerald-500 hover:from-green-500 hover:to-emerald-400 text-white shadow-lg shadow-green-200',
      secondary: 'bg-green-50 hover:bg-green-100 text-green-600 border border-green-200',
      outline: 'border border-green-300 hover:border-green-500 text-green-600'
    },
    text: 'text-slate-700',
    textMuted: 'text-green-500',
    input: 'border-green-200 bg-green-50/30',
    terminal: {
      bg: 'bg-gradient-to-br from-slate-800 to-green-900',
      output: 'bg-slate-900/80',
      text: 'text-green-100',
      accent: 'text-green-400'
    }
  },
  sunset: {
    get name() { return tr("落日余晖"); },
    preview: 'bg-gradient-to-br from-orange-50 to-amber-50 border-orange-200',
    primary: 'orange',
    card: 'bg-white border-orange-100',
    header: 'bg-gradient-to-r from-orange-100 to-amber-50 border-b border-orange-200',
    button: {
      primary: 'bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-white shadow-lg shadow-orange-200',
      secondary: 'bg-orange-50 hover:bg-orange-100 text-orange-600 border border-orange-200',
      outline: 'border border-orange-300 hover:border-orange-500 text-orange-600'
    },
    text: 'text-slate-700',
    textMuted: 'text-orange-400',
    input: 'border-orange-200 bg-orange-50/30',
    terminal: {
      bg: 'bg-gradient-to-br from-slate-800 to-orange-900',
      output: 'bg-slate-900/80',
      text: 'text-orange-100',
      accent: 'text-amber-400'
    }
  }
};

export default themes;
