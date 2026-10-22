// Keep Ctrl+C available to the remote program when there is no local selection.
export function sshClipboardAction(event, hasSelection) {
  if (event.altKey || event.metaKey) return null;
  const key = event.key.toLowerCase();
  if (event.ctrlKey && key === 'c' && (event.shiftKey || hasSelection)) return 'copy';
  if (event.ctrlKey && key === 'insert' && !event.shiftKey) return 'copy';
  if (event.ctrlKey && key === 'v') return 'paste';
  if (event.shiftKey && key === 'insert' && !event.ctrlKey) return 'paste';
  return null;
}
