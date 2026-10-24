import { tr } from './i18n.js';
const STRONG_IDENTITY_KEYS = ['androidId', 'wifiMac', 'roBootSerialno', 'roSerialno'];
const TERMINAL_STEP_STATES = new Set(['success', 'failed']);

export function runDuration(run) {
  const start = Date.parse(run?.startedAt);
  const end = Date.parse(run?.endedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

function sameDevice(left, right) {
  let matched = false;
  for (const key of STRONG_IDENTITY_KEYS) {
    const a = left?.comparisonIdentity?.[key];
    const b = right?.comparisonIdentity?.[key];
    if (!a || !b) continue;
    if (a !== b) return false;
    matched = true;
  }
  return matched;
}

function matchDevices(before, after) {
  if (!before.length || before.length !== after.length) return null;
  const pairs = before.map(run => ({ before: run, matches: after.filter(other => sameDevice(run, other)) }));
  if (pairs.some(pair => pair.matches.length !== 1)) return null;
  if (new Set(pairs.map(pair => pair.matches[0])).size !== after.length) return null;
  return pairs.map(pair => ({ before: pair.before, after: pair.matches[0] }));
}

function validStepRecords(run, definitions) {
  const steps = run.steps || [];
  return new Set(steps.map(step => step.id)).size === steps.length && steps.every(step => (
    definitions[step.index]?.id === step.id && definitions[step.index]?.type === step.type
  ));
}

function compareStep(definition, before, after, deviceId) {
  const observed = TERMINAL_STEP_STATES.has(before?.status) && TERMINAL_STEP_STATES.has(after?.status);
  const beforeMs = runDuration(before);
  const afterMs = runDuration(after);
  let change = 'unobserved';
  if (observed) {
    change = before.status === after.status ? (after.status === 'failed' ? 'still-failing' : 'unchanged')
      : after.status === 'failed' ? 'new-failure' : 'recovered';
  }
  return {
    id: `${deviceId}:${definition.id}`, label: definition.label || definition.type, deviceId,
    before: before || null, after: after || null, beforeMs, afterMs, change,
    deltaMs: observed && beforeMs !== null && afterMs !== null ? afterMs - beforeMs : null
  };
}

export function compareTaskRuns(before, after) {
  const reject = reason => ({ comparable: false, reason, steps: [] });
  if (!before || !after) return reject(tr("请选择两次运行：左侧为基准，右侧为本次。"));
  if (before.id === after.id) return reject(tr("请选择两条不同的运行记录。"));
  if (before.mode !== 'replay' || after.mode !== 'replay') return reject(tr("当前只比较普通回放，自动化压测请查看各自报告。"));
  if (![before, after].every(run => ['success', 'failed', 'cancelled'].includes(run.status))) return reject(tr("请选择已经结束的运行记录，运行中的数据仍在变化。"));
  if (![before, after].every(run => run.comparisonVersion === 1 && run.scriptId && run.scriptHash && Array.isArray(run.scriptSteps) && run.scriptSteps.length)) {
    return reject(tr("这两条记录中有旧版记录，缺少脚本版本或步骤身份。请在 4.3.0 及以上版本重新运行后比较。"));
  }
  if (before.scriptId !== after.scriptId || before.scriptHash !== after.scriptHash) {
    return reject(tr("脚本或运行参数不同，不能将结果变化判定为新增失败或恢复。请比较同一脚本、同一内容和运行参数的记录。"));
  }
  const definitions = before.scriptSteps;
  if (new Set(definitions.map(step => step.id)).size !== definitions.length || definitions.some(step => !step.id)
    || JSON.stringify(definitions.map(({ id, type }) => ({ id, type }))) !== JSON.stringify(after.scriptSteps.map(({ id, type }) => ({ id, type })))) {
    return reject(tr("步骤身份缺失、重复或不一致，无法安全比较。"));
  }
  const pairs = matchDevices(before.deviceRuns || [], after.deviceRuns || []);
  if (!pairs) return reject(tr("设备不一致或无法唯一确认设备身份。仅连接地址相同不足以证明是同一台设备，请在原设备上重新运行。"));
  if (pairs.some(pair => !validStepRecords(pair.before, definitions) || !validStepRecords(pair.after, definitions))) {
    return reject(tr("运行中的步骤与脚本版本不一致，无法安全比较。"));
  }
  const steps = pairs.flatMap(pair => {
    const previous = new Map((pair.before.steps || []).map(step => [step.id, step]));
    const current = new Map((pair.after.steps || []).map(step => [step.id, step]));
    return definitions.map(step => compareStep(step, previous.get(step.id), current.get(step.id), pair.after.deviceId));
  });
  return {
    comparable: true, reason: '', steps,
    newFailures: steps.filter(step => step.change === 'new-failure').length,
    recovered: steps.filter(step => step.change === 'recovered').length,
    unobserved: steps.filter(step => step.change === 'unobserved').length,
    beforeMs: runDuration(before), afterMs: runDuration(after)
  };
}
