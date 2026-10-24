const fs = require('node:fs');
const path = require('node:path');
const { auditProject } = require('./i18n-audit.cjs');
const rootIndex = process.argv.indexOf('--root');
const result = auditProject(rootIndex >= 0 ? path.resolve(process.argv[rootIndex + 1]) : path.resolve(__dirname, '..'));
const reportIndex = process.argv.indexOf('--report');
if (reportIndex >= 0) fs.writeFileSync(path.resolve(process.argv[reportIndex + 1]), JSON.stringify(result, null, 2) + '\n');
for (const item of result.diagnostics.slice(0, 80)) console.error(`${item.file}:${item.line}:${item.column || 1} [i18n/${item.kind}] ${item.message}${item.id ? ` (${item.id})` : ''}`);
if (!result.ok) {
  console.error(`Localization failed: ${result.diagnostics.length} issue(s). Run with --report <path> for the full report.`);
  process.exitCode = 1;
} else console.log(`Localization passed: ${result.files} source files, ${result.messages} message keys, ${result.catalogEntries} English translations.`);
