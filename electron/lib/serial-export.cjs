const { tr } = require('./localization.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { formatHex, formatAscii } = require('./serial-format.cjs');

function formatSerialSnapshot(snapshot) {
  const terminal = snapshot.workspace === 'terminal';
  const lines = [tr("卓控台 · {0}当前记录", { 0: terminal ? tr("串口终端") : tr("RS232 调试") }), tr("保存范围：仅当前工作区的有限缓存，不包含另一工作区或已移出的历史记录"),
    terminal ? tr("终端原始收发字节独立保存；ASCII 不可见字节采用转义显示")
      : tr("AB 响应按长度与 CRC 校验分行；FE / XBHCMD 按长度、固定标识与 CF 包尾分行；未识别数据保留原样，不代表完整协议帧；ASCII 不可见字节采用转义显示"),
    tr("导出时间：{0}", { 0: new Date().toISOString() }), tr("RX：{0} 字节 · TX：{1} 字节", { 0: snapshot.rxBytes, 1: snapshot.txBytes }),
    tr("已移出缓存：{0} 条{1}", { 0: snapshot.evicted || 0, 1: snapshot.evicted ? tr("（记录已截断）") : '' }), ''];
  for (const entry of snapshot.entries) {
    const config = entry.config;
    const frameCheck = entry.protocol === 'xbh' ? tr("FE / XBHCMD 长度、固定标识与包尾已校验") : tr("AB 长度与 CRC 已校验");
    lines.push(tr("[{0}] {1} {2} {3} 字节", { 0: new Date(entry.time).toISOString(), 1: entry.path, 2: entry.direction, 3: entry.bytes }),
      tr("会话：{0} · 参数：{1}/{2}/{3}/{4}/{5}", { 0: entry.sessionId, 1: config.baudRate, 2: config.dataBits, 3: config.stopBits, 4: config.parity, 5: config.flowControl }),
      tr("记录类型：{0}", { 0: terminal ? tr("原始终端数据") : entry.kind === 'frame' ? tr("完整报文（{0}）", { 0: frameCheck }) : entry.kind === 'pending' ? tr("待补齐（原始字节已保留）") : tr("原始数据（未识别为完整 AB 或 FE 报文）") }),
      tr("合并片段：{0} · 结束时间：{1}", { 0: entry.parts || 1, 1: new Date(entry.endTime ?? entry.time).toISOString() }),
      `HEX: ${formatHex(entry.hex)}`, `ASCII: ${formatAscii(entry.hex)}`, `TEXT: ${JSON.stringify(entry.text)}`, '');
  }
  return lines.join('\n') + '\n';
}

async function writeSerialSnapshot(target, snapshot) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || !/\.(log|txt)$/i.test(target)) throw new Error(tr("请保存为 .log 或 .txt 文件"));
  const parent = await fs.promises.realpath(path.dirname(target));
  const destination = path.join(parent, path.basename(target));
  const previous = await fs.promises.lstat(destination).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (previous && (!previous.isFile() || previous.isSymbolicLink() || previous.nlink > 1)) throw new Error(tr("保存位置必须是普通文件，不能是链接"));
  const temporary = path.join(parent, `.serial-export-${randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(temporary, formatSerialSnapshot(snapshot), { flag: 'wx', encoding: 'utf8' });
    await fs.promises.rename(temporary, destination);
  } finally { await fs.promises.unlink(temporary).catch(() => {}); }
}

module.exports = { formatSerialSnapshot, writeSerialSnapshot };
