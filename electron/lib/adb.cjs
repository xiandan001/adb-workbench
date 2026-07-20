// ADB / scrcpy 操作 IPC handlers
// 该模块管理 screenRecordProcs（只在内部使用），并提供 stopAllScreenRecords 供 before-quit 调用

const { execFile, spawn } = require('child_process');
const path = require('path');
const { findScrcpyPath } = require('./commands.cjs');
const { findExecutable } = require('./android-tool-cleanup.cjs');
const { runAdb, spawnAdb } = require('./adb-runtime.cjs');
const { parseAdbDeviceRows } = require('./adb-device-parser.cjs');

// ScreenRecord: Android native screen recording via adb shell screenrecord
const screenRecordProcs = new Map();

// 终端 shell 执行：记录运行中的进程，支持主动中断
// key: requestId, value: { proc, deviceId, timer, settle }
const shellProcs = new Map();
// 交互式命令（su/sh/top 等）不会自然退出，设置兜底超时强制结束
const SHELL_TIMEOUT_MS = 30000;
const UNLOCK_ADB_REBOOT_TIMEOUT_MS = 15000;
const UNLOCK_PLATFORM_PROBE_TIMEOUT_MS = 5000;
const UNLOCK_FASTBOOT_COMMAND_TIMEOUT_MS = 300000;
const SCRCPY_STARTUP_WATCH_MS = 10000;
const SCRCPY_READY_GRACE_MS = 800;
const SCRCPY_AUDIO_PROBE_MS = 7000;
const scrcpyAudioModeCache = new Map();

function buildScrcpyArgs(deviceId, settings, extraArgs = []) {
  const args = ['-s', deviceId, '--window-title', `Scrcpy - ${deviceId}`];

  if (settings) {
    if (settings.screenOff) {
      args.push('--turn-screen-off');
    }
    if (settings.stayAwake) {
      args.push('--stay-awake');
    }
    if (settings.bitrate && settings.bitrate !== '0') {
      const bitrateValue = settings.bitrate.replace(' Mbps', 'M');
      args.push('--video-bit-rate', bitrateValue);
    }
    if (settings.maxSize && settings.maxSize !== '0') {
      args.push('--max-size', settings.maxSize);
    }
  }

  return args.concat(extraArgs);
}

function isScrcpyAudioStartupError(output) {
  return output.includes('Cannot create AudioRecord')
    || output.includes("Demuxer 'audio': stream configuration error")
    || (output.includes('Demuxer error') && output.toLowerCase().includes('audio'));
}

function isScrcpyVideoReady(output) {
  return /INFO:\s+(?:Texture|New texture|Initial texture):/i.test(output);
}

