# Desktop native runtime packaging

## Goal

Packaged desktop apps must include the JavaScript runtime and exactly the native assets required by their target platform. The app build must fail before producing an artifact if a required native runtime is missing.

## node-pty contract

- `node-pty` is a production runtime dependency even when pnpm hoists it to the workspace root and Electron Builder omits it from the nested desktop package.
- `app.asar` includes the `node-pty` JavaScript runtime and its runtime dependency closure.
- `app.asar.unpacked` includes the selected target's complete `node-pty/prebuilds/<platform-key>` directory, including `pty.node` and helper binaries.
- The archive must not contain other platform prebuilds, install-time build output, or installer binaries.
- If the target native prebuild is absent, packaging fails with a clear diagnostic; the build must not publish an artifact with a nonfunctional terminal.

## External JavaScript runtime contract

- JavaScript packages externalized from the desktop main/host bundles, including `yaml`, must be present under `app.asar/node_modules` in the packaged app.
- `electron-builder` afterPack injection owns copying missing runtime package closures; the final bundle verifier must check the same required roots before accepting the artifact.
- The afterPack injector and final verifier also discover bare package imports from the built main/host/scheduler chunks, so adding an external import cannot silently bypass the package lists.
- A package declaration in `packages/desktop/package.json` alone is insufficient evidence that the package entered `app.asar`.
- If an external runtime package is absent, packaging fails before the artifact is delivered rather than letting the installed app crash during startup.
- Copying a pnpm package excludes its nested `node_modules` links; runtime dependencies are copied from the validated dependency closure so workspace `.bin` links cannot enter the app archive.

## Bundled agent skill contract

- Both development and packaged Desktop agent runtimes stage the same versioned `packages/bundled-skills` pack beside `zcode.cjs`.
- Staging the agent bundle may clear the target runtime folder, but it must then restore both the executable and skill pack before launch.
- The runtime must discover/load a bundled skill from the staged agent directory without relying on the user's workspace or repository checkout.

## Verification

- Unit tests check target-only node-pty staging and native pack/unpack policy.
- A packaged-app check confirms the `node-pty` JS package is in `app.asar`, the selected native prebuild exists under `app.asar.unpacked`, and no foreign-platform node-pty prebuild is present.
- The bundle verifier checks `node-pty` in the packaged runtime dependency closure before an artifact can be accepted.
- Regression coverage checks external-import discovery and the explicitly required `yaml` and `@arms/rum-electron` roots in both the afterPack injection and final bundle verification lists; the packaged-app verifier confirms these packages are present in the built `app.asar`.
- Development staging tests discover and load a bundled skill from the staged `glm` directory after the shared agent bundle cleanup; packaged runtime tests cover the corresponding release path.
