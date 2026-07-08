const { contextBridge, ipcRenderer } = require('electron');

// 安全 listener 包装：隔离 callback 异常，避免影响后续 IPC 事件处理
const safeListener = (callback) => (event, ...args) => {
  try {
    callback(...args);
  } catch (e) {
    console.error('[Preload] IPC listener error:', e);
  }
};

contextBridge.exposeInMainWorld('electronAPI', {
  getDevices: () => ipcRenderer.invoke('adb:getDevices'),
  startScrcpy: (deviceId, settings) => ipcRenderer.invoke('scrcpy:start', { deviceId, settings }),
  adbShell: (deviceId, command) => ipcRenderer.invoke('adb:shell', { deviceId, command }),
  adbShellCancel: (deviceId) => ipcRenderer.invoke('adb:shell:cancel', { deviceId }),
  adbScreenshot: (deviceId, localPath) => ipcRenderer.invoke('adb:screenshot', { deviceId, localPath }),
  adbScreenRecordStart: (deviceId, remotePath) => ipcRenderer.invoke('adb:screenrecord:start', { deviceId, remotePath }),
  adbScreenRecordStop: (deviceId, localPath) => ipcRenderer.invoke('adb:screenrecord:stop', { deviceId, localPath }),
  adbScreenRecordStatus: (deviceId) => ipcRenderer.invoke('adb:screenrecord:status', { deviceId }),
  adbReboot: (deviceId) => ipcRenderer.invoke('adb:reboot', { deviceId }),
  adbRebootLoader: (deviceId) => ipcRenderer.invoke('adb:rebootLoader', { deviceId }),
  adbUnlock: (deviceId) => ipcRenderer.invoke('adb:unlock', { deviceId }),
  adbRoot: (deviceId) => ipcRenderer.invoke('adb:root', { deviceId }),
  adbRemount: (deviceId) => ipcRenderer.invoke('adb:remount', { deviceId }),
  adbConnect: (ipAddress) => ipcRenderer.invoke('adb:connect', ipAddress),
  adbDisconnect: (deviceId) => ipcRenderer.invoke('adb:disconnect', deviceId),
  adbInstall: (deviceId, apkPath) => ipcRenderer.invoke('adb:install', { deviceId, apkPath }),
  adbPush: (deviceId, localPath, remotePath) => ipcRenderer.invoke('adb:push', { deviceId, localPath, remotePath }),
  adbPull: (deviceId, remotePath, localPath) => ipcRenderer.invoke('adb:pull', { deviceId, remotePath, localPath }),
  adbShellLs: (deviceId, path) => ipcRenderer.invoke('adb:shellLs', { deviceId, path }),
  showOpenDialog: (options) => ipcRenderer.invoke('dialog:openFile', options),
  showSaveDialog: (options) => ipcRenderer.invoke('dialog:saveFile', options),
  getDroppedFilePath: (fileName) => ipcRenderer.invoke('dialog:getDroppedFilePath', fileName),
  onDroppedFile: (callback) => {
    const listener = safeListener(callback);
    ipcRenderer.on('drop:file', listener);
    return () => ipcRenderer.off('drop:file', listener);
  },
  onUpdate: (callback) => {
    const listener = safeListener(callback);
    ipcRenderer.on('update-status', listener);
    return () => ipcRenderer.off('update-status', listener);
  },
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  saveCustomThemes: (customThemes) => ipcRenderer.invoke('themes:saveCustomThemes', customThemes),
  loadCustomThemes: () => ipcRenderer.invoke('themes:loadCustomThemes'),
  // 截图保存路径设置
  saveScreenshotPath: (path) => ipcRenderer.invoke('settings:saveScreenshotPath', path),
  loadScreenshotPath: () => ipcRenderer.invoke('settings:loadScreenshotPath'),
  saveScreenRecordPath: (path) => ipcRenderer.invoke('settings:saveScreenRecordPath', path),
  loadScreenRecordPath: () => ipcRenderer.invoke('settings:loadScreenRecordPath'),
  // 巡检保存路径设置
  saveInspectionPath: (path) => ipcRenderer.invoke('settings:saveInspectionPath', path),
  loadInspectionPath: () => ipcRenderer.invoke('settings:loadInspectionPath'),
  savePerformancePath: (path) => ipcRenderer.invoke('settings:savePerformancePath', path),
  loadPerformancePath: () => ipcRenderer.invoke('settings:loadPerformancePath'),
  saveTaskCenterPath: (path) => ipcRenderer.invoke('settings:saveTaskCenterPath', path),
  loadTaskCenterPath: () => ipcRenderer.invoke('settings:loadTaskCenterPath'),
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  getUserDataPath: () => ipcRenderer.invoke('app:getUserDataPath'),
  // 版本号统一管理：渲染进程获取应用版本
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  // 渲染进程主动查询是否需要显示更新说明（拉取模式）
  checkChangelog: () => ipcRenderer.invoke('app:checkChangelog'),
  // 更新说明弹窗：main 进程检测版本升级后主动推送
  onChangelogShow: (callback) => {
    const listener = safeListener(callback);
    ipcRenderer.on('changelog:show', listener);
    return () => ipcRenderer.off('changelog:show', listener);
  },
  // 自动更新 API
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  getUpdaterStatus: () => ipcRenderer.invoke('updater:status'),
  onUpdaterEvent: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('updater:event', handler);
    return () => ipcRenderer.removeListener('updater:event', handler);
  },
  openFolder: (path) => ipcRenderer.invoke('shell:openPath', path),
  ensureFolder: (path) => ipcRenderer.invoke('shell:ensureFolder', path),
  // 连接历史记录
  saveConnectionHistory: (entry) => ipcRenderer.invoke('history:save', entry),
  loadConnectionHistory: () => ipcRenderer.invoke('history:load'),
  clearConnectionHistory: () => ipcRenderer.invoke('history:clear'),
  // 终端命令历史记录
  saveTerminalCommand: (command) => ipcRenderer.invoke('terminalHistory:save', command),
  loadTerminalHistory: () => ipcRenderer.invoke('terminalHistory:load'),
  clearTerminalHistory: () => ipcRenderer.invoke('terminalHistory:clear'),
  // Android Log Analyzer 集成
  adbListDevices: () => ipcRenderer.invoke('adb:listDevices'),
  adbStartLog: (args) => ipcRenderer.invoke('adb:startLog', args),
  adbStopLog: () => ipcRenderer.invoke('adb:stopLog'),
  logOpenFile: () => ipcRenderer.invoke('log:openFile'),
  logClear: (args) => ipcRenderer.invoke('log:clear', args),
  logGetState: () => ipcRenderer.invoke('log:getState'),
  logFilterInMain: (args) => ipcRenderer.invoke('log:filterInMain', args),
  logExportToFile: (args) => ipcRenderer.invoke('log:exportToFile', args),
  onLogReset: (callback) => {
    const listener = safeListener(callback);
    ipcRenderer.on('log:reset', listener);
    return () => ipcRenderer.off('log:reset', listener);
  },
  onLogAppendBatch: (callback) => {
    const listener = safeListener(callback);
    ipcRenderer.on('log:appendBatch', listener);
    return () => ipcRenderer.off('log:appendBatch', listener);
  },
  mcpGetInfo: () => ipcRenderer.invoke('mcp:getInfo'),
  mcpStart: () => ipcRenderer.invoke('mcp:start'),
  mcpStop: () => ipcRenderer.invoke('mcp:stop'),
  logAnalyzerOpen: () => ipcRenderer.invoke('logAnalyzer:open'),
  logAnalyzerClose: () => ipcRenderer.invoke('logAnalyzer:close'),
  logAnalyzerIsAlive: () => ipcRenderer.invoke('logAnalyzer:isAlive'),
  // 推送远程路径历史记录
  savePushRemotePathHistory: (historyList) => ipcRenderer.invoke('settings:savePushRemotePathHistory', historyList),
  loadPushRemotePathHistory: () => ipcRenderer.invoke('settings:loadPushRemotePathHistory'),
  // AI 日志分析
  aiAnalyzeLog: (args) => ipcRenderer.invoke('ai:analyzeLog', args),
  aiStopAnalyze: () => ipcRenderer.invoke('ai:stopAnalyze'),
  aiClearConversation: () => ipcRenderer.invoke('ai:clearConversation'),
  aiExportResult: (args) => ipcRenderer.invoke('ai:exportResult', args),
  onAiStreamStart: (callback) => {
    const listener = safeListener(callback);
    ipcRenderer.on('ai:streamStart', listener);
    return () => ipcRenderer.off('ai:streamStart', listener);
  },
  onAiStreamChunk: (callback) => {
    const listener = safeListener(callback);
    ipcRenderer.on('ai:streamChunk', listener);
    return () => ipcRenderer.off('ai:streamChunk', listener);
  },
  onAiStreamEnd: (callback) => {
    const listener = safeListener(callback);
    ipcRenderer.on('ai:streamEnd', listener);
    return () => ipcRenderer.off('ai:streamEnd', listener);
  },
  onAiStreamError: (callback) => {
    const listener = safeListener(callback);
    ipcRenderer.on('ai:streamError', listener);
    return () => ipcRenderer.off('ai:streamError', listener);
  },
  // AI 自动诊断：实时检测崩溃/ANR/OOM 并提示用户
  autoDiagnoseAnalyze: (args) => ipcRenderer.invoke('auto-diagnose:analyze', args),
  autoDiagnoseToggle: (enabled) => ipcRenderer.invoke('auto-diagnose:toggle', { enabled }),
  autoDiagnoseStatus: () => ipcRenderer.invoke('auto-diagnose:status'),
  autoDiagnoseClear: () => ipcRenderer.invoke('auto-diagnose:clear'),
  // 日志显示区域变更时重新扫描（搜索完成 / 返回原日志）
  autoDiagnoseRescan: (args) => ipcRenderer.invoke('auto-diagnose:rescan', args),
  // 日志诊断规则库
  autoDiagnoseRulesList: () => ipcRenderer.invoke('auto-diagnose:rules:list'),
  autoDiagnoseRulesSave: (args) => ipcRenderer.invoke('auto-diagnose:rules:save', args),
  autoDiagnoseRulesDelete: (args) => ipcRenderer.invoke('auto-diagnose:rules:delete', args),
  autoDiagnoseRulesReset: () => ipcRenderer.invoke('auto-diagnose:rules:reset'),
  autoDiagnoseRulesTest: (args) => ipcRenderer.invoke('auto-diagnose:rules:test', args),
  autoDiagnoseRulesExport: () => ipcRenderer.invoke('auto-diagnose:rules:export'),
  autoDiagnoseRulesImport: (args) => ipcRenderer.invoke('auto-diagnose:rules:import', args),
  onAutoDiagnose: (callback) => {
    const listener = safeListener(callback);
    ipcRenderer.on('auto-diagnose:detected', listener);
    return () => ipcRenderer.off('auto-diagnose:detected', listener);
  },
  // 扫描完成事件：渲染进程据此从"监控中"切换到"扫描完成（无异常）"状态
  onAutoDiagnoseScanComplete: (callback) => {
    const listener = safeListener(callback);
    ipcRenderer.on('auto-diagnose:scan-complete', listener);
    return () => ipcRenderer.off('auto-diagnose:scan-complete', listener);
  },
  // 智能日志搜索
  smartSearch: (args) => ipcRenderer.invoke('smart-search:search', args),
  smartSearchStop: () => ipcRenderer.invoke('smart-search:stop'),
  onSmartSearchStart: (callback) => {
    const listener = safeListener(callback);
    ipcRenderer.on('smart-search:start', listener);
    return () => ipcRenderer.off('smart-search:start', listener);
  },
  onSmartSearchProgress: (callback) => {
    const listener = safeListener(callback);
    ipcRenderer.on('smart-search:progress', listener);
    return () => ipcRenderer.off('smart-search:progress', listener);
  },
  onSmartSearchChunk: (callback) => {
    const listener = safeListener(callback);
    ipcRenderer.on('smart-search:chunk', listener);
    return () => ipcRenderer.off('smart-search:chunk', listener);
  },
  onSmartSearchComplete: (callback) => {
    const listener = safeListener(callback);
    ipcRenderer.on('smart-search:complete', listener);
    return () => ipcRenderer.off('smart-search:complete', listener);
  },
  // VIP 会员体系
  vipGetStatus: () => ipcRenderer.invoke('vip:getStatus'),
  vipGetMachineId: () => ipcRenderer.invoke('vip:getMachineId'),
  vipActivate: (token) => ipcRenderer.invoke('vip:activate', token),
  vipDeactivate: () => ipcRenderer.invoke('vip:deactivate'),
  // 会员激活记录、备注与复制历史
  vipGetActivationRecords: () => ipcRenderer.invoke('vip:getActivationRecords'),
  vipUpdateActivationRecordNote: (args) => ipcRenderer.invoke('vip:updateActivationRecordNote', args),
  vipAddCopyHistory: (args) => ipcRenderer.invoke('vip:addCopyHistory', args),
  vipClearCopyHistory: () => ipcRenderer.invoke('vip:clearCopyHistory'),
  // App 包管理增强
  packageList: (args) => ipcRenderer.invoke('package:list', args),
  packageDetail: (args) => ipcRenderer.invoke('package:detail', args),
  packagePermissions: (args) => ipcRenderer.invoke('package:permissions', args),
  packageExportApk: (args) => ipcRenderer.invoke('package:exportApk', args),
  packageSnapshot: (args) => ipcRenderer.invoke('package:snapshot', args),
  packageLaunch: (args) => ipcRenderer.invoke('package:launch', args),
  packageBatch: (args) => ipcRenderer.invoke('package:batch', args),
  packageUninstall: (args) => ipcRenderer.invoke('package:uninstall', args),
  packageClearData: (args) => ipcRenderer.invoke('package:clearData', args),
  packageForceStop: (args) => ipcRenderer.invoke('package:forceStop', args),
  packageSetEnabled: (args) => ipcRenderer.invoke('package:setEnabled', args),
  // 性能监控面板
  perfStart: (args) => ipcRenderer.invoke('perf:start', args),
  perfStop: (args) => ipcRenderer.invoke('perf:stop', args),
  perfSnapshot: (args) => ipcRenderer.invoke('perf:snapshot', args),
  perfHistory: (args) => ipcRenderer.invoke('perf:history', args),
  perfState: (args) => ipcRenderer.invoke('perf:state', args),
  perfExport: (args) => ipcRenderer.invoke('perf:export', args),
  perfReport: (args) => ipcRenderer.invoke('perf:report', args),
  perfReportState: (args) => ipcRenderer.invoke('perf:reportState', args),
  perfGetThresholds: () => ipcRenderer.invoke('perf:getThresholds'),
  perfSetThresholds: (args) => ipcRenderer.invoke('perf:setThresholds', args),
  onPerformanceUpdate: (callback) => {
    const listener = safeListener(callback);
    ipcRenderer.on('performance:update', listener);
    return () => ipcRenderer.off('performance:update', listener);
  },
  onPerfReportProgress: (callback) => {
    const listener = safeListener(callback);
    ipcRenderer.on('perf:reportProgress', listener);
    return () => ipcRenderer.off('perf:reportProgress', listener);
  },
  onPerfReportDone: (callback) => {
    const listener = safeListener(callback);
    ipcRenderer.on('perf:reportDone', listener);
    return () => ipcRenderer.off('perf:reportDone', listener);
  },
  // 设备巡检报告与证据包导出
  inspectionStart: (args) => ipcRenderer.invoke('inspection:start', args),
  inspectionCancel: () => ipcRenderer.invoke('inspection:cancel'),
  inspectionState: (args) => ipcRenderer.invoke('inspection:state', args),
  inspectionOpenFolder: (folderPath) => ipcRenderer.invoke('inspection:openFolder', folderPath),
  onInspectionProgress: (callback) => {
    const listener = safeListener(callback);
    ipcRenderer.on('inspection:progress', listener);
    return () => ipcRenderer.off('inspection:progress', listener);
  },
  onInspectionDone: (callback) => {
    const listener = safeListener(callback);
    ipcRenderer.on('inspection:done', listener);
    return () => ipcRenderer.off('inspection:done', listener);
  },
  // 一键问题排查向导
  troubleshootingStart: (args) => ipcRenderer.invoke('troubleshooting:start', args),
  troubleshootingCancel: () => ipcRenderer.invoke('troubleshooting:cancel'),
  troubleshootingState: () => ipcRenderer.invoke('troubleshooting:state'),
  troubleshootingOpenFolder: (folderPath) => ipcRenderer.invoke('troubleshooting:openFolder', folderPath),
  onTroubleshootingProgress: (callback) => {
    const listener = safeListener(callback);
    ipcRenderer.on('troubleshooting:progress', listener);
    return () => ipcRenderer.off('troubleshooting:progress', listener);
  },
  onTroubleshootingDone: (callback) => {
    const listener = safeListener(callback);
    ipcRenderer.on('troubleshooting:done', listener);
    return () => ipcRenderer.off('troubleshooting:done', listener);
  },
  // 任务中心：复现脚本、多设备批量任务和运行历史
  taskScriptsList: () => ipcRenderer.invoke('task-center:scripts:list'),
  taskScriptSave: (args) => ipcRenderer.invoke('task-center:scripts:save', args),
  taskScriptDelete: (args) => ipcRenderer.invoke('task-center:scripts:delete', args),
  taskStressImport: (args) => ipcRenderer.invoke('task-center:stress:import', args),
  taskStressExport: (args) => ipcRenderer.invoke('task-center:stress:export', args),
  taskStressUiSnapshot: (args) => ipcRenderer.invoke('task-center:stress:uiSnapshot', args),
  taskStressRecordAction: (args) => ipcRenderer.invoke('task-center:stress:recordAction', args),
  taskRun: (args) => ipcRenderer.invoke('task-center:run', args),
  taskCancel: (args) => ipcRenderer.invoke('task-center:cancel', args),
  taskHistory: () => ipcRenderer.invoke('task-center:history'),
  taskHistoryClear: () => ipcRenderer.invoke('task-center:history:clear'),
  taskState: () => ipcRenderer.invoke('task-center:state'),
  onTaskCenterUpdate: (callback) => {
    const listener = safeListener(callback);
    ipcRenderer.on('task-center:update', listener);
    return () => ipcRenderer.off('task-center:update', listener);
  },
  // 报告/产物中心
  artifactsList: () => ipcRenderer.invoke('artifacts:list'),
  artifactOpenPath: (targetPath) => ipcRenderer.invoke('artifacts:openPath', targetPath),
  // Quality center: regression baselines and difference reports
  regressionListBaselines: () => ipcRenderer.invoke('regression:listBaselines'),
  regressionCaptureBaseline: (args) => ipcRenderer.invoke('regression:captureBaseline', args),
  regressionDeleteBaseline: (args) => ipcRenderer.invoke('regression:deleteBaseline', args),
  regressionRun: (args) => ipcRenderer.invoke('regression:run', args),
  acceptanceListSuites: () => ipcRenderer.invoke('acceptance:listSuites'),
  acceptanceRun: (args) => ipcRenderer.invoke('acceptance:run', args),
  deviceGuardStart: (args) => ipcRenderer.invoke('device-guard:start', args),
  deviceGuardStop: (args) => ipcRenderer.invoke('device-guard:stop', args),
  deviceGuardState: () => ipcRenderer.invoke('device-guard:state'),
  onDeviceGuardUpdate: (callback) => {
    const listener = safeListener(callback);
    ipcRenderer.on('device-guard:update', listener);
    return () => ipcRenderer.off('device-guard:update', listener);
  },
  // 设备连接与环境自检
  envCheckRun: (args) => ipcRenderer.invoke('env-check:run', args),
  envCheckRestartAdb: () => ipcRenderer.invoke('env-check:restartAdb')
});
