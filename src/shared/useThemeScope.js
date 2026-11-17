import { useLayoutEffect } from 'react';
import { applyThemeScope } from './neutralDarkScope.js';

export default function useThemeScope(theme) {
  useLayoutEffect(() => applyThemeScope(theme), [theme]);
}
