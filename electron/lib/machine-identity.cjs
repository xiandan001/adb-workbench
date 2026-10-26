const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SOURCE_KEYS = ['cpu', 'board', 'disk', 'guid'];
const ID_RE = /^[a-f0-9]{64}$/;

function normalize(value) {
  const result = String(value || '').trim().toUpperCase();
  return ['', '0', 'NONE', 'NULL', 'TO BE FILLED BY O.E.M.', 'DEFAULT'].includes(result) ? '' : result;
}

function hashMachineId(sources, prefix = '') {
  const raw = SOURCE_KEYS.map(key => sources[key] || '').join('|');
  return crypto.createHash('sha256').update(prefix ? `${prefix}|${raw}` : raw).digest('hex');
}

// Reconstruct only fingerprints that the previous collector could have produced
// from currently observed hardware, including a temporarily incomplete CIM read.
function candidateMachineIds({ primary = {}, registry = {}, disks = [] } = {}) {
  const source = Object.fromEntries(SOURCE_KEYS.map(key => [key, normalize(primary[key] || registry[key])]));
  const boards = [...new Set([source.board, normalize(registry.board)])].filter(Boolean);
  const diskValues = [...new Set([source.disk, ...disks.slice(0, 32).map(normalize)])].filter(Boolean);
  const ids = new Set();
  for (const board of boards.length ? boards : ['']) {
    for (const disk of diskValues.length ? diskValues : ['']) {
      const variant = { ...source, board, disk };
      for (let mask = 1; mask < 16; mask++) {
        const subset = Object.fromEntries(SOURCE_KEYS.map((key, index) => [key, mask & (1 << index) ? variant[key] : '']));
        if (Object.values(subset).filter(Boolean).length >= 2) ids.add(hashMachineId(subset));
      }
    }
  }
  if (source.guid) ids.add(hashMachineId({ guid: source.guid }, 'registry-guid-v1'));
  return ids;
}

function sourceProof({ primary = {}, registry = {}, disks = [] } = {}) {
  const values = {
    cpu: [primary.cpu], board: [primary.board, registry.board],
    disk: [primary.disk, ...disks.slice(0, 32)], guid: [primary.guid || registry.guid]
  };
  return Object.fromEntries(SOURCE_KEYS.map(key => [key, [...new Set(values[key].map(normalize).filter(Boolean))]
    .map(value => crypto.createHash('sha256').update(`${key}|${value}`).digest('hex'))]));
}

function atomicWritePrivateFile(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function createIdentityStore({ file, safeStorage }) {
  function available() {
    return safeStorage?.isEncryptionAvailable() &&
      (!safeStorage.getSelectedStorageBackend || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  }
  function read(evidence) {
    try {
      if (!available() || fs.statSync(file).size > 65536) return null;
      const saved = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
      if (saved.version !== 1 || !ID_RE.test(saved.machineId) || !saved.proof) return null;
      if (SOURCE_KEYS.some(key => !Array.isArray(saved.proof[key]) || saved.proof[key].length > 34 ||
          saved.proof[key].some(value => typeof value !== 'string' || !ID_RE.test(value)))) return null;
      if (saved.proof.guid.length !== 1 || !['cpu', 'board', 'disk'].some(key => saved.proof[key].length)) return null;
      const current = sourceProof(evidence);
      if (current.guid.length && current.guid[0] !== saved.proof.guid[0]) return null;
      let comparable = 0; let matched = 0;
      for (const key of ['cpu', 'board', 'disk']) {
        if (current[key].length && saved.proof[key].length) {
          comparable++;
          if (current[key].some(value => saved.proof[key].includes(value))) matched++;
        }
      }
      // Missing sources and disk enumeration changes are tolerated, but every
      // comparable group must match. A model-common CPU cannot excuse an
      // explicitly different motherboard or disk on a cloned Windows identity.
      if (matched !== comparable || (!current.guid.length && matched < 2)) return null;
      return saved.machineId;
    } catch { return null; }
  }
  function remember(machineId, evidence) {
    try {
      if (!available() || !ID_RE.test(machineId)) return false;
      if (read(evidence) === machineId) return true;
      if (!candidateMachineIds(evidence).has(machineId)) return false;
      const proof = sourceProof(evidence);
      if (proof.guid.length !== 1 || !['cpu', 'board', 'disk'].some(key => proof[key].length)) return false;
      atomicWritePrivateFile(file, safeStorage.encryptString(JSON.stringify({ version: 1, machineId, proof })));
      return true;
    } catch { return false; }
  }
  return { read, remember };
}

module.exports = { normalize, hashMachineId, candidateMachineIds, createIdentityStore, atomicWritePrivateFile };
