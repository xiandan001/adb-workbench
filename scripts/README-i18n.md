# Localization checks

The application supports `zh-CN` (default) and `en-US`. Preferences > Appearance
owns language selection. The main process saves it and synchronizes both windows.
Switching language must not recreate a terminal, change a task target, or rewrite
user data.

## Add application text

```jsx
import { tr, useLocale } from '../shared/i18n.js';

function Example({ count, fileName }) {
  useLocale();
  return <p>{tr('已保存 {0} 个文件：{1}', { 0: count, 1: fileName })}</p>;
}
```

Add the exact source key and an English translation to the appropriate
`electron/locales/en-*.json` domain. Keep all interpolation parameters, even when
their order changes. Use a complete sentence for context-dependent labels; do not
reuse an action such as Close for a switch state such as Disabled.

Translate built-in metadata at its display boundary, not while constructing
persisted settings or identifiers. Keep user names, paths, commands, terminal
output, file content, original logs and saved AI responses unchanged. Parameter
values are not translated recursively. Native file-picker chrome follows the OS.

Use `getLocale()` for display date/number formatting. Only presentation memos
depend on locale: connection identities, selected devices, normalized drafts and
execution payloads must retain stable references across a language change.

## Mandatory gates

```text
npm run check:i18n
npm run test:i18n
```

`npm run build` and `npm run electron:build` run the source gate automatically.
The GitHub workflow runs both checks on pull requests and release-branch pushes.
The tests demonstrate actual nonzero CLI exit codes for new untranslated Chinese
or English UI text, undeclared keys, empty translations and missing parameters.
Startup HTML and built-in JSON display fields are checked too.

For a detailed diagnostic report:

```text
node scripts/check-i18n.cjs --report .superpowers/i18n-report.json
```

An intentional protocol identifier, original-data sample or product name may use
an exact reviewed entry in `scripts/i18n-exclusions.json`. Entries identify the
file and source fingerprint and explain why translation would be incorrect.
Never exempt ordinary interface copy to make the check pass. New or changed text
requires a new review; directory-wide exclusions and automatic baselines are not
supported.
