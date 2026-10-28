// Cancelling an optional AI summary never erases its source job's evidence.
function bindSummaryLifetime(task) {
  const controller = new AbortController(), owner = task.sender, parent = task.signal;
  const abort = () => controller.abort();
  const navigate = (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) abort(); };
  task.aiSummaryController = controller;
  task.aiSummarySignal = controller.signal;
  owner?.once?.('destroyed', abort);
  owner?.on?.('did-start-navigation', navigate);
  parent?.addEventListener?.('abort', abort, { once: true });
  if (task.cancelled || parent?.aborted || owner?.isDestroyed?.()) abort();
  return { signal: controller.signal, dispose() {
    abort();
    owner?.off?.('destroyed', abort);
    owner?.off?.('did-start-navigation', navigate);
    parent?.removeEventListener?.('abort', abort);
    if (task.aiSummaryController === controller) { delete task.aiSummaryController; delete task.aiSummarySignal; }
  } };
}
module.exports = { bindSummaryLifetime };