function quoteWindowsCommandArg(value) {
  const text = String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function buildScrcpySpawn(scrcpyPath, args) {
  if (process.platform !== 'win32') {
    return {
      command: scrcpyPath,
      args,
      options: {
        cwd: path.dirname(scrcpyPath),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    };
  }

  const commandLine = ['call', quoteWindowsCommandArg(scrcpyPath), ...args.map(quoteWindowsCommandArg)].join(' ');
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/c', commandLine],
    options: {
      cwd: path.dirname(scrcpyPath),
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  };
}

function stopScrcpyStartupProcess(proc) {
  return new Promise((resolve) => {
    if (!proc || !proc.pid || proc.killed) {
      resolve();
      return;
    }

    try {
      if (process.platform === 'win32') {
        execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
      } else {
        proc.kill('SIGTERM');
        resolve();
      }
    } catch (error) {
      console.error('Failed to stop failed scrcpy process:', error);
      resolve();
    }
  });
}

function probeScrcpyAudio(deviceId, scrcpyPath, args) {
  return new Promise((resolve) => {
    let settled = false;
    let output = '';
    let timer = null;
    const probeArgs = args
      .filter(arg => arg !== '--no-audio')
      .concat('--no-window', '--require-audio');
    const scrcpySpawn = buildScrcpySpawn(scrcpyPath, probeArgs);
    const proc = spawn(scrcpySpawn.command, scrcpySpawn.args, scrcpySpawn.options);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.stdout?.removeListener('data', handleOutput);
      proc.stderr?.removeListener('data', handleOutput);
      proc.removeListener('close', handleClose);
      proc.removeListener('error', handleError);
      stopScrcpyStartupProcess(proc).then(() => resolve(result));
    };

    const handleOutput = (data) => {
      output += data.toString();
      if (isScrcpyAudioStartupError(output)) {
        console.warn(`[Scrcpy] Audio probe failed for ${deviceId}`);
        finish(false);
      }
    };

    const handleClose = () => {
      finish(!isScrcpyAudioStartupError(output));
    };

    const handleError = (error) => {
      console.warn(`[Scrcpy] Audio probe failed to start for ${deviceId}:`, error.message);
      finish(true);
    };

    proc.stdout?.on('data', handleOutput);
    proc.stderr?.on('data', handleOutput);
    proc.on('close', handleClose);
    proc.on('error', handleError);

    timer = setTimeout(() => {
      finish(true);
    }, SCRCPY_AUDIO_PROBE_MS);
  });
}

function startScrcpyProcess(deviceId, scrcpyPath, args, options = {}) {
  const { retryWithoutAudio = true, retriedWithoutAudio = false } = options;

  return new Promise((resolve, reject) => {
    let settled = false;
    let output = '';
    let startupTimer = null;
    let readyTimer = null;

    console.log(`Starting scrcpy with device: ${deviceId}, args: ${args.join(' ')}`);

    const scrcpySpawn = buildScrcpySpawn(scrcpyPath, args);
    const proc = spawn(scrcpySpawn.command, scrcpySpawn.args, scrcpySpawn.options);

    const cleanup = () => {
      clearTimeout(startupTimer);
      clearTimeout(readyTimer);
      proc.stdout?.removeListener('data', handleOutput);
      proc.stderr?.removeListener('data', handleOutput);
      proc.removeListener('error', handleError);
      proc.removeListener('close', handleClose);
      proc.stdout?.resume();
      proc.stderr?.resume();
      proc.stdout?.unref?.();
      proc.stderr?.unref?.();
      proc.unref?.();
    };

    const settle = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const retryNoAudio = () => {
      console.warn(`[Scrcpy] Audio startup failed for ${deviceId}, retrying with --no-audio`);
      scrcpyAudioModeCache.set(deviceId, 'no-audio');
      const noAudioArgs = args.includes('--no-audio') ? args : args.concat('--no-audio');
      stopScrcpyStartupProcess(proc)
        .then(() => startScrcpyProcess(deviceId, scrcpyPath, noAudioArgs, {
          retryWithoutAudio: false,
          retriedWithoutAudio: true
        }))
        .then(resolve, reject);
    };

    const resolveStarted = () => {
      settle(() => {
        resolve({
          success: true,
          message: retriedWithoutAudio ? 'Scrcpy 已使用无音频模式启动' : 'Scrcpy 已启动'
        });
      });
    };

    const scheduleReadyResolve = () => {
      if (readyTimer) return;
      readyTimer = setTimeout(resolveStarted, SCRCPY_READY_GRACE_MS);
    };

    function handleOutput(data) {
      output += data.toString();
      if (retryWithoutAudio && isScrcpyAudioStartupError(output)) {
        settle(retryNoAudio);
        return;
      }
      if (isScrcpyVideoReady(output)) {
        scheduleReadyResolve();
      }
    }

    function handleError(error) {
      settle(() => {
        console.error('Scrcpy spawn error:', error);
        reject(new Error(`Scrcpy 启动失败: ${error.message}`));
      });
    }

    function handleClose(code, signal) {
      if (settled) return;
      if (retryWithoutAudio && isScrcpyAudioStartupError(output)) {
        settle(retryNoAudio);
        return;
      }
      if (code !== 0) {
        const lastOutput = output.trim().split(/\r?\n/).slice(-3).join('；');
        const suffix = lastOutput ? `，${lastOutput}` : '';
        settle(() => reject(new Error(`Scrcpy 启动失败，退出码: ${code ?? signal ?? 'unknown'}${suffix}`)));
      }
    }

    proc.stdout?.on('data', handleOutput);
    proc.stderr?.on('data', handleOutput);
    proc.on('error', handleError);
    proc.on('close', handleClose);
    proc.on('spawn', () => {
      console.log('Scrcpy process spawned successfully');
    });

    startupTimer = setTimeout(() => {
      resolveStarted();
    }, SCRCPY_STARTUP_WATCH_MS);
  });
}

// 应用退出时自动停止所有录屏进程
async function stopAllScreenRecords() {
  if (screenRecordProcs.size === 0) return;
  console.log(`[ScreenRecord] Stopping ${screenRecordProcs.size} recording(s) before quit...`);
  const promises = [];
  for (const [deviceId, proc] of screenRecordProcs) {
    promises.push(new Promise((resolve) => {
      try {
        proc.kill('SIGTERM');
      } catch (e) {
        console.error(`[ScreenRecord] Failed to kill process for ${deviceId}:`, e.message);
      }
      // 尝试通过 adb 停止设备端的 screenrecord 进程
      runAdb(['-s', deviceId, 'shell', 'pkill', '-l', '2', '-f', 'screenrecord'], { timeoutMs: 5000 })
        .finally(() => {
          screenRecordProcs.delete(deviceId);
          resolve();
        });
    }));
  }
  await Promise.all(promises);
  console.log('[ScreenRecord] All recordings stopped.');
}

// 判断是否有正在进行的录屏（供 before-quit 决定是否 preventDefault）
function hasActiveScreenRecords() {
  return screenRecordProcs.size > 0;
}

function runTool(command, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: timeoutMs }, (error, stdout, stderr) => {
      const output = [stdout, stderr].filter(Boolean).join('\n').trim();
      resolve({
        success: !error,
        output,
        error: error ? (output || error.message) : ''
      });
    });
  });
}

