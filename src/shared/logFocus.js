export function shouldExitLogFocus(event, document = globalThis.document) {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return false;
  if (document?.querySelector('dialog[open], [role="listbox"], [role="menu"], [aria-modal="true"]')) return false;
  return !event.target?.closest?.('input, textarea, select, [contenteditable="true"], [role="textbox"]');
}
