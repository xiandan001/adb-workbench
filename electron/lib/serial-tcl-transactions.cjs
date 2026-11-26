const { commands } = require('./rs232-protocol-tcl.json');
const { crcMatches } = require('./serial-response-framer.cjs');

const byOpcode = new Map();
for (const command of commands) {
  const tokens = command.template.split(' ');
  if (command.needsReview || tokens[0] !== 'AA' || tokens[1] === 'FE') continue;
  const opcode = Number.parseInt(tokens[2], 16);
  const expected = command.ack2?.split(' ');
  const entry = { commandId: command.id, tokens, parameters: new Map(command.parameters.map(item => [item.key, item])),
    response: expected ? replyContract(expected) : null };
  if (!byOpcode.has(opcode)) byOpcode.set(opcode, []);
  byOpcode.get(opcode).push(entry);
}

function replyContract(tokens) {
  const extended = tokens[1] === 'FE';
  const header = Number.parseInt(tokens[0], 16);
  const length = tokens[1] === 'XX' || extended ? 0 : Number.parseInt(tokens[1], 16);
  const offset = extended ? 4 : 2;
  const prefix = [];
  for (const token of tokens.slice(offset, -2)) {
    // Documented D1/D2 are payload positions, not hexadecimal literals.
    if (/^D[0-9]$/.test(token) || !/^[0-9A-F]{2}$/.test(token)) break;
    prefix.push(Number.parseInt(token, 16));
  }
  return { header, length, offset, prefix };
}

function validShortRequest(bytes) {
  return bytes?.length >= 5 && bytes.length < 0xfe && bytes[0] === 0xaa && bytes[1] === bytes.length &&
    crcMatches(bytes, 0, bytes.length);
}

function matchesRequest(bytes, contract) {
  let index = 1;
  for (const token of contract.tokens.slice(1)) {
    if (token === 'LL') { index++; continue; }
    if (token === 'CRC1' || token === 'CRC2') { index++; continue; }
    const parameter = contract.parameters.get(token.slice(1, -1));
    if (parameter?.type === 'ascii') {
      const content = bytes.subarray(index, -2);
      if (content.length < parameter.minBytes || content.length > parameter.maxBytes ||
        content.some(byte => byte < 0x20 || byte > 0x7e)) return false;
      index += content.length;
    } else if (parameter?.type === 'byte') {
      const byte = bytes[index++];
      if (!Number.isInteger(byte) || byte < parameter.min || byte > parameter.max ||
        (parameter.options?.length && !parameter.options.some(option => option.value === byte))) return false;
    } else if (bytes[index++] !== Number.parseInt(token, 16)) return false;
  }
  return index === bytes.length;
}

function tclRequestContract(bytes) {
  if (!validShortRequest(bytes)) return null;
  const opcode = bytes[2];
  const matches = (byOpcode.get(opcode) || []).filter(contract => matchesRequest(bytes, contract));
  return { protocol: 'tcl', opcode, ...(matches.length === 1 ? { commandId: matches[0].commandId, response: matches[0].response } : {}) };
}

function tclResponse(entry) {
  if (entry.direction !== 'RX' || entry.kind !== 'frame' || !['ab', 'tcl-nfc', 'tcl-extended'].includes(entry.protocol) ||
    typeof entry.hex !== 'string' || entry.hex.length > 32768 || !/^(?:[0-9a-f]{2}){5,}$/i.test(entry.hex)) return null;
  const bytes = Buffer.from(entry.hex, 'hex');
  const extended = entry.protocol === 'tcl-extended';
  const length = extended ? bytes.readUInt16BE(2) : bytes[1];
  const header = entry.protocol === 'tcl-nfc' ? 0xaa : 0xab;
  if (bytes[0] !== header || length !== bytes.length ||
    (extended && (bytes[1] !== 0xfe || bytes.length < 256)) || !crcMatches(bytes, 0, bytes.length)) return null;
  if (header === 0xab && length === 5) {
    const control = { 10: 'ack', 11: 'completion', 14: 'rejected', 15: 'transport-error' }[bytes[2]];
    if (control) return { control };
  }
  return { bytes };
}

function matchTclResult(contract, bytes) {
  if (!contract || !bytes || bytes[0] !== contract.header ||
    (contract.length ? bytes.length !== contract.length : bytes.length <= contract.offset + contract.prefix.length + 2) ||
    (contract.offset === 4 && (bytes[1] !== 0xfe || bytes.length < 256)) ||
    !contract.prefix.every((byte, index) => bytes[contract.offset + index] === byte)) return null;
  const payload = bytes.subarray(contract.offset + contract.prefix.length, -2);
  return { bytes: payload.length, preview: payload.subarray(0, 8).toString('hex') };
}

module.exports = { tclRequestContract, tclResponse, matchTclResult };
