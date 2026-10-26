const { tr } = require('./localization.cjs');
const { sanitize } = require('./ai-workspace-evidence.cjs');
const invalid = () => Object.assign(new Error(tr('测试要求无效或过长。')), { code: 'AI_TASK_INPUT', safe: true });
function requirements(value = {}) {
  const max = { application: 200, preconditions: 1000, target: 200, expectedResult: 1000 };
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !Object.hasOwn(max, key))) throw invalid();
  return Object.fromEntries(Object.entries(max).map(([key, limit]) => {
    const text = value[key] ?? '';
    if (typeof text !== 'string' || text.length > limit) throw invalid();
    return [key, sanitize(text.trim())];
  }));
}
function validateInteractions(draft, supplied) {
  const keyNames = { 3: 'HOME', 4: 'BACK', 19: 'DPAD_UP', 20: 'DPAD_DOWN', 21: 'DPAD_LEFT', 22: 'DPAD_RIGHT', 23: 'DPAD_CENTER', 61: 'TAB', 66: 'ENTER', 67: 'DEL', 111: 'ESCAPE', 122: 'MOVE_HOME', 123: 'MOVE_END', 187: 'APP_SWITCH' };
  const pairs = new Set();
  for (const match of supplied.matchAll(/(?:\(|（)\s*(\d{1,5})\s*[,，]\s*(\d{1,5})\s*(?:\)|）)/g)) pairs.add(`${Number(match[1])},${Number(match[2])}`);
  for (const match of supplied.matchAll(/\bx\s*[:=]\s*(\d{1,5})\s*[,，;\s]+y\s*[:=]\s*(\d{1,5})\b/gi)) pairs.add(`${Number(match[1])},${Number(match[2])}`);
  const namedKeys = new Set([...supplied.matchAll(/\b(?:KEYCODE_)?(HOME|BACK|DPAD_UP|DPAD_DOWN|DPAD_LEFT|DPAD_RIGHT|DPAD_CENTER|TAB|ENTER|DEL|ESCAPE|MOVE_HOME|MOVE_END|APP_SWITCH)\b/g)].map(match => match[1]));
  const bad = () => Object.assign(new Error(tr('草案包含未提供的操作参数，请补充信息后重新生成。')), { code: 'AI_TASK_INPUT', safe: true });
  for (const step of draft.steps) {
    if (Object.hasOwn(step, 'x') && !pairs.has(`${step.x},${step.y}`)) throw bad();
    if (Object.hasOwn(step, 'endX') && !pairs.has(`${step.endX},${step.endY}`)) throw bad();
    if (Object.hasOwn(step, 'text') && !supplied.includes(step.text.trim())) throw bad();
    if (step.type === 'keyevent' && !namedKeys.has(keyNames[step.keyCode])) throw bad();
  }
}
module.exports = { requirements, validateInteractions };
