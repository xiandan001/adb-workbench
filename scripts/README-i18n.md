# Localization checks

The application supports Simplified Chinese (`zh-CN`, default/source), Traditional
Chinese (`zh-TW`), English (`en-US`), Japanese (`ja-JP`) and Korean (`ko-KR`).
Preferences > Appearance owns language selection. The main process saves it and synchronizes both windows.
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

Add the exact source key to **all four target catalogs in the same domain**:

| Locale | Catalog prefix |
| --- | --- |
| `en-US` | `en-` |
| `zh-TW` | `tw-` |
| `ja-JP` | `ja-` |
| `ko-KR` | `ko-` |

Domains are `core`, `workspace`, `tools` and `backend`, for 16 required JSON files
under `electron/locales/`. Simplified Chinese is the source, not a fifth catalog.
`locale-config.json` is runtime metadata, not a message dictionary.

Each domain must have the same key set in every target language. Another domain,
another locale or a runtime fallback cannot satisfy a missing entry. Values must
be nonempty strings. Duplicate JSON keys and non-object catalog roots are errors.
Keep every interpolation parameter and its occurrence count, even when their
order changes. Use a complete sentence for context-dependent labels; do not
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
The tests demonstrate actual nonzero CLI exit codes for new untranslated UI text,
undeclared keys, missing language files or domain keys, empty translations and
missing parameters. Japanese and Korean source literals are checked alongside
Chinese and English. Hardcoded display locales in `toLocale*` and `Intl`
formatters are rejected; use the selected locale instead. Startup HTML and
built-in JSON display fields are checked too.

English translations cannot silently retain Chinese, Japanese or Korean copy.
Japanese and Korean ordinary messages must not be entirely untranslated English;
Korean copy must not silently remain Chinese. Fixed product/payment brands,
technical terms and exact language self-names retain their intended identities.
Traditional Chinese and Japanese legitimately share Han characters, so a script
heuristic cannot prove translation quality for those languages. Human review is
still required; copying the source into every catalog is not an acceptable way
to complete localization.

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

The product name is application-owned visible copy: use its source key and the
locale's catalog value. The old blanket allowance for visible `卓控台` is removed;
an old `brand` exclusion cannot bypass translation. Exact legacy machine IDs,
data directories and system registration names remain unchanged through reviewed
`machine` exclusions. This gate does not hardcode a foreign-language brand.

Language options intentionally use the fixed self-names `简体中文`, `繁體中文`,
`English`, `日本語` and `한국어`. Raw source labels require exact, file-scoped
exclusions in the language selector. In a catalog only an exact self-name key
whose value is the same self-name is exempt from the English script check;
ordinary phrases containing a self-name receive no special allowance.

## Before-bundle startup text

`public/startup.js` and `electron/startup/particles.js` may contain a small static
`messagesByLocale` object (optionally wrapped in `Object.freeze`) shaped as
`locale -> source key -> translated text`. The gate compares every value with
the corresponding locale's merged catalog, using runtime domain priority
(`core`, then `workspace`, `tools`, `backend`). Unknown locales, missing keys,
duplicate keys, dynamic/spread values and mismatches fail. Only individually
validated value nodes are accepted; the rest of each file remains audited.
These tables permit synchronous sandbox-safe startup, not a second translation
source or a generic foreign-text exclusion. Startup behavior tests must also
verify that the tables are actually used correctly.
