const { tr } = require('./localization.cjs');
const fs = require('fs');

// Read box headers only: large recordings must never be loaded into memory.
async function validateRecordingMp4(filePath) {
  const file = await fs.promises.open(filePath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 32) throw new Error(tr("录屏文件为空或不完整"));
    let offset = 0;
    const found = new Set();
    const header = Buffer.alloc(16);
    for (let boxes = 0; offset < stat.size; boxes += 1) {
      if (boxes >= 10000 || stat.size - offset < 8) throw new Error(tr("录屏文件容器不完整"));
      const { bytesRead } = await file.read(header, 0, 16, offset);
      if (bytesRead < 8) throw new Error(tr("录屏文件头不完整"));
      const type = header.toString('ascii', 4, 8);
      let size = header.readUInt32BE(0);
      let headerSize = 8;
      if (size === 1) {
        if (bytesRead < 16) throw new Error(tr("录屏文件扩展头不完整"));
        const largeSize = header.readBigUInt64BE(8);
        if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(tr("录屏文件过大"));
        size = Number(largeSize);
        headerSize = 16;
      } else if (size === 0) {
        size = stat.size - offset;
      }
      if (size < headerSize || offset + size > stat.size) throw new Error(tr("录屏文件尚未完整写入"));
      if (['ftyp', 'mdat', 'moov'].includes(type) && size > headerSize) found.add(type);
      offset += size;
    }
    if (!['ftyp', 'mdat', 'moov'].every(type => found.has(type))) {
      throw new Error(tr("录屏文件缺少完整的视频索引或画面数据，请重新保存"));
    }
    return { size: stat.size };
  } finally {
    await file.close();
  }
}

module.exports = { validateRecordingMp4 };
