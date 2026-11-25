import catalog from '../../electron/lib/rs232-protocol-catalog.json' with { type: 'json' };
import tcl from '../../electron/lib/rs232-protocol-tcl.json' with { type: 'json' };
import { defaultProtocolPreferences, normalizeProtocolParameterOverrides, normalizeProtocolPreferences } from './rs232ProtocolPreferences.js';
import { tr } from './i18n.js';
import { completeTclFrame, tclCrcToken, tclLengthToken } from './tclFactoryProtocol.js';

const freeze = value => { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; };
freeze(catalog);
freeze(tcl);
const catalogCommands = Object.freeze([...catalog.commands, ...tcl.commands.map(command => Object.freeze({ ...command, protocol: 'tcl' }))]);
const builtins = new Map(catalogCommands.map(command => [command.id, command]));
const customId = /^custom-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const placeholder = /^\{([A-Za-z][A-Za-z0-9_]{0,31})\}$/;
const messages = {
  RS232_COMMAND_INVALID: () => tr('协议指令无效。'),
  RS232_TEMPLATE_INVALID: () => tr('模板须使用空格分隔的 HEX 字节、{XX} 参数和可选长度 LL。'),
  RS232_REVIEW_REQUIRED: () => tr('此指令待核对，请编辑并明确确认后使用。'),
  RS232_REFERENCE_ONLY: () => tr('这是设备上报参考，不能填入主机发送区。'),
  RS232_PARAMETER_INVALID: () => tr('请填写有效的协议参数，不要超出说明范围。'),
  RS232_FRAME_INVALID: () => tr('报文结构或长度不符合 Lango 协议，未生成。'),
  RS232_DATA_TOO_LONG: () => tr('协议数据最多 247 字节，未生成。'),
  RS232_TCL_FRAME_INVALID: () => tr('TCL 报文长度或 CRC 不正确，未生成。'),
};
const fail = code => { throw Object.assign(new Error(messages[code]()), { code }); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function describe(command) {
  if (!plain(command)) fail('RS232_COMMAND_INVALID');
  const descriptors = Object.getOwnPropertyDescriptors(command), id = descriptors.id?.value, template = descriptors.template?.value;
  if (typeof id !== 'string' || !builtins.has(id) && !customId.test(id)) fail('RS232_COMMAND_INVALID');
  if (typeof template !== 'string' || !template.trim() || template.length > 8192) fail('RS232_TEMPLATE_INVALID');
  const base = builtins.get(id);
  let overrides = [];
  const configured = descriptors.parameterOverrides;
  if (configured) {
    if (!configured.enumerable || !Object.hasOwn(configured, 'value')) fail('RS232_PARAMETER_INVALID');
    try { overrides = normalizeProtocolParameterOverrides(configured.value, id, template); }
    catch { fail('RS232_PARAMETER_INVALID'); }
  }
  return { base, template, isTcl: base?.protocol === 'tcl' || !base && /^AA(?:\s|$)/iu.test(template.trim()),
    reviewed: descriptors.reviewed?.value === true, overrides };
}
function tokensFor(template, isTcl) {
  const tokens = template.trim().split(/\s+/u);
  for (const [index, token] of tokens.entries()) {
    if (/^[0-9a-f]{2}$/i.test(token) || placeholder.test(token)) continue;
    if (isTcl ? tclLengthToken(tokens, index) || tclCrcToken(tokens, index) : index === 1 && token === 'LL') continue;
    fail('RS232_TEMPLATE_INVALID');
  }
  return tokens;
}

export function listProtocolCommands(preferences = defaultProtocolPreferences()) {
  const current = normalizeProtocolPreferences(preferences), removed = new Set(current.removed), overrides = new Map(current.overrides.map(entry => [entry.id, entry]));
  const materialize = (base, override) => {
    const command = { ...(base ? structuredClone(base) : {}), ...override };
    command.builtin = Boolean(base); command.modified = Boolean(override);
    command.needsReview = !base || base.needsReview || command.template !== base.template || Boolean(command.parameterOverrides?.length);
    command.referenceOnly = base?.referenceOnly === true; command.reviewed = override?.reviewed === true;
    if (!base && /^AA(?:\s|$)/iu.test(command.template.trim())) command.protocol = 'tcl';
    if (!base || command.name !== base.name) delete command.labels;
    if (!base || command.template !== base.template) delete command.parameters;
    return command;
  };
  return [...catalogCommands.filter(base => !removed.has(base.id)).map(base => materialize(base, overrides.get(base.id))),
    ...current.overrides.filter(entry => !builtins.has(entry.id)).map(entry => materialize(null, entry))];
}

function protocolParameters({ base, template, isTcl, overrides }, tokens) {
  const keys = [...new Set(tokens.map(token => token.match(placeholder)?.[1]).filter(Boolean))];
  const source = base && template === base.template ? base.parameters
    : keys.map(key => isTcl && base?.parameters.find(parameter => parameter.key === key) || { key, label: key, type: 'byte', min: 0, max: 255 });
  const index = new Map(overrides.map(item => [item.key, item]));
  return structuredClone(source.map(parameter => {
    const change = index.get(parameter.key);
    if (!change) return parameter;
    const { label, labels, options, ...definition } = parameter;
    return { ...definition, label: change.label, ...(label === change.label && labels ? { labels } : {}),
      ...(change.options.length ? { min: 0, max: 255, options: change.options.map(option =>
        options?.find(sourceOption => sourceOption.label === option.label && sourceOption.value === option.value) || option) } : {}) };
  }));
}

export function getProtocolParameters(command) {
  const description = describe(command);
  return protocolParameters(description, tokensFor(description.template, description.isTcl));
}

function parameterBytes(parameter, value) {
  if (parameter.type === 'ascii') {
    if (typeof value !== 'string' || !/^[\x21-\x7e]+$/.test(value) || value.length > parameter.maxBytes) fail('RS232_PARAMETER_INVALID');
    return [...value].map(character => character.charCodeAt(0));
  }
  if (parameter.type === 'hex') {
    if (typeof value !== 'string' || value.length > parameter.maxBytes * 4) fail('RS232_PARAMETER_INVALID');
    const tokens = value.trim().split(/\s+/u);
    if (tokens.some(token => token.length % 2 || !/^[0-9a-f]+$/i.test(token))) fail('RS232_PARAMETER_INVALID');
    const compact = tokens.join('');
    if (compact.length / 2 < parameter.minBytes ||
      compact.length / 2 > parameter.maxBytes) fail('RS232_PARAMETER_INVALID');
    return Array.from({ length: compact.length / 2 }, (_, index) => parseInt(compact.slice(index * 2, index * 2 + 2), 16));
  }
  let number = value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^(?:0x[0-9a-f]{1,2}|(?=[0-9a-f]*[a-f])[0-9a-f]{1,2})$/i.test(text)) number = parseInt(text.replace(/^0x/i, ''), 16);
    else if (/^[0-9]{1,3}$/.test(text)) number = Number(text);
    else fail('RS232_PARAMETER_INVALID');
  }
  if (!Number.isSafeInteger(number) || number < parameter.min || number > parameter.max
    || parameter.options && !parameter.options.some(option => option.value === number)) fail('RS232_PARAMETER_INVALID');
  return [number];
}

