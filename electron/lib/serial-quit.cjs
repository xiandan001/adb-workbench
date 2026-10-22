async function confirmSerialQuit({ serial, ask, save }) {
  if (!serial.needsQuitConfirmation()) return true;
  const states = serial.snapshots();
  const labels = { rs232: 'RS232 调试', terminal: '串口终端' };
  const dirty = Object.entries(states).filter(([, state]) => state.unsaved).map(([workspace]) => labels[workspace]);
  const hasEntries = Object.values(states).some(state => state.entries.length > 0);
  const answer = await ask({
    type: 'question', title: '串口会话尚未结束',
    message: dirty.length ? `${dirty.join('、')}有尚未保存的收发记录。` : '串口连接仍在使用中。',
    detail: hasEntries ? '两侧未保存的记录将分别导出，保存后留在软件中。直接退出将关闭两侧连接并放弃未保存的记录；不会自动重连或补发。' : '退出将关闭两侧串口连接，不会自动重连或补发命令。',
    buttons: hasEntries ? ['分别保存记录', '直接退出', '取消'] : ['直接退出', '取消'],
    defaultId: hasEntries ? 0 : 1, cancelId: hasEntries ? 2 : 1, noLink: true
  });
  if (hasEntries && answer.response === 0) { await save(); return false; }
  return answer.response === (hasEntries ? 1 : 0);
}

module.exports = { confirmSerialQuit };
