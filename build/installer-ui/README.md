# Native installer UI

The x86 Unicode NSIS plugin only paints the installer and handles its controls.
electron-builder retains the installation, elevation, update and uninstall engine.
The application identity, executable filename and existing profile directories remain stable.

## Build

On Windows, install Visual Studio 2022 Build Tools with the C++ x86/x64 tools.
`npm run electron:build` builds the plugin automatically with a static CRT.
Generated headers, objects and DLLs stay in ignored `build/generated/installer-ui/`.
The resulting installer requires no additional Visual C++ runtime installation.

All user-facing skin copy belongs in `strings.json`, with identical keys in five languages.
The build rejects missing locales, keys or blank translations.

## Safety and integration

- Initialize on the installer GUI thread; dispose before the outer dialog closes.
- Supply real NSIS progress and log handles; do not simulate production progress.
- Preserve the MUI completion behavior with `SetAutoClose true`.
- `TrustExistingPath` is one argument, no return. Only call it for a matching installed
  registry location with the expected application file. A prefilled path alone is not trusted.
- New destinations chosen in the UI get an application subdirectory and must not contain other files.
- Installer language is persisted only after installation succeeds. Existing app preferences win.
- Pass filesystem paths to PowerShell as environment data, never interpolated source code.

## Tests

Run `node --test tests/native-installer-skin.test.cjs tests/nsis-installer-hooks.test.cjs`.
`node tests/run-native-installer-gui.cjs` exercises a copied DLL on a private desktop.
`node tests/run-installer-hooks-fixture.cjs` uses a unique HKCU test key and a dedicated
`.superpowers/` directory; it does not launch the production installer or change PATH.
Never use the production installer as a UI-only test: its existing setup hooks manage bundled tools.
