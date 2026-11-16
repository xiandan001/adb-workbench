const { parentPort, workerData } = require('node:worker_threads');
const compiled = new Map();
parentPort.on('message', message => {
  if (message.type !== 'match') return;
  let activeRule = '';
  try {
    const matches = new Map();
    for (const rule of workerData.rules) {
      activeRule = rule.id; parentPort.postMessage({ type: 'rule-start', jobId: message.jobId, ruleId: rule.id });
      if (!compiled.has(rule.id)) compiled.set(rule.id, new RegExp(rule.pattern, rule.flags));
      const regex = compiled.get(rule.id);
      for (let index = 0; index < message.lines.length; index++) {
        if (matches.has(index)) continue;
        const line = message.lines[index];
        if (rule.keywords.length && !rule.keywords.some(word => line.includes(word))) continue;
        regex.lastIndex = 0;
        if (regex.test(line)) matches.set(index, { index, type: rule.type, label: rule.label, severity: rule.severity, ruleId: rule.id });
      }
    }
    parentPort.postMessage({ type: 'result', jobId: message.jobId, matches: [...matches.values()].sort((a, b) => a.index - b.index) });
  } catch (error) { parentPort.postMessage({ type: 'error', jobId: message.jobId, ruleId: activeRule, error: error.message }); }
});
parentPort.postMessage({ type: 'ready' });
