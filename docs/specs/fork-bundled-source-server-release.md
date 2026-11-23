# Fork-local Source Server release bundle

## Problem

Fork builds use their own version (e.g. `3.17.106`) that is not published on the
upstream Z.ai remote-asset CDN. SSH/WSL remote connections read the Source
Server descriptor from that CDN, so installation on a remote host fails with
`Unable to resolve Source Server release descriptor …`.

## Decision

The desktop application ships the Source Server archive that matches its own
build and uploads it to the remote host over the existing SSH transport. The
desktop no longer reads remote-asset descriptors or archives from any CDN.

### Build

`packages/desktop/scripts/prepare-bundled-remote-assets.mjs` stages the Source
Server release for **every supported remote target** — `linux-x64`,
`linux-arm64`, `darwin-x64`, `darwin-arm64` — independent of the build host.
A macOS app therefore carries the Linux archives needed to reach a Linux host,
and a Windows build host bundles the same four targets. Windows remains a
client-only platform: `win32-*` is not a Source Server remote target.

The script calls the full `stage:remote-assets` entry point without `--target`,
so `source-server-release.json` lists all four archives. The existing
`stageCli`/`collectSourceServerRemoteReleaseArchives` pipeline verifies every
archive and publishes one descriptor.

electron-builder copies that directory to `resources/remote-assets` via
`extraResources`. Platforms without a Source Server target (Windows) no longer
skip the step: they bundle the four remote archives so the Windows client can
connect to Linux/macOS hosts.

### Reuse

A previously built bundle is reused only when all four targets are present in
the descriptor, every archive matches its recorded size/SHA-256, and
`source-revision.txt` equals `git rev-parse HEAD`. A bundle that carries a
subset of targets (the historical host-only build) is rebuilt.

### Root cause of the host-only regression

Earlier builds staged `--target <host-platform>` only. The resulting descriptor
contained just the build host's archive, so a macOS-arm64 app asking for
`linux-x64` failed with `Source Server descriptor is missing target: linux-x64`
before any download started. Bundling the full target set removes that
cross-OS failure.

### Bundle size

Bundling four archives grows the installer. The trade-off is intentional: the
fork has no CDN fallback, so a target missing from the bundle cannot be
recovered at runtime. `packages/desktop/scripts/audit-bundle-size.mjs`
therefore allows up to 800 MiB per artifact instead of 500 MiB.

### Runtime

`RemoteAssetDirs` gains `bundledReleaseDir`:

- packaged app: `<resources>/remote-assets`;
- dev: `packages/desktop/bundled-remote-assets` when present.

`resolveSourceServerReleaseAsset` checks local release directories in this
order: bundled, development mock. A verified local archive wins for every
install mode, including `remote-download`: the transport already uploads
whenever `localArchivePath` is present, which is exactly the desired "app
uploads its own server" behaviour. The archive is still verified against the
descriptor SHA-256 and size before use.

### Failure semantics

If no local archive exists, resolution fails with an actionable build error.
There is no network fallback and no silent fallback to a different version.

## Verification

- resolver unit test: bundled release is used for `ssh` with
  `assetInstallMode: "remote-download"`;
- resolver unit test: a Linux target resolves from a descriptor that also
  carries the macOS host archive (any client OS → any remote target);
- resolver unit test: missing bundled release is rejected without network
  access;
- packaging test: `extraResources` includes `remote-assets` when the directory
  exists;
- packaging unit test: the bundled target set equals
  `SOURCE_SERVER_RELEASE_TARGETS`, so a host-only subset cannot return;
- reuse unit test: a bundle is reused only when all four targets match their
  descriptor size/SHA-256 and the recorded source revision.
