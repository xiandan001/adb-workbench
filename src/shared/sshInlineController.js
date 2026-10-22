import { advanceInlineInput, inlineCandidates, inlineKey, inlinePlacement, inlineSuffix, readInlinePrefix } from './sshInlineCompletion.js';

export function createSshInlineController({ term, host, getContext, getWriter, getEntries, onPopup, onFocus }) {
  let boundary = null; let shell = { status: 'disabled', phase: 'unknown' }; let expected = null;
  let popup = null; let dismissed = null; let frame; let disposed = false; let reportedFocus = false;
  const hide = () => { if (popup) { popup = null; onPopup(null); } term.textarea.removeAttribute('aria-activedescendant'); term.textarea.removeAttribute('aria-controls'); };
  const currentPrefix = () => {
    const context = getContext();
    return readInlinePrefix({ ...context, active: context.active && context.connected && !context.paused && !context.readFailed && !document.hidden && document.hasFocus(),
      focused: document.activeElement === term.textarea, shell, expected, boundary: boundary && { ...boundary, row: boundary.marker.line }, buffer: term.buffer.active, writer: getWriter()?.state() });
  };
  const refresh = () => {
    frame = null; if (disposed) return;
    const prefix = currentPrefix();
    if (prefix === null || dismissed === `${shell.promptId}:${prefix}`) { hide(); return; }
    const entries = inlineCandidates(getEntries(), prefix);
    const screen = host.querySelector('.xterm-screen');
    const buffer = term.buffer.active; const row = buffer.baseY + buffer.cursorY - buffer.viewportY;
    if (!entries.length || !screen || row < 0 || row >= term.rows) { hide(); return; }
    const rect = screen.getBoundingClientRect(); const lineHeight = rect.height / term.rows;
    const index = popup?.prefix === prefix ? Math.min(popup.index, entries.length - 1) : 0;
    popup = { prefix, entries, index, placement: inlinePlacement({ x: rect.left + rect.width * buffer.cursorX / term.cols,
      y: rect.top + row * lineHeight, lineHeight, width: 420, height: entries.length * 28 + 30, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight }) };
    onPopup(popup);
  };
  const schedule = () => { if (!disposed && !frame) frame = requestAnimationFrame(refresh); };
  const focus = () => {
    const context = getContext();
    const focused = context.active && context.connected && !document.hidden && document.hasFocus() && document.activeElement === term.textarea;
    if (focused !== reportedFocus) { reportedFocus = focused; onFocus(focused); }
    if (!focused || context.replaying || context.paused || context.readFailed) hide(); else schedule();
  };
  const invalidate = () => { expected = null; hide(); };
  const accept = command => {
    const prefix = currentPrefix();
    const suffix = prefix !== null ? inlineSuffix(prefix, command) : null;
    if (suffix === null) { hide(); return false; }
    // Only a suffix is sent, never Enter. Check the fresh buffer and writer,
    // not the popup's possibly older prefix after a fast keystroke.
    if (!getWriter()?.enqueue(suffix)) { invalidate(); return false; }
    expected = advanceInlineInput(expected, suffix); hide(); schedule(); return true;
  };
  const subscriptions = [term.onWriteParsed(schedule), term.onCursorMove(schedule), term.onScroll(schedule), term.onResize(schedule)];
  term.textarea.addEventListener('focus', focus); term.textarea.addEventListener('blur', focus);
  window.addEventListener('resize', schedule); window.addEventListener('scroll', schedule, true);
  return {
    refresh: schedule, sync: focus, invalidate, accept,
    shell(value) { shell = value; if (value.status !== 'ready' || value.phase !== 'prompt') hide(); schedule(); },
    marker(marker) {
      if (marker.kind !== 'prompt') { invalidate(); return; }
      boundary?.marker.dispose(); boundary = null;
      if (term.buffer.active.type !== 'normal') return;
      const tracked = term.registerMarker(0);
      if (tracked) boundary = { marker: tracked, column: term.buffer.active.cursorX, promptId: marker.promptId };
      expected = shell.status === 'ready' && shell.phase === 'prompt' && shell.promptId === marker.promptId ? '' : null;
      dismissed = null; hide(); schedule();
    },
    input(data, userInput) { if (!userInput) return; expected = advanceInlineInput(expected, data); hide(); schedule(); },
    key(event) {
      if (event.type !== 'keydown') return false;
      if (event.key === 'Enter') invalidate();
      const result = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey ? inlineKey(event.key, popup?.index || 0, popup?.entries.length || 0) : { action: 'native', consume: false };
      if (result.action === 'select') { popup = { ...popup, index: result.index }; onPopup(popup); }
      if (result.action === 'accept') accept(popup.entries[popup.index].command);
      if (result.action === 'dismiss') { dismissed = `${shell.promptId}:${popup?.prefix || ''}`; hide(); }
      if (!result.consume && (event.ctrlKey || event.metaKey || event.altKey || ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Delete', 'Tab', 'Escape'].includes(event.key))) invalidate();
      return result.consume;
    },
    reset() { boundary?.marker.dispose(); boundary = null; invalidate(); },
    dispose() {
      disposed = true; cancelAnimationFrame(frame); boundary?.marker.dispose(); subscriptions.forEach(item => item.dispose());
      term.textarea.removeEventListener('focus', focus); term.textarea.removeEventListener('blur', focus);
      window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true);
      if (reportedFocus) onFocus(false); hide();
    },
  };
}
