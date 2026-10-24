const { tr } = require('./localization.cjs');

// Build a send-only copy: previous answers, user prompts and log evidence remain untouched in storage.
function analysisMessages(systemPrompt, history, userContent) {
  const instruction = tr('请使用简体中文回答，保留用户原始日志和命令不变。');
  return [{ role: 'system', content: `${systemPrompt}\n\n${instruction}` },
    ...history.filter(message => message.role !== 'system').map(message => ({ ...message })),
    { role: 'user', content: userContent }];
}

module.exports = { analysisMessages };
