async function confirmRecordingQuit({ recordings, ask }) {
  const unresolved = recordings.listUnresolved();
  if (!unresolved.length) return true;
  const answer = await ask({
    type: 'question', title: '录屏尚未保存',
    message: `还有 ${unresolved.length} 段录屏正在进行或尚未保存到电脑。`,
    detail: '建议停止并保存后退出。视频和已启用的关联日志会一起完成保存。',
    buttons: ['停止并保存后退出', '取消'], defaultId: 0, cancelId: 1, noLink: true
  });
  if (answer.response !== 0) return false;
  await recordings.stopAllRecordings();
  const remaining = recordings.listUnresolved();
  if (!remaining.length) return true;
  const failure = await ask({
    type: 'warning', title: '部分录屏未能保存',
    message: `${remaining.length} 段录屏仍未完成保存。`,
    detail: '设备上的原文件及本机恢复记录会保留。可返回设备页重试，或退出后连接原设备重新保存。',
    buttons: ['返回并重试', '保留恢复记录并退出'], defaultId: 0, cancelId: 0, noLink: true
  });
  return failure.response === 1;
}

module.exports = { confirmRecordingQuit };
