import { tr } from './i18n.js';
import { compareTaskRuns as compare, taskComparisonSummary as summarize } from '../../electron/lib/task-run-comparison.mjs';
export { runDuration, recommendTaskComparison } from '../../electron/lib/task-run-comparison.mjs';
export const compareTaskRuns = (before, after) => compare(before, after, tr);
export const taskComparisonSummary = (before, after, comparison) => summarize(before, after, comparison, tr);
