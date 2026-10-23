const fs = require('node:fs');
const { checksum, readSafe, checkHash, atomicReplace, fail } = require('./ai-tools-file-safety.cjs');

// Main-only transaction. Neither encrypted file bytes nor callbacks cross IPC.
function prepareEncryptedMerge({ file, beforeState, nextState, getState, acceptState, after, expectedHash, counts, available, limit, filesystem: io = fs }) {
  const original = checkHash(file, expectedHash, io, limit); const afterHash = checksum(after); let committed = false;
  function assertCurrent() {
    if (!available()) throw fail('AI_TOOLS_ENCRYPTION_UNAVAILABLE', '系统安全加密不可用，不能导入 AI 资源');
    if (getState() !== beforeState) throw fail('AI_TOOLS_PORTABLE_CHANGED', 'AI 数据在预览后已变化，请重新预览导入');
    checkHash(file, original.hash, io, limit);
  }
  function commit() {
    if (committed) throw fail('AI_TOOLS_PORTABLE_CHANGED', '导入事务不能重复提交');
    assertCurrent(); atomicReplace(file, after, original.hash, io, limit); acceptState(nextState, afterHash); committed = true;
  }
  function rollback() {
    if (!committed) return;
    if (getState() !== nextState || readSafe(file, io, limit).hash !== afterHash) throw fail('AI_TOOLS_PORTABLE_CHANGED', '导入后出现其他修改，未覆盖新数据，请检查恢复备份');
    atomicReplace(file, original.bytes, afterHash, io, limit); acceptState(beforeState, original.hash); committed = false;
  }
  return { counts, target: { path: file, before: original.bytes, beforeHash: original.hash, after, afterHash, limit }, assertCurrent, commit, rollback };
}

module.exports = { prepareEncryptedMerge };
