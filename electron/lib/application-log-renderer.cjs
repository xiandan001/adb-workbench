const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { own, normalizeCodeArguments, bounded } = require('./application-log-text.cjs');

function trustedSource(value, appRoot, isDev = false) {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const url = new URL(value);
    if (isDev && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.port === '5173') return true;
    if (url.protocol !== 'file:') return false;
    const relative = path.relative(path.resolve(appRoot), path.resolve(fileURLToPath(url)));
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  } catch { return false; }
}
function observeRenderer(contents, { record, isEnabled, appRoot, isDev = false, noteLoss = () => {} }) {
  const trusted = () => { try { return !contents.isDestroyed() && trustedSource(contents.getURL(), appRoot, isDev); } catch { return false; } };
  const onConsole = (details, legacyLevel, legacyMessage, legacyLine, legacySource) => {
    if (!isEnabled() || !trusted()) return;
    const message = own(details, 'message') ?? legacyMessage, source = own(details, 'sourceId') ?? legacySource;
    const frame = own(details, 'frame') ?? own(details, 'senderFrame');
    if (frame !== contents.mainFrame || !trustedSource(source, appRoot, isDev)) { noteLoss('sensitive-output', 1); return; }
    const level = own(details, 'level') ?? ['debug', 'info', 'warning', 'error'][legacyLevel];
    const line = own(details, 'lineNumber') ?? legacyLine;
    if (!['debug', 'info', 'warning', 'error'].includes(level) || typeof message !== 'string') return;
    record({ source: 'code', event: 'console', origin: 'renderer', level: level === 'warning' ? 'warn' : level,
      ...normalizeCodeArguments([message]), location: bounded(`${source}${Number.isSafeInteger(line) && line > 0 ? `:${line}` : ''}`).text });
  };
  const onGone = (_event, details) => { const code = own(details, 'exitCode'); if (isEnabled() && trusted()) record({ source: 'app', event: 'renderer-gone', component: 'renderer', errorNumber: typeof code === 'number' ? Math.abs(code) : 0 }); };
  contents.on('console-message', onConsole); contents.on('render-process-gone', onGone);
  let active = true;
  return () => { if (!active) return; active = false; contents.removeListener('console-message', onConsole); contents.removeListener('render-process-gone', onGone); };
}
module.exports = { observeRenderer, trustedSource };
