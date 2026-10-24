const { tr } = require('./localization.cjs');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

function isWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function collectArtifactFiles(item) {
  const requestedSource = path.resolve(item.deletePath || item.rootPath);
  const stat = await fs.promises.lstat(requestedSource);
  if (stat.isSymbolicLink()) throw new Error(tr("不支持导出指向其他位置的产物链接"));
  const source = await fs.promises.realpath(requestedSource);
  const files = [];
  const root = stat.isDirectory() ? source : path.dirname(source);
  async function visit(target) {
    const entry = await fs.promises.lstat(target);
    if (entry.isSymbolicLink()) throw new Error(tr("产物中包含文件链接，请移除链接后再导出"));
    if (entry.isDirectory()) {
      const names = await fs.promises.readdir(target);
      for (const name of names.sort()) await visit(path.join(target, name));
    } else if (entry.isFile()) {
      files.push({ source: target, name: path.relative(root, target), bytes: entry.size });
    }
  }
  await visit(source);
  if (!files.length) throw new Error(tr("产物中没有可导出的文件"));
  return { source, directory: stat.isDirectory(), files };
}

function zipDirectory(source, destination) {
  const quote = value => `'${value.replace(/'/g, "''")}'`;
  const script = `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; `
    + `[IO.Compression.ZipFile]::CreateFromDirectory(${quote(source)}, ${quote(destination)}, [IO.Compression.CompressionLevel]::Optimal, $false)`;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => error ? reject(new Error(stderr || stdout || error.message)) : resolve());
  });
}

async function exportArtifact(item, destination) {
  const selected = await collectArtifactFiles(item);
  const target = path.resolve(destination);
  const targetStat = await fs.promises.lstat(target).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (targetStat && (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.nlink > 1)) {
    throw new Error(tr("保存位置不是普通文件，请选择新的 ZIP 文件名"));
  }
  const realTarget = targetStat ? await fs.promises.realpath(target)
    : path.join(await fs.promises.realpath(path.dirname(target)), path.basename(target));
  if (path.relative(selected.source, realTarget) === '' || (selected.directory && isWithin(selected.source, realTarget))) {
    throw new Error(tr("请将证据包保存在原产物目录之外"));
  }
  // 从当前原始证据重新打包，避免把旧的或失败遗留的 ZIP 当作有效证据。
  if (item.type === 'inspection') selected.files = selected.files.filter(file => file.name !== 'evidence-package.zip');
  if (!selected.files.length) throw new Error(tr("没有可导出的原始证据文件"));

  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'adb-workbench-evidence-'));
  try {
    const staging = path.join(tempRoot, 'content');
    const bundle = path.join(tempRoot, 'evidence.zip');
    await fs.promises.mkdir(path.join(staging, 'evidence'), { recursive: true });
    for (const file of selected.files) {
      const copyPath = path.join(staging, 'evidence', file.name);
      await fs.promises.mkdir(path.dirname(copyPath), { recursive: true });
      await fs.promises.copyFile(file.source, copyPath);
    }
    const manifest = {
      version: 1, title: item.title, type: item.type, deviceId: item.deviceId || '',
      exportedAt: new Date().toISOString(),
      files: selected.files.map(file => ({ path: `evidence/${file.name.split(path.sep).join('/')}`, bytes: file.bytes }))
    };
    await fs.promises.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    await zipDirectory(staging, bundle);
    await fs.promises.copyFile(bundle, realTarget);
    return { path: target, fileCount: selected.files.length, reused: false };
  } finally {
    const tempParent = path.resolve(os.tmpdir());
    if (isWithin(tempParent, tempRoot) && path.basename(tempRoot).startsWith('adb-workbench-evidence-')) {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  }
}

module.exports = { collectArtifactFiles, exportArtifact, isWithin };
