import { tr } from './i18n.js';
import { prepareSavedTaskRun } from './taskQuickRun.js';
import { decodeRecordedSwipePath } from './taskRecorderGesture.js';

export const TASK_PACKAGE_PLACEHOLDER = '__PACKAGE_NAME__';
const MONKEY_LAUNCH = /^(\s*monkey\s+-p\s+)([^\r\n;|&<>"']+?)(\s+1\s*)$/i;

export function getTaskRequiredFields(script) {
  const fields = [];
  (script.steps || []).forEach((step, index) => {
    const add = (name, label, value, patch, missing = !String(value || '').trim()) => {
      fields.push({ key: `step-${index}-${name}`, index, name, label, value: value || '', patch, missing });
    };
    const harmony = script.targetPlatform === 'harmony';
    if (step.type === 'installApk') {
      add('localPath', harmony ? tr('HAP/HSP 路径') : tr('APK 路径'), step.localPath, localPath => ({ localPath }));
    } else if (step.type === 'imageCompare') {
      add('baselinePath', tr('基准图路径'), step.baselinePath, baselinePath => ({ baselinePath }));
    } else if (step.type === 'launchApp') {
      add('packageName', tr('Bundle 名称'), step.packageName, packageName => ({ packageName }));
    } else if (!harmony && step.type === 'shell') {
      const match = MONKEY_LAUNCH.exec(step.command || '');
      if (match) {
        const value = match[2].trim();
        const missing = !/^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+$/.test(value);
        add('packageName', tr('应用包名'), value === TASK_PACKAGE_PLACEHOLDER ? '' : value, input => ({ command: `${match[1]}${input.replace(/[\r\n;|&<>"']/g, '').trim() || TASK_PACKAGE_PLACEHOLDER}${match[3]}` }), missing);
      }
    }
  });
  return fields;
}

export function getTaskReadiness(script, deviceIds, devices) {
  const issue = getTaskRequiredFields(script).find(field => field.missing);
  if (issue) return { ready: false, issue };
  const invalidSwipe = (script.steps || []).findIndex(step => {
    if (step.type !== 'swipe') return false;
    const stored = step.points || step.curvePoints || step.pathPoints;
    const hasPath = typeof stored === 'string' ? Boolean(stored.trim()) : Boolean(stored?.length);
    if (hasPath) return decodeRecordedSwipePath(stored).length < 2;
    return [step.x, step.y, step.endX, step.endY].some(value => value === '' || value == null || !Number.isFinite(Number(value)));
  });
  if (invalidSwipe >= 0) return { ready: false, issue: { key: `edit-step-${invalidSwipe}`, label: tr('请填写滑动坐标或修正曲线路径。') } };
  try {
    prepareSavedTaskRun({ script, deviceIds, devices });
  } catch (failure) {
    const key = failure.message === tr('请先添加测试步骤。') ? 'steps' : 'targets';
    return { ready: false, issue: { key, label: failure.message } };
  }
  return { ready: true, issue: null };
}
