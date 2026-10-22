const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { formatHex, formatAscii } = require('./serial-format.cjs');

function formatSerialSnapshot(snapshot) {
  const lines = ['卓控台 · 串口当前记录', '保存范围：当前有限缓存，不包含已移出的历史记录',
    '接收记录按 50 ms 间隔合并，每行最多 2 段，第三段另起一行；仅便于查看，不代表完整协议帧；ASCII 不可见字节采用转义显示',
    `导出时间：${new Date().toISOString()}`, `RX：${snapshot.rxBytes} 字节 · TX：${snapshot.txBytes} 字节`,
    `已移出缓存：${snapshot.evicted || 0} 条${snapshot.evicted ? '（记录已截断）' : ''}`, ''];
  for (const entry of snapshot.entries) {
    const config = entry.config;
    lines.push(`[${new Date(entry.time).toISOString()}] ${entry.path} ${entry.direction} ${entry.bytes} 字节`,
      `会话：${entry.sessionId} · 参数：${config.baudRate}/${config.dataBits}/${config.stopBits}/${config.parity}/${config.flowControl}`,
      `合并片段：${entry.parts || 1} · 结束时间：${new Date(entry.endTime ?? entry.time).toISOString()}`,
      `HEX: ${formatHex(entry.hex)}`, `ASCII: ${formatAscii(entry.hex)}`, `TEXT: ${JSON.stringify(entry.text)}`, '');
  }
  return lines.join('\n') + '\n';
}

async function writeSerialSnapshot(target, snapshot) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || !/\.(log|txt)$/i.test(target)) throw new Error('请保存为 .log 或 .txt 文件');
  const parent = await fs.promises.realpath(path.dirname(target));
  const destination = path.join(parent, path.basename(target));
  const previous = await fs.promises.lstat(destination).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (previous && (!previous.isFile() || previous.isSymbolicLink() || previous.nlink > 1)) throw new Error('保存位置必须是普通文件，不能是链接');
  const temporary = path.join(parent, `.serial-export-${randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(temporary, formatSerialSnapshot(snapshot), { flag: 'wx', encoding: 'utf8' });
    await fs.promises.rename(temporary, destination);
  } finally { await fs.promises.unlink(temporary).catch(() => {}); }
}

module.exports = { formatSerialSnapshot, writeSerialSnapshot };
