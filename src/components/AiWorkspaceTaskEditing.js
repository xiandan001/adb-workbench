export const TASK_EDIT_TYPES = ['delay', 'screenshot', 'perfSnapshot', 'tap', 'longPress', 'swipe', 'input', 'keyevent', 'waitText', 'assertText'];
export const TASK_EDIT_FIELDS = { delay: ['durationMs'], screenshot: [], perfSnapshot: [], tap: ['x', 'y'], longPress: ['x', 'y', 'durationMs'],
  swipe: ['x', 'y', 'endX', 'endY', 'durationMs'], input: ['text'], keyevent: ['keyCode'], waitText: ['text', 'timeoutMs'], assertText: ['text', 'timeoutMs'] };
const defaults = { x: 0, y: 0, endX: 0, endY: 0, durationMs: 1000, timeoutMs: 5000, text: '', keyCode: '4' };

export function editableTask(draft) {
  return { name: draft.name, description: draft.description, steps: draft.steps.map(step => ({ ...step })) };
}
export function newEditableStep(type = 'delay', platform = 'android') {
  return { type, label: type, ...Object.fromEntries(TASK_EDIT_FIELDS[type].map(key => [key, key === 'keyCode' && platform === 'harmony' ? 'Back' : defaults[key]])) };
}
export function moveEditableStep(steps, index, direction) {
  const destination = index + direction;
  if (destination < 0 || destination >= steps.length) return steps;
  const next = steps.slice(); [next[index], next[destination]] = [next[destination], next[index]]; return next;
}