function getAndroidToolCommand(executableName) {
  return findExecutable(executableName) || executableName.replace(/\.exe$/i, '');
}

function hasFastbootFinished(output) {
  return /\bFinished\./i.test(String(output || ''));
}

function adbOutput(res) {
  return [res?.stdout, res?.stderr]
    .map(value => Buffer.isBuffer(value) ? value.toString('utf8') : String(value || ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function runAdbText(args, options = {}) {
  const res = await runAdb(args, options);
  const output = adbOutput(res);
  if (!res.ok) {
    throw new Error(output || res.error || 'ADB command failed');
  }
  return output;
}

function selectUnlockPlan(platformOutput) {
  const normalized = String(platformOutput || '').toLowerCase();
  const isRockchip = /rockchip|(?:^|[\s._-])rk\d+/.test(normalized);
  return {
    unlockArgs: isRockchip ? ['oem', 'at-unlock-vboot'] : ['flashing', 'unlock'],
    rebootCount: isRockchip ? 2 : 1
  };
}

async function resolveUnlockPlan(deviceId) {
  try {
    const platformOutput = await runAdbText([
      '-s',
      deviceId,
      'shell',
      'getprop ro.hardware; getprop ro.board.platform; getprop ro.boot.hardware'
    ], { timeoutMs: UNLOCK_PLATFORM_PROBE_TIMEOUT_MS });
    return selectUnlockPlan(platformOutput);
  } catch (error) {
    console.warn(`[Unlock] 芯片平台检测失败，按 MTK 指令继续：${error.message}`);
    return {
      unlockArgs: ['flashing', 'unlock'],
      rebootCount: 1
    };
  }
}

function parseAdbDevices(text) {
  return parseAdbDeviceRows(text).map(({ id, status, detail }) => {
    const model = detail.match(/model:([^\s]+)/)?.[1] || '';
    return {
      id,
      status,
      model: status === 'device' ? model : 'Unauthorized / Offline'
    };
  });
}

async function fillMissingDeviceModels(devices) {
  await Promise.all(devices.map(async (device) => {
    if (device.status !== 'device') return;
    if (device.model) return;
    try {
      const model = await runAdbText(['-s', device.id, 'shell', 'getprop', 'ro.product.model'], {
        timeoutMs: 8000
      });
      device.model = model || 'Unknown Device';
    } catch {
      device.model = 'Unknown Device';
    }
  }));
  return devices;
}

// 应用退出时清理所有未结束的终端 shell 进程
function stopAllShellProcs() {
  if (shellProcs.size === 0) return;
  for (const [, entry] of shellProcs) {
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    try { if (!entry.proc.killed) entry.proc.kill(); } catch (e) {}
    if (typeof entry.settle === 'function') entry.settle('cancelled');
  }
  shellProcs.clear();
}

function register(ipcMain) {
  // IPC Handlers for ADB
  ipcMain.handle('adb:getDevices', async () => {
    try {
      const output = await runAdbText(['devices', '-l'], { timeoutMs: 10000, queueGlobal: true });
      return fillMissingDeviceModels(parseAdbDevices(output));
    } catch (error) {
      console.error('ADB error:', error);
      throw new Error('ADB is not installed or not running.');
    }
  });

  ipcMain.handle('scrcpy:start', async (event, { deviceId, settings }) => {
    try {
      const scrcpyPath = await findScrcpyPath();
      if (!scrcpyPath) {
        throw new Error('Scrcpy 未安装或未添加到 PATH。请安装 Scrcpy 并确保在命令行中可用。\n\n安装方法：\n1. Windows: winget install scrcpy 或从 https://github.com/Genymobile/scrcpy/releases 下载\n2. 确保 scrcpy.exe 所在目录已添加到系统 PATH');
      }

      const args = buildScrcpyArgs(deviceId, settings);
      const audioMode = scrcpyAudioModeCache.get(deviceId);
      if (audioMode === 'no-audio') {
        return await startScrcpyProcess(deviceId, scrcpyPath, args.concat('--no-audio'), {
          retryWithoutAudio: false,
          retriedWithoutAudio: true
        });
      }

      if (audioMode !== 'normal') {
        const audioAvailable = await probeScrcpyAudio(deviceId, scrcpyPath, args);
        scrcpyAudioModeCache.set(deviceId, audioAvailable ? 'normal' : 'no-audio');
        if (!audioAvailable) {
          return await startScrcpyProcess(deviceId, scrcpyPath, args.concat('--no-audio'), {
            retryWithoutAudio: false,
            retriedWithoutAudio: true
          });
        }
      }

      return await startScrcpyProcess(deviceId, scrcpyPath, args);
    } catch (error) {
      console.error('Scrcpy error:', error);
      throw error;
    }
  });

  // Basic device control handlers
  // 用户输入的 command（含 |、>、< 等）整体传给 Android shell 执行
  ipcMain.handle('adb:shell', async (event, { deviceId, command }) => {
    const requestId = `${deviceId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const result = await new Promise((resolve) => {
        const proc = spawnAdb(['-s', deviceId, 'shell', command], {
          encoding: 'utf8'
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const entry = { proc, deviceId, timer: null, settle: null };

        const settle = (status) => {
          if (settled) return;
          settled = true;
          if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
          shellProcs.delete(requestId);
          resolve({ status, stdout: stdout.trim(), stderr: stderr.trim() });
        };
        entry.settle = settle;

        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });
        proc.on('error', () => settle('error'));

        // 超时兜底：su 等交互式命令会一直挂起，到点强制结束并返回已收集输出
        entry.timer = setTimeout(() => {
          try { proc.kill(); } catch (e) {}
          settle('timeout');
        }, SHELL_TIMEOUT_MS);

        shellProcs.set(requestId, entry);

        proc.on('close', (code) => {
          settle(code === 0 ? 'ok' : 'fail');
        });
      });

      if (result.status === 'ok') {
        return { success: true, output: result.stdout };
      }
      if (result.status === 'fail') {
        return { success: false, error: result.stderr || `命令执行失败（退出码异常）`, output: result.stdout };
      }
      if (result.status === 'timeout') {
        const hint = `命令执行超时（${SHELL_TIMEOUT_MS / 1000} 秒），可能进入了交互式 Shell（如 su/sh/top），已自动结束`;
        return { success: false, error: hint, output: result.stdout || result.stderr };
      }
      if (result.status === 'cancelled') {
        return { success: false, cancelled: true, error: '命令已中断', output: result.stdout };
      }
      return { success: false, error: result.stderr || '命令启动失败' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // 中断指定设备正在执行的 shell 命令
  ipcMain.handle('adb:shell:cancel', async (event, { deviceId }) => {
    let killed = 0;
    for (const [id, entry] of [...shellProcs]) {
      if (entry.deviceId !== deviceId) continue;
      try { if (!entry.proc.killed) entry.proc.kill(); } catch (e) {}
      entry.settle('cancelled');
      killed++;
    }
    return { success: true, killed };
  });

  // Screenshot: pull file from device
  ipcMain.handle('adb:screenshot', async (event, { deviceId, localPath }) => {
    try {
      const output = await runAdbText(['-s', deviceId, 'pull', '/sdcard/screen.png', localPath]);
      return { success: true, output };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('adb:screenrecord:start', async (event, { deviceId, remotePath }) => {
    try {
      if (screenRecordProcs.has(deviceId)) {
        return { success: false, error: '当前设备正在录屏中，请先停止' };
      }
      const p = spawnAdb(['-s', deviceId, 'shell', 'screenrecord', remotePath || '/sdcard/screenrecord.mp4'], {
        detached: false
      });
      screenRecordProcs.set(deviceId, p);
      p.on('exit', () => {
        screenRecordProcs.delete(deviceId);
      });
      p.on('error', () => {
        screenRecordProcs.delete(deviceId);
      });
      return { success: true, message: '录屏已开始' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('adb:screenrecord:stop', async (event, { deviceId, localPath }) => {
    try {
      const p = screenRecordProcs.get(deviceId);
      if (p) {
        p.kill();
        screenRecordProcs.delete(deviceId);
      } else {
        await runAdb(['-s', deviceId, 'shell', 'pkill', '-l', '2', '-f', 'screenrecord'], { timeoutMs: 5000 }).catch(() => {});
      }
      await new Promise(r => setTimeout(r, 800));
      const remotePath = '/sdcard/screenrecord.mp4';
      await runAdbText(['-s', deviceId, 'pull', remotePath, localPath]);
      await runAdb(['-s', deviceId, 'shell', 'rm', '-f', remotePath], { timeoutMs: 5000 }).catch(() => {});
      return { success: true, message: '录屏已停止并保存', path: localPath };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('adb:screenrecord:status', async (event, { deviceId }) => {
    return { recording: screenRecordProcs.has(deviceId) };
  });

  // Reboot device
  ipcMain.handle('adb:reboot', async (event, { deviceId }) => {
    try {
      spawnAdb(['-s', deviceId, 'reboot'], {
        detached: true,
        stdio: 'ignore'
      }).unref();
      return { success: true, message: '设备正在重启' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Reboot to loader mode
  ipcMain.handle('adb:rebootLoader', async (event, { deviceId }) => {
    try {
      spawnAdb(['-s', deviceId, 'reboot', 'loader'], {
        detached: true,
        stdio: 'ignore'
      }).unref();
      return { success: true, message: '设备正在进入loader模式' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('adb:unlock', async (event, { deviceId }) => {
    try {
      const adbCommand = getAndroidToolCommand('adb.exe');
      const fastbootCommand = getAndroidToolCommand('fastboot.exe');
      const unlockPlan = await resolveUnlockPlan(deviceId);
      const reboot = await runTool(adbCommand, ['-s', deviceId, 'reboot', 'bootloader'], UNLOCK_ADB_REBOOT_TIMEOUT_MS);
      if (!reboot.success) {
        return { success: false, error: `进入 bootloader 失败：${reboot.error}` };
      }

      const unlock = await runTool(fastbootCommand, unlockPlan.unlockArgs, UNLOCK_FASTBOOT_COMMAND_TIMEOUT_MS);
      if (!unlock.success) {
        return { success: false, error: `Unlock 失败：${unlock.error}` };
      }
      if (!hasFastbootFinished(unlock.output)) {
        return { success: false, error: `Unlock 未检测到 Finished 标识：${unlock.output || '无输出'}` };
      }

      for (let rebootIndex = 1; rebootIndex <= unlockPlan.rebootCount; rebootIndex += 1) {
        const fastbootReboot = await runTool(fastbootCommand, ['reboot'], 30000);
        const rebootLabel = unlockPlan.rebootCount > 1 ? `第 ${rebootIndex} 次` : '';
        if (!fastbootReboot.success) {
          return { success: false, error: `Unlock 已执行，但${rebootLabel}重启失败：${fastbootReboot.error}` };
        }
        if (!hasFastbootFinished(fastbootReboot.output)) {
          return { success: false, error: `Unlock 已执行，但${rebootLabel}重启未检测到 Finished 标识：${fastbootReboot.output || '无输出'}` };
        }
      }

      return {
        success: true,
        message: 'Unlock 已完成，设备正在重启'
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Adb root
  ipcMain.handle('adb:root', async (event, { deviceId }) => {
    try {
      const output = await runAdbText(['-s', deviceId, 'root']);
      if (output.includes('restarting') || output.includes('running as root')) {
        return { success: true, message: output || 'Root 权限获取成功' };
      } else {
        return { success: false, error: output || 'Root 权限获取失败，设备可能不支持或未解锁' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Adb remount
  ipcMain.handle('adb:remount', async (event, { deviceId }) => {
    try {
      const output = await runAdbText(['-s', deviceId, 'remount']);
      if (output.includes('remount') || output.includes('succeeded') || output.includes('success')) {
        return { success: true, message: output || 'Remount 成功' };
      } else {
        return { success: false, error: output || 'Remount 失败，可能需要先执行 root' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Wi-Fi Connection
  ipcMain.handle('adb:connect', async (event, ipAddress) => {
    try {
      const output = await runAdbText(['connect', ipAddress], { queueGlobal: true });
      if (output.includes('connected to') && !output.includes('already connected')) {
        return { success: true, message: output };
      } else if (output.includes('already connected')) {
        return { success: true, message: output };
      } else {
        return { success: false, error: output };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Install APK
  ipcMain.handle('adb:install', async (event, { deviceId, apkPath }) => {
    try {
      const output = await runAdbText(['-s', deviceId, 'install', '-r', '-d', apkPath], { timeoutMs: 120000 });
      if (output.includes('Success')) {
        return { success: true, message: '安装成功' };
      } else {
        return { success: false, error: output || '安装失败' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Push APK to device
  ipcMain.handle('adb:push', async (event, { deviceId, localPath, remotePath }) => {
    try {
      const output = await runAdbText(['-s', deviceId, 'push', localPath, remotePath], { timeoutMs: 120000 });
      if (output.includes('pushed') || output.includes('pushing')) {
        return { success: true, message: '推送成功' };
      } else {
        return { success: false, error: output || '推送失败' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Pull file from device
  ipcMain.handle('adb:pull', async (event, { deviceId, remotePath, localPath }) => {
    try {
      const output = await runAdbText(['-s', deviceId, 'pull', remotePath, localPath], { timeoutMs: 120000 });
      if (output.includes('pulled') || output.includes('pulling')) {
        return { success: true, message: `拉取成功！\n设备: ${remotePath}\n本地: ${localPath}` };
      } else if (output.includes('does not exist')) {
        return { success: false, error: '文件不存在' };
      } else {
        return { success: false, error: output || '拉取失败' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // List files on device (for browsing APK paths)
  ipcMain.handle('adb:shellLs', async (event, { deviceId, path }) => {
    try {
      const cleanPath = (p) => {
        if (p === '/' || p === '') return '/';
        const parts = p.split('/').filter(part => part && part !== '.');
        let result = '/' + parts.join('/');
        return result || '/';
      };

      const getParentPath = (p) => {
        if (p === '/' || p === '') return '/';
        const parts = p.split('/').filter(part => part && part !== '.');
        parts.pop();
        return parts.length === 0 ? '/' : '/' + parts.join('/');
      };

      const safePath = cleanPath(path);
      const output = await runAdbText(['-s', deviceId, 'shell', 'ls', '-la', safePath]);
      const lines = output.trim().split('\n').filter(line => line.length > 0);
      const items = [];

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const parts = line.split(/\s+/);
        if (parts.length < 8) continue;

        const perms = parts[0];
        const size = parts[4];
        const name = parts.slice(7).join(' ');
        const isDir = perms.startsWith('d');
        const isLink = perms.includes('l');

        let itemPath;
        if (name === '.') {
          itemPath = safePath;
        } else if (name === '..') {
          itemPath = getParentPath(safePath);
        } else {
          itemPath = safePath === '/' ? `/${name}` : `${safePath}/${name}`;
        }

        items.push({
          name,
          isDirectory: name === '..' || name === '.' ? true : isDir,
          isLink,
          size: isDir ? null : size,
          path: itemPath
        });
      }

      return { success: true, items, currentPath: safePath };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Disconnect Device
  ipcMain.handle('adb:disconnect', async (event, deviceId) => {
    try {
      const output = await runAdbText(['disconnect', deviceId], { queueGlobal: true });
      return { success: true, message: output };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // 定期清理 screenRecordProcs 中已退出的进程，防止 Map 累积僵尸条目
  // 每 60 秒遍历一次，检查 p.killed || p.exitCode !== null
  setInterval(() => {
    if (screenRecordProcs.size === 0) return;
    for (const [devId, p] of screenRecordProcs) {
      if (p.killed || p.exitCode !== null) {
        console.log(`[ScreenRecord] 定期清理：设备 ${devId} 的录屏进程已退出，从 Map 中删除`);
        screenRecordProcs.delete(devId);
      }
    }
  }, 60000).unref();
}

module.exports = {
  register,
  stopAllShellProcs,
  stopAllScreenRecords,
  hasActiveScreenRecords,
};
