import { encodeMessage } from './serialSettings.js';
import { getProtocolParameters } from './rs232Protocol.js';
import { tr } from './i18n.js';

const hexByte = value => value.toString(16).toUpperCase().padStart(2, '0');
const editable = parameter => ({
  key: parameter.key, label: parameter.label, type: parameter.type || 'byte',
  options: (parameter.options || []).map(option => ({ label: option.label, hex: hexByte(option.value) })),
});
const sameSettings = (left, right) => left.label === right.label && left.options.length === right.options.length
  && left.options.every((option, index) => option.label === right.options[index].label && option.hex === right.options[index].hex);

export function createProtocolCommandDraft({ parameterOverrides = [], ...fields }) {
  return { ...fields, parameterEdits: parameterOverrides.map(editable) };
}

export const protocolCommandDraftChanged = (initial, draft) =>
  ['id', 'name', 'category', 'template', 'note', 'reviewed'].some(key => initial[key] !== draft[key])
  || JSON.stringify(initial.parameterEdits || []) !== JSON.stringify(draft.parameterEdits || []);

export function protocolParameterEditorModel(draft) {
  if (!draft.template.trim()) return { parameters: [], defaults: [], valid: true };
  try {
    const defaults = getProtocolParameters({ id: draft.id, template: draft.template }).map(editable);
    const parameters = defaults.map(base => base.type === 'byte'
      ? draft.parameterEdits.find(edit => edit.key === base.key) || base : base);
    return { parameters, defaults, valid: true };
  } catch {
    return { parameters: [], defaults: [], valid: false };
  }
}

export function updateProtocolParameterDraft(draft, base, changed) {
  const current = draft.parameterEdits.find(edit => edit.key === base.key) || base;
  if (sameSettings(current, changed)) return draft;
  const previous = draft.parameterEdits.filter(edit => edit.key !== base.key);
  return { ...draft, reviewed: false, parameterEdits: sameSettings(base, changed) ? previous : [
    ...previous, { key: base.key, type: 'byte', label: changed.label, options: changed.options },
  ].sort((a, b) => a.key.localeCompare(b.key)) };
}

const labelValid = value => value.length > 0 && value.length <= 80
  && [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
function finalParameter(base, edited) {
  const label = edited.label.trim();
  const values = new Set(), names = new Set();
  if (!labelValid(label)) throw Error(tr('参数 {0} 的名称须为 1–80 个字符，且不能包含控制字符。', { 0: base.key }));
  const options = edited.options.map(option => {
    const name = option.label.trim(), hex = option.hex.trim().toUpperCase();
    if (!labelValid(name) || !/^[0-9A-F]{2}$/u.test(hex)) {
      throw Error(tr('参数 {0} 的每个选项都要填写名称和两位 HEX 值（00–FF）。', { 0: base.key }));
    }
    const foldedName = name.toLowerCase();
    if (values.has(hex) || names.has(foldedName)) {
      throw Error(tr('参数 {0} 的选项名称和 HEX 值不能重复。', { 0: base.key }));
    }
    names.add(foldedName); values.add(hex);
    return { label: name, value: Number.parseInt(hex, 16) };
  });
  const parameter = { key: base.key, label, options };
  return sameSettings(base, editable(parameter)) ? null : parameter;
}

export function prepareProtocolCommandDraft({ parameterEdits = [], ...fields }) {
  const defaults = getProtocolParameters(fields).map(editable);
  const parameterOverrides = defaults.filter(base => base.type === 'byte')
    .flatMap(base => {
      const edit = parameterEdits.find(item => item.key === base.key);
      const parameter = edit && finalParameter(base, edit);
      return parameter ? [parameter] : [];
    });
  return { ...fields, ...(parameterOverrides.length ? { parameterOverrides } : {}) };
}

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
