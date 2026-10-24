const { tr, getLocale, onLocaleChanged } = require('./localization.cjs');

function installApplicationMenu({ Menu, platform = process.platform, getMainWindow, getLogAnalyzerWindow }) {
  function update(locale = getLocale()) {
    const trFor = source => tr(source, {}, locale);
    const item = (role, label) => ({ role, label });
    const separator = { type: 'separator' };
    const template = [
      ...(platform === 'darwin' ? [{ role: 'appMenu', label: trFor('卓控台'), submenu: [item('about', trFor('关于')), separator,
        item('services', trFor('服务')), separator, item('hide', trFor('隐藏应用')), item('hideOthers', trFor('隐藏其他应用')), item('unhide', trFor('显示全部')), separator, item('quit', trFor('退出'))] }] : []),
      { label: trFor('文件'), submenu: [platform === 'darwin' ? item('close', trFor('关闭窗口')) : item('quit', trFor('退出'))] },
      { label: trFor('编辑'), submenu: [item('undo', trFor('撤销')), item('redo', trFor('重做')), separator, item('cut', trFor('剪切')),
        item('copy', trFor('复制')), item('paste', trFor('粘贴')), item('delete', trFor('删除')), separator, item('selectAll', trFor('全选'))] },
      { label: trFor('视图'), submenu: [item('reload', trFor('重新加载')), item('forceReload', trFor('强制重新加载')), item('toggleDevTools', trFor('切换开发者工具')),
        separator, item('resetZoom', trFor('实际大小')), item('zoomIn', trFor('放大')), item('zoomOut', trFor('缩小')), separator, item('togglefullscreen', trFor('切换全屏'))] },
      { label: trFor('窗口'), submenu: [item('minimize', trFor('最小化')), item('zoom', trFor('最大化')), ...(platform === 'darwin'
        ? [separator, item('front', trFor('置于前台'))] : [item('close', trFor('关闭窗口'))])] },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    const main = getMainWindow(); if (main && !main.isDestroyed()) main.setMenuBarVisibility(false);
    const analyzer = getLogAnalyzerWindow(); if (analyzer && !analyzer.isDestroyed()) analyzer.setMenu(null);
  }
  update();
  return onLocaleChanged(update);
}

module.exports = { installApplicationMenu };
