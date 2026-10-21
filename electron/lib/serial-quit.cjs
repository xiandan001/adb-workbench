async function confirmSerialQuit({ serial, ask, save }) {
  if (!serial.needsQuitConfirmation()) return true;
  const state = serial.snapshot();
  const hasEntries = state.entries.length > 0;
  const answer = await ask({
    type: 'question', title: '串口会话尚未结束',
    message: state.unsaved ? '串口有尚未保存的收发记录。' : `串口 ${state.path || ''} 仍在使用中。`,
    detail: hasEntries ? '保存当前记录后会留在软件中。直接退出将关闭串口并放弃未保存的记录；不会自动重连或补发。' : '退出将关闭串口，不会自动重连或补发命令。',
    buttons: hasEntries ? ['保存当前记录', '直接退出', '取消'] : ['直接退出', '取消'],
    defaultId: hasEntries ? 0 : 1, cancelId: hasEntries ? 2 : 1, noLink: true
  });
  if (hasEntries && answer.response === 0) { await save(); return false; }
  return answer.response === (hasEntries ? 1 : 0);
}

module.exports = { confirmSerialQuit };
