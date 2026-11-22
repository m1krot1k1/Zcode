import { readdir } from "node:fs/promises";
import path from "node:path";
import { assertPinnedNodeVersionFromMise } from "../assert-node-version.mjs";
import {
  defaultCreateTemporaryDirectory,
  defaultRemoveTemporaryDirectory,
  verifyDmgPayload,
  verifyMacReleaseAppBundle,
  verifyZipPayload,
} from "./app-verification.mjs";
import {
  assertMacReleaseAssetPair,
  selectMacReleaseAppBundle,
  selectMacReleaseAssets,
} from "./assets.mjs";
import { capture } from "./commands.mjs";
import { hashMacAppBundle, sha256File } from "./hash.mjs";

export async function preflightMacRelease({
  version,
  targetArch,
  productName = "ZCode",
  appBundleName = `${productName}.app`,
  artifactSuffix = "",
  expectedBundleId = "dev.zcode.app",
  requireStaple = true,
  requireUnsigned = false,
  requireAdHocSignature = false,
  distDir,
  runCommand,
  captureCommand = capture,
  hashFile = sha256File,
  hashDirectory = hashMacAppBundle,
  createTemporaryDirectory = defaultCreateTemporaryDirectory,
  removeTemporaryDirectory = defaultRemoveTemporaryDirectory,
  nodeVersion = process.versions.node,
  pinnedNodeVersion,
  misePath,
}) {
  // Fail-fast до чтения dist и временных каталогов: выпуск допустим только на Node из mise.toml.
  await assertPinnedNodeVersionFromMise({
    actual: nodeVersion,
    pinned: pinnedNodeVersion,
    misePath,
  });
  const assetNames = selectMacReleaseAssets(
    await readdir(distDir),
    version,
    targetArch,
    productName,
    artifactSuffix,
  );
  assertMacReleaseAssetPair(assetNames, version, targetArch, productName, artifactSuffix);
  // electron-builder 的 appOutDir 按 `defaultArch` 命名：x64 → dist/mac, arm64 → dist/mac-arm64。
  const appDir = path.join(distDir, targetArch === "arm64" ? "mac-arm64" : "mac");
  const selectedAppBundleName = selectMacReleaseAppBundle(
    await readdir(appDir, { withFileTypes: true }),
    appBundleName,
  );
  const appPath = path.join(appDir, selectedAppBundleName);
  const sourceApp = await verifyMacReleaseAppBundle({
    appPath,
    appBundleName: selectedAppBundleName,
    version,
    targetArch,
    productName,
    expectedBundleId,
    requireStaple,
    requireUnsigned,
    requireAdHocSignature,
    runCommand,
    captureCommand,
    hashDirectory,
  });
  const assetPaths = assetNames.map((name) => path.join(distDir, name));
  const zipPath = assetPaths.find((assetPath) => assetPath.endsWith(".zip"));
  const dmgPath = assetPaths.find((assetPath) => assetPath.endsWith(".dmg"));
  await verifyZipPayload({
    zipPath,
    sourceApp,
    version,
    targetArch,
    runCommand,
    captureCommand,
    hashDirectory,
    createTemporaryDirectory,
    removeTemporaryDirectory,
  });
  await verifyDmgPayload({
    dmgPath,
    sourceApp,
    version,
    targetArch,
    runCommand,
    captureCommand,
    hashDirectory,
    createTemporaryDirectory,
    removeTemporaryDirectory,
  });
  const assetHashes = new Map();
  for (let index = 0; index < assetPaths.length; index += 1) {
    assetHashes.set(assetNames[index], await hashFile(assetPaths[index]));
  }
  return { appPath, assetNames, assetPaths, assetHashes };
}
