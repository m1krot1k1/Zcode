/**
 * Source Server archives bundled into the desktop app.
 *
 * The set is independent of the build host: any client OS must be able to
 * install the Source Server on any supported remote target. Keep it in sync
 * with SOURCE_SERVER_RELEASE_TARGETS in @zcode/shared (guarded by
 * packages/desktop/test/bundledRemoteAssetTargets.test.ts).
 */
export const BUNDLED_SOURCE_SERVER_TARGETS = Object.freeze([
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
]);