export function buildProtocolCommand(command, values = {}) {
  const description = describe(command);
  const { base, template, reviewed, isTcl, overrides } = description;
  if (base?.referenceOnly) fail('RS232_REFERENCE_ONLY');
  if ((!base || base.needsReview || template !== base.template || overrides.length) && !reviewed) fail('RS232_REVIEW_REQUIRED');
  const tokens = tokensFor(template, isTcl), parameters = protocolParameters(description, tokens), expectedKeys = new Set(parameters.map(parameter => parameter.key));
  if (!plain(values) || Reflect.ownKeys(values).some(key => !expectedKeys.has(key)) || parameters.some(parameter => !Object.hasOwn(values, parameter.key))) fail('RS232_PARAMETER_INVALID');
  const expanded = new Map();
  for (const parameter of parameters) {
    const descriptor = Object.getOwnPropertyDescriptor(values, parameter.key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('RS232_PARAMETER_INVALID');
    expanded.set(parameter.key, parameterBytes(parameter, descriptor.value));
  }
  const bytes = [];
  for (const [index, token] of tokens.entries()) {
    const key = token.match(placeholder)?.[1];
    if (key) {
      const data = expanded.get(key);
      if (isTcl && bytes.length + data.length > 0xffff) fail('RS232_TCL_FRAME_INVALID');
      for (const byte of data) bytes.push(byte);
    } else bytes.push(isTcl ? tclLengthToken(tokens, index) || tclCrcToken(tokens, index) ? 0 : parseInt(token, 16)
      : index === 1 && token === 'LL' ? 0 : parseInt(token, 16));
  }
  if (isTcl) {
    if (!completeTclFrame(tokens, bytes)) fail('RS232_TCL_FRAME_INVALID');
    return frame(bytes);
  }
  if (bytes.length - 11 > 247) fail('RS232_DATA_TOO_LONG');
  if (tokens[1] === 'LL') bytes[1] = bytes.length - 3;
  if (bytes.length < 11 || bytes[0] !== 0xfe || bytes.at(-1) !== 0xcf || bytes[1] !== bytes.length - 3
    || !catalog.format.signature.every((byte, index) => bytes[index + 2] === byte) || bytes[8] < 1 || bytes[8] > 6) fail('RS232_FRAME_INVALID');
  return frame(bytes);
}
const frame = bytes => ({ hex: bytes.map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(' '), bytes: Uint8Array.from(bytes) });

export function getProtocolDisplayName(command, locale = 'zh-CN') {
  const base = builtins.get(command?.id);
  return base && command.name === base.name ? base.labels[locale] || base.name : command?.name || '';
}
export function getProtocolCategoryLabel(category, locale = 'zh-CN', command) {
  const base = command && builtins.get(command.id);
  if (command && (!base || category !== base.category)) return category;
  const group = [...catalog.categories, catalog.reportCategory, tcl.category].find(entry => entry.name === category);
  return group?.labels[locale] || category;
}
