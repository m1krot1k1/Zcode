# Fork-local Source Server release bundle

## Problem

Fork builds use their own version (e.g. `3.17.106`) that is not published on the
upstream Z.ai remote-asset CDN. SSH/WSL remote connections read the Source
Server descriptor from that CDN, so installation on a remote host fails with
`Unable to resolve Source Server release descriptor …`.

## Decision

The desktop application ships the Source Server archive that matches its own
build and uploads it to the remote host over the existing SSH transport. The
CDN remains a fallback only.

### Build

`packages/desktop/scripts/prepare-bundled-remote-assets.mjs` stages the Source
Server release for the host platform (mapped to a server target) into
`packages/desktop/bundled-remote-assets/releases/<version>/` using the existing
`stageCli`/`collectSourceServerRemoteReleaseArchives` pipeline.

electron-builder copies that directory to `resources/remote-assets` via
`extraResources`. Platforms without a Source Server target (Windows) skip it.

### Runtime

`RemoteAssetDirs` gains `bundledReleaseDir`:

- packaged app: `<resources>/remote-assets`;
- dev: `packages/desktop/bundled-remote-assets` when present.

`resolveSourceServerReleaseAsset` checks local release directories in this
order: bundled, development mock CDN, then CDN. A verified local archive wins
for every install mode, including `remote-download`: the transport already
uploads whenever `localArchivePath` is present, which is exactly the desired
"app uploads its own server" behaviour. The archive is still verified against
the descriptor SHA-256 and size before use.

### Failure semantics

If no local archive exists and the CDN does not publish the version, the
existing actionable error is returned. No silent fallback to a different
version.

## Verification

- resolver unit test: bundled release is used for `ssh` with
  `assetInstallMode: "remote-download"`;
- resolver unit test: missing bundled release falls back to CDN candidate
  resolution;
- packaging test: `extraResources` includes `remote-assets` when the directory
  exists.
