import { encodeMessage } from './serialSettings.js';

export const protocolCommandDraftChanged = (initial, draft) => ['id', 'name', 'category', 'template', 'note', 'reviewed'].some(key => initial[key] !== draft[key]);

export async function fillProtocolDraft(frame, { onPreferences, onDraft, previous, isCurrent = () => true }) {
  const hex = frame?.hex;
  encodeMessage({ mode: 'hex', content: hex, lineEnding: 'none' });
  if (!isCurrent()) return false;
  const restore = async () => {
    if (!previous || !isCurrent()) return;
    try { await onPreferences({ sendMode: previous.sendMode, lineEnding: previous.lineEnding }); } catch { /* Preserve the original failure; never replace the draft. */ }
  };
  try { if (await onPreferences({ sendMode: 'hex', lineEnding: 'none' }) !== true) { await restore(); return false; } }
  catch (failure) { await restore(); throw failure; }
  if (!isCurrent()) return false;
  onDraft(hex);
  return true;
}
