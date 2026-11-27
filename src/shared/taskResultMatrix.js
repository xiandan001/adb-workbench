const ACTIVE = new Set(['queued', 'running']);

const stepIndex = step => Number.isSafeInteger(step?.index) && step.index >= 0 ? step.index : null;
const roundNumber = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const deviceKey = run => run.originalDeviceId || run.deviceId;

function collectRounds(runs) {
  const values = runs.flatMap(run => [
    ...(run.stressRounds || []).map(round => roundNumber(round.index)),
    ...(run.steps || []).map(step => roundNumber(step.roundIndex)),
  ]);
  return [...new Set(values.filter(value => value !== null))].sort((a, b) => b - a);
}

function roundSteps(run, roundIndex, stress) {
  if (!stress) return run.steps || [];
  if (roundIndex === null) return [];
  const round = (run.stressRounds || []).find(item => item.index === roundIndex);
  return [...(round?.steps || []), ...(run.steps || []).filter(step => step.roundIndex === roundIndex)];
}

export function taskMatrixStepStatus(step) {
  switch (step?.status) {
    case 'failed': return 'failed';
    case 'skipped': return 'skipped';
    case 'cancelled': return 'cancelled';
    case 'success':
    case 'passed': return 'passed';
    case 'running': return 'running';
    case 'queued':
    case 'not-run': return 'not-run';
    default: return step?.error ? 'failed' : 'unknown';
  }
}

function orderedColumns(task, reported) {
  const steps = task.scriptSteps || [];
  const map = new Map(steps.map((step, index) => [`index:${index}`, { key: `index:${index}`, index, label: step.label || '' }]));
  const keyFor = step => {
    const index = stepIndex(step);
    if (index !== null) return `index:${index}`;
    const occurrences = typeof step.id === 'string' && step.id ? steps.flatMap((part, i) => part.id === step.id ? [i] : []) : [];
    return occurrences.length === 1 ? `index:${occurrences[0]}` : step.id ? `step:${step.id}` : null;
  };
  for (const step of reported) {
    const key = keyFor(step);
    if (!key || map.get(key)?.label) continue;
    map.set(key, { key, index: key.startsWith('index:') ? Number(key.slice(6)) : null, label: step.label || '' });
  }
  return { columns: [...map.values()].sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity)), keyFor };
}

function absentStatus(run, steps, column, roundIndex) {
  if (roundIndex === null) return 'not-run';
  const earliestRetained = collectRounds([run]).at(-1);
  if (earliestRetained && roundIndex < earliestRetained) return 'unavailable';
  // Flattened stress step records are bounded to 600, so a partially retained
  // earliest round may be missing prefixes that did in fact execute.
  const firstStep = Math.min(...steps.map(step => stepIndex(step) ?? Infinity));
  return (run.steps || []).length >= 600 && roundIndex === earliestRetained &&
    column.index !== null && column.index < firstStep ? 'unavailable' : 'not-run';
}

export function buildTaskResultMatrix(task, { onlyAbnormal = false, requestedRound = null } = {}) {
  const runs = task?.deviceRuns || [];
  const stress = task?.mode === 'stress';
  const rounds = stress ? collectRounds(runs) : [];
  const roundIndex = rounds.includes(requestedRound) ? requestedRound : (rounds[0] ?? null);
  const reported = runs.map(run => roundSteps(run, roundIndex, stress));
  const { columns, keyFor } = orderedColumns(task || {}, reported.flat());
  const rows = runs.map((run, index) => {
    const found = new Map(reported[index].map(step => [keyFor(step), step]));
    const running = ACTIVE.has(task.status) && ACTIVE.has(run.status);
    const cells = columns.map(column => {
      const step = found.get(column.key);
      const status = step ? taskMatrixStepStatus(step) : absentStatus(run, reported[index], column, roundIndex);
      const abnormal = status !== 'passed' && status !== 'running' && (status !== 'not-run' || !running);
      return { column, step, status, abnormal };
    });
    return { key: `${deviceKey(run) || ''}:${index}`, deviceId: deviceKey(run), label: run.deviceId || deviceKey(run), runStatus: run.status, cells };
  });
  if (!onlyAbnormal) return { rounds, roundIndex, rows, columns };
  const visible = new Set(rows.flatMap(row => row.cells.filter(cell => cell.abnormal).map(cell => cell.column.key)));
  return { rounds, roundIndex, columns: columns.filter(column => visible.has(column.key)),
    rows: rows.filter(row => row.cells.some(cell => cell.abnormal)).map(row => ({
      ...row, cells: row.cells.filter(cell => visible.has(cell.column.key)),
    })),
  };
}

export function findFirstTaskFailure(task) {
  const rounds = new Set();
  if (task?.mode === 'stress') {
    for (const run of task.deviceRuns || []) {
      for (const round of run.stressRounds || []) {
        if (roundNumber(round.index) && (round.steps || []).some(step => taskMatrixStepStatus(step) === 'failed')) rounds.add(round.index);
      }
      for (const step of run.steps || []) {
        if (roundNumber(step.roundIndex) && taskMatrixStepStatus(step) === 'failed') rounds.add(step.roundIndex);
      }
    }
  } else {
    rounds.add(null);
  }
  for (const requestedRound of [...rounds].sort((a, b) => a - b)) {
    const { rows, columns, roundIndex } = buildTaskResultMatrix(task, { requestedRound });
    for (let index = 0; index < columns.length; index += 1) {
      const row = rows.find(candidate => candidate.cells[index].step && candidate.cells[index].status === 'failed');
      if (row) return { row: row.key, column: columns[index].key, roundIndex };
    }
  }
  return null;
}

export function buildTaskStepEvidenceReference(taskId, row, cell, roundIndex) {
  const { step } = cell;
  if (!step || !row.deviceId || typeof step.id !== 'string' || !step.id) return null;
  const index = stepIndex(step) ?? cell.column.index;
  return Number.isSafeInteger(index) ? { taskId, deviceId: row.deviceId, stepIndex: index, stepId: step.id, roundIndex } : null;
}

export function taskStepLogs(logs, reference) {
  if (!reference) return [];
  return (logs || []).filter(line => line?.deviceId === reference.deviceId &&
    line.stepId === reference.stepId && line.stepIndex === reference.stepIndex &&
    (line.roundIndex ?? null) === reference.roundIndex && typeof line.message === 'string');
}
