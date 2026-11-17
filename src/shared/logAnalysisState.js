export const LOG_ANALYSIS_PROMPT_LIMIT = 4000;
export const isLogAnalysisAnswer = content => typeof content === 'string' && content.trim().length > 0;
export const isLogAnalysisTerminal = status => ['completed', 'cancelled', 'stopped', 'failed', 'empty'].includes(status);
export function retireLogAnalysisRequest(operation, id) {
  if (!id) return;
  operation.retired.add(id);
  while (operation.retired.size > 32) operation.retired.delete(operation.retired.values().next().value);
}
export function logAnalysisPhase(phase) {
  return ['preparing', 'awaiting-confirmation', 'sending'].includes(phase) ? phase : 'preparing';
}
export function logAnalysisAttemptMatches(attempt, documentId, sourceIdentity, requestId) {
  return Boolean(attempt && attempt.documentId === documentId && attempt.sourceIdentity === sourceIdentity
    && (requestId === undefined || Boolean(requestId) && attempt.requestId === requestId));
}
export function submitLogAnalysisKey(event, { busy, disabled, composing = false }) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229 || composing || busy || disabled) return false;
  event.preventDefault(); return true;
}
