const { types } = require('node:util');
const { own } = require('./application-log-text.cjs');
const { toolIdentity } = require('./application-log-tools.cjs');

function classifyToolCall(executable, argumentsValue) {
  const tool = toolIdentity(executable), excluded = { tool, operation: 'process', stdout: 'sensitive', stderr: 'sensitive' };
  if (!Array.isArray(argumentsValue) || types.isProxy(argumentsValue) || argumentsValue.length > 256) return excluded;
  const args = [];
  for (let index = 0; index < argumentsValue.length; index++) {
    const value = own(argumentsValue, String(index));
    if (typeof value !== 'string' || value.length > 4096) return excluded;
    args.push(value);
  }
  const text = operation => ({ tool, operation, stdout: 'text', stderr: 'text' });
  if (tool === 'scrcpy') return text(args.includes('--version') ? 'version' : 'mirror');
  if (args.length === 1 && ['--version', '-V', '-version'].includes(args[0])) return text('version');
  if (!['adb', 'hdc'].includes(tool)) return excluded;
  while (['-s', '-t', '-H', '-P'].includes(args[0]) && args.length >= 2) args.splice(0, 2);
  if (['-d', '-e'].includes(args[0])) args.shift();
  if (args[0] === 'version' || tool === 'hdc' && args[0] === '-v') return text('version');
  if (tool === 'adb' && args[0] === 'devices' || tool === 'hdc' && args[0] === 'list' && args[1] === 'targets') return text('list');
  if (['connect', 'tconn', 'disconnect', 'get-state', 'start-server', 'kill-server'].includes(args[0])) return text(['disconnect', 'kill-server'].includes(args[0]) ? 'disconnect' : 'connect');
  if (args[0] !== 'shell') return excluded;
  const command = args.slice(1).join(' ');
  if (/^(?:getprop (?:ro\.build\.version\.(?:release|sdk|incremental)|ro\.product\.(?:model|brand|manufacturer))|wm (?:size|density)|cat \/proc\/meminfo|param get (?:const\.product\.(?:model|brand|manufacturer)|const\.ohos\.(?:apiversion|fullname)))$/.test(command)) return text('diagnostic');
  return excluded;
}
module.exports = { classifyToolCall };
