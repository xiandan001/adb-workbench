const fs = require('fs');
const path = require('path');

// Only images produced by this process can be previewed, copied, or opened here.
function createScreenshotActions({ nativeImage, clipboard, shell }) {
  const screenshots = new Map();

  function remember(filePath) {
    const target = path.resolve(filePath);
    const realPath = fs.realpathSync(target);
    screenshots.delete(target);
    screenshots.set(target, realPath);
    if (screenshots.size > 20) screenshots.delete(screenshots.keys().next().value);
    try {
      const image = nativeImage.createFromPath(realPath);
      if (image.isEmpty()) return { path: target, preview: '' };
      const { width, height } = image.getSize();
      const ratio = Math.min(1, 480 / width, 270 / height);
      const preview = image.resize({ width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) });
      return { path: target, preview: preview.toDataURL() };
    } catch {
      return { path: target, preview: '' };
    }
  }

  async function perform({ path: filePath, action } = {}) {
    try {
      if (typeof filePath !== 'string' || !['copy', 'open', 'folder'].includes(action)) throw new Error('无效的截图操作');
      const target = path.resolve(filePath);
      if (!screenshots.has(target)) throw new Error('仅可操作本次启动后生成的截图');
      if (fs.realpathSync(target) !== screenshots.get(target) || !fs.statSync(target).isFile()) throw new Error('截图路径已变化，请重新截图');
      if (action === 'copy') {
        const image = nativeImage.createFromPath(target);
        if (image.isEmpty()) throw new Error('截图无法读取');
        clipboard.writeImage(image);
      } else if (action === 'folder') {
        shell.showItemInFolder(target);
      } else {
        const error = await shell.openPath(target);
        if (error) throw new Error(error);
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  return { remember, perform };
}

module.exports = { createScreenshotActions };
