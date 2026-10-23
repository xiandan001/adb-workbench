const { createAppMessageDialogService, normalizeOptions } = require('./app-message-dialog-service.cjs');
let service;
function register(ipcMain) {
  service = createAppMessageDialogService({ getOwner: () => require('./app-context.cjs').getMainWindow() });
  service.register(ipcMain);
}
function ask(options) {
  if (service) return service.ask(options);
  const value = normalizeOptions(options); return Promise.resolve({ response: value.cancelId, checkboxChecked: value.checkboxChecked });
}
module.exports = { register, ask, cleanup: () => service?.dispose() };
