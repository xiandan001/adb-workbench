const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_LOG_BYTES = 512 * 1024;
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const SELECTOR_KEYS = ['taskId', 'deviceId', 'stepIndex', 'stepId', 'roundIndex'];

function validTaskStepReference(input) {
  return input && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).length === SELECTOR_KEYS.length && SELECTOR_KEYS.every(key => Object.hasOwn(input, key)) &&
    typeof input.taskId === 'string' && /^[\w.-]{1,180}$/.test(input.taskId) &&
    typeof input.deviceId === 'string' && input.deviceId.length > 0 && input.deviceId.length <= 512 &&
    typeof input.stepId === 'string' && input.stepId.length > 0 && input.stepId.length <= 512 &&
    Number.isSafeInteger(input.stepIndex) && input.stepIndex >= 0 &&
    (input.roundIndex === null || (Number.isSafeInteger(input.roundIndex) && input.roundIndex > 0));
}

function resolvedStepIndex(task, step) {
  if (Number.isSafeInteger(step.index)) return step.index;
  const declared = task.scriptSteps || [];
  const found = declared.flatMap((part, index) => part.id === step.id ? [index] : []);
  return found.length === 1 ? found[0] : null;
}

function findStep(task, input) {
  if (!validTaskStepReference(input) || task?.id !== input.taskId || (task.mode === 'stress') !== (input.roundIndex !== null)) return null;
  const runs = (task.deviceRuns || []).filter(run => (run.originalDeviceId || run.deviceId) === input.deviceId);
  if (runs.length !== 1) return null;
  const [run] = runs;
  const matches = step => step.id === input.stepId && resolvedStepIndex(task, step) === input.stepIndex;
  const flat = (run.steps || []).filter(step => (step.roundIndex ?? null) === input.roundIndex && matches(step));
  if (flat.length) return flat.length === 1 ? flat[0] : null;
  const rounds = (run.stressRounds || []).filter(round => round.index === input.roundIndex);
  if (input.roundIndex === null || rounds.length !== 1) return null;
  const nested = (rounds[0].steps || []).filter(step => (step.roundIndex ?? input.roundIndex) === input.roundIndex && matches(step));
  return nested.length === 1 ? nested[0] : null;
}

function normalizedEvidencePath(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return '';
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function uniquelyOwnedEvidencePath(task, input, file) {
  const normalized = normalizedEvidencePath(file);
  if (!normalized) return '';
  const belongsToOtherStep = (run, step, roundIndex) =>
    [step.artifact, step.screenshotArtifact].some(value => normalizedEvidencePath(value) === normalized) &&
    ((run.originalDeviceId || run.deviceId) !== input.deviceId || step.id !== input.stepId ||
      resolvedStepIndex(task, step) !== input.stepIndex || roundIndex !== input.roundIndex);
  for (const run of task.deviceRuns || []) {
    if ((run.steps || []).some(step => belongsToOtherStep(run, step, step.roundIndex ?? null))) return '';
    for (const round of run.stressRounds || []) {
      if ((round.steps || []).some(step => belongsToOtherStep(run, step, step.roundIndex ?? round.index))) return '';
    }
  }
  return file;
}

const within = (root, file) => {
  const relative = path.relative(root, file);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

async function readOwnedStepFile(root, file, extension, maxBytes, canTruncate = false) {
  if (typeof file !== 'string' || typeof root !== 'string' || !path.isAbsolute(file) || !path.isAbsolute(root) ||
    path.extname(file).toLowerCase() !== extension || !within(root, file)) return null;
  try {
    const canonicalRoot = await fs.realpath(root);
    const canonicalFile = await fs.realpath(file);
    if (!within(canonicalRoot, canonicalFile)) return null;
    const target = await fs.lstat(file);
    if (!target.isFile() || target.isSymbolicLink() || (!canTruncate && target.size > maxBytes)) return null;
    const handle = await fs.open(canonicalFile, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (!canTruncate && stat.size > maxBytes) || target.ino !== stat.ino || target.dev !== stat.dev) return null;
      const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== buffer.length) return null;
      return { buffer, truncated: stat.size > maxBytes };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function readTaskStepEvidence(task, input) {
  const step = findStep(task, input);
  if (!step) return { screenshot: '', logText: '', logTruncated: false };
  const artifact = uniquelyOwnedEvidencePath(task, input, step.artifact);
  const [image, log] = await Promise.all([
    readOwnedStepFile(task.artifactDir, uniquelyOwnedEvidencePath(task, input, step.screenshotArtifact || step.artifact), '.png', MAX_IMAGE_BYTES),
    readOwnedStepFile(task.artifactDir, artifact, '.log', MAX_LOG_BYTES, true),
  ]);
  return {
    screenshot: image?.buffer.subarray(0, PNG_HEADER.length).equals(PNG_HEADER) ? `data:image/png;base64,${image.buffer.toString('base64')}` : '',
    logText: log?.buffer.toString('utf8') || '',
    logTruncated: log?.truncated === true,
    ...(step.artifact && !artifact ? { artifactConflict: true } : {}),
  };
}

function taskStepLogIdentity(run, step) {
  return { deviceId: run.originalDeviceId || run.deviceId, stepId: step.id, stepIndex: step.index, roundIndex: step.roundIndex ?? null };
}

function taskEvidenceFileStem(prefix, deviceLabel, stamp) {
  return [prefix, deviceLabel, stamp, randomUUID()].filter(Boolean).join('-');
}

module.exports = { validTaskStepReference, readTaskStepEvidence, taskStepLogIdentity, taskEvidenceFileStem };
