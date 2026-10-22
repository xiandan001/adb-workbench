const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { formatHex, formatAscii } = require('./serial-format.cjs');

function formatSerialSnapshot(snapshot) {
  const terminal = snapshot.workspace === 'terminal';
  const lines = [`卓控台 · ${terminal ? '串口终端' : 'RS232 调试'}当前记录`, '保存范围：仅当前工作区的有限缓存，不包含另一工作区或已移出的历史记录',
    terminal ? '终端原始收发字节独立保存；ASCII 不可见字节采用转义显示'
      : 'AB 响应按长度与 CRC 校验分行；FE / XBHCMD 按长度、固定标识与 CF 包尾分行；未识别数据保留原样，不代表完整协议帧；ASCII 不可见字节采用转义显示',
    `导出时间：${new Date().toISOString()}`, `RX：${snapshot.rxBytes} 字节 · TX：${snapshot.txBytes} 字节`,
    `已移出缓存：${snapshot.evicted || 0} 条${snapshot.evicted ? '（记录已截断）' : ''}`, ''];
  for (const entry of snapshot.entries) {
    const config = entry.config;
    const frameCheck = entry.protocol === 'xbh' ? 'FE / XBHCMD 长度、固定标识与包尾已校验' : 'AB 长度与 CRC 已校验';
    lines.push(`[${new Date(entry.time).toISOString()}] ${entry.path} ${entry.direction} ${entry.bytes} 字节`,
      `会话：${entry.sessionId} · 参数：${config.baudRate}/${config.dataBits}/${config.stopBits}/${config.parity}/${config.flowControl}`,
      `记录类型：${terminal ? '原始终端数据' : entry.kind === 'frame' ? `完整报文（${frameCheck}）` : entry.kind === 'pending' ? '待补齐（原始字节已保留）' : '原始数据（未识别为完整 AB 或 FE 报文）'}`,
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
