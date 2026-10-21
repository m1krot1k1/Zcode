# Desktop native runtime packaging

## Goal

Packaged desktop apps must include the JavaScript runtime and exactly the native assets required by their target platform. The app build must fail before producing an artifact if a required native runtime is missing.

## node-pty contract

- `node-pty` is a production runtime dependency even when pnpm hoists it to the workspace root and Electron Builder omits it from the nested desktop package.
- `app.asar` includes the `node-pty` JavaScript runtime and its runtime dependency closure.
- `app.asar.unpacked` includes the selected target's complete `node-pty/prebuilds/<platform-key>` directory, including `pty.node` and helper binaries.
- The archive must not contain other platform prebuilds, install-time build output, or installer binaries.
- If the target native prebuild is absent, packaging fails with a clear diagnostic; the build must not publish an artifact with a nonfunctional terminal.

## Verification

- Unit tests check target-only node-pty staging and native pack/unpack policy.
- A packaged-app check confirms the `node-pty` JS package is in `app.asar`, the selected native prebuild exists under `app.asar.unpacked`, and no foreign-platform node-pty prebuild is present.
- The bundle verifier checks `node-pty` in the packaged runtime dependency closure before an artifact can be accepted.
