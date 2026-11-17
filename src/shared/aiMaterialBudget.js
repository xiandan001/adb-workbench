import policy from '../../electron/lib/ai-context-limits.json' with { type: 'json' };

export const MATERIAL_LIMIT = policy.contentBytes;
const encoder = new TextEncoder(), CHUNK = 65536;
const boundedId = value => typeof value === 'string' && value.length > 0 && value.length <= 100;
function quotedBytes(text) {
  let bytes = 2;
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + CHUNK, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    bytes += encoder.encode(JSON.stringify(text.slice(start, end))).length - 2;
    if (bytes > MATERIAL_LIMIT) return bytes;
    start = end;
  }
  return bytes;
}
export function measureDraftBudget(value) {
  const identity = { requestId: value?.requestId, caseId: value?.caseId, revision: value?.revision };
  const hasText = typeof value?.text === 'string', hasKnown = Number.isSafeInteger(value?.knownTextBytes) && value.knownTextBytes >= 0 && value.knownTextBytes <= MATERIAL_LIMIT * 8;
  if (!Number.isSafeInteger(identity.requestId) || identity.requestId < 1 || !boundedId(identity.caseId)
    || !Number.isSafeInteger(identity.revision) || identity.revision < 0 || hasText === hasKnown
    || typeof value.question !== 'string' || value.question.length > 4000 || !Number.isSafeInteger(value.unknownSources)
    || value.unknownSources < 0 || value.unknownSources > 64) return { ...identity, status: 'invalid' };
  // This is a strict subset of the raw source envelope checked by freeze.
  // Unknown buffered/device sources and later frozen metadata are not invented.
  const textBytes = hasKnown ? value.knownTextBytes : value.text ? encoder.encode('[{"kind":"text","text":').length + quotedBytes(value.text) + 2 : 0;
  const questionBytes = encoder.encode('{"question":').length + quotedBytes(value.question) + 1;
  const minimumBytes = Math.max(textBytes, questionBytes);
  return { ...identity, status: minimumBytes > MATERIAL_LIMIT ? 'over-limit' : 'ready', minimumBytes, textBytes,
    limitBytes: MATERIAL_LIMIT, unknownSources: value.unknownSources, complete: false };
}
export function validateMaterialPlan(value) {
  const fields = ['caseId', 'previewId', 'sourceBytes', 'requestCount', 'initialBatchCount', 'needsSummary', 'estimated'];
  if (!value || typeof value !== 'object' || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))
    || !boundedId(value.caseId) || !boundedId(value.previewId) || !Number.isSafeInteger(value.sourceBytes) || value.sourceBytes < 0 || value.sourceBytes > MATERIAL_LIMIT
    || !Number.isSafeInteger(value.requestCount) || value.requestCount < 1 || value.requestCount > 64
    || value.initialBatchCount !== Math.ceil(value.requestCount / 16) || typeof value.needsSummary !== 'boolean' || value.estimated !== true) return null;
  return { ...value };
}
export function createMaterialBudgetQueue({ createWorker, onSummary, setTimer = setTimeout, clearTimer = clearTimeout,
  setDeadline = setTimeout, clearDeadline = clearTimeout, delayMs = 500 } = {}) {
  let timer, active, cachedText, sequence = 0, disposed = false;
  const cancel = () => {
    clearTimer(timer); timer = undefined;
    if (active) { clearDeadline(active.deadline); active.worker.terminate(); active = null; }
  };
  const schedule = value => {
    if (disposed) return;
    cancel(); const sameText = cachedText?.caseId === value.caseId && cachedText.text === value.text;
    if (!sameText) cachedText = null;
    const input = { ...value, requestId: ++sequence };
    if (sameText) { input.knownTextBytes = cachedText.textBytes; delete input.text; }
    timer = setTimer(() => {
      timer = undefined; if (disposed) return;
      const fail = () => { if (active?.input === input) { cachedText = null; cancel(); onSummary({ requestId: input.requestId, caseId: input.caseId, revision: input.revision, status: 'unavailable' }); } };
      try {
        const worker = createWorker(); active = { worker, input };
        worker.onmessage = event => {
          if (disposed || active?.input !== input) return;
          const result = event.data;
          if (result?.requestId !== input.requestId || result.caseId !== input.caseId || result.revision !== input.revision
            || !['ready', 'over-limit', 'invalid'].includes(result.status)
            || result.status !== 'invalid' && (!Number.isSafeInteger(result.minimumBytes) || result.minimumBytes < 0 || result.minimumBytes > MATERIAL_LIMIT * 8
              || !Number.isSafeInteger(result.textBytes) || result.textBytes < 0 || result.textBytes > result.minimumBytes
              || sameText && result.textBytes !== input.knownTextBytes
              || result.limitBytes !== MATERIAL_LIMIT || result.unknownSources !== input.unknownSources || result.complete !== false)) { fail(); return; }
          cachedText = result.status === 'invalid' ? null : { caseId: input.caseId, text: value.text, textBytes: result.textBytes };
          cancel(); onSummary(result);
        };
        worker.onerror = fail; worker.onmessageerror = fail;
        active.deadline = setDeadline(fail, 10000); worker.postMessage(input);
      } catch { cachedText = null; if (active?.input === input) fail(); else onSummary({ requestId: input.requestId, caseId: input.caseId, revision: input.revision, status: 'unavailable' }); }
    }, delayMs);
  };
  return { schedule, cancel, dispose() { disposed = true; cachedText = null; cancel(); } };
}
