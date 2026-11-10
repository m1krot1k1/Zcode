import { lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertMacAdHocSignature } from "../../packages/desktop/scripts/macos-adhoc-signing.mjs";
import { selectMacReleaseAppBundle } from "./assets.mjs";
import { repoRoot } from "./repo-root.mjs";

export function assertZipContainsOnlyReleaseApp(entries, appName = "ZCode.app") {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("macOS ZIP не содержит записей приложения");
  }
  for (const entry of entries) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.startsWith("/") ||
      entry.includes("\\")
    ) {
      throw new Error("macOS ZIP содержит небезопасный путь");
    }
    const normalized = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    const parts = normalized.split("/");
    if (
      parts.some((part) => part === "" || part === "." || part === "..") ||
      (normalized !== appName && !normalized.startsWith(`${appName}/`))
    ) {
      throw new Error(`macOS ZIP должен содержать только ${appName} и его файлы`);
    }
  }
}

export async function assertUnsignedMacApp(appRoot) {
  for (const relativePath of ["Contents/_CodeSignature", "Contents/CodeResources"]) {
    try {
      await lstat(path.join(appRoot, relativePath));
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error(`Preview app содержит подпись ${relativePath}; ожидается unsigned сборка`);
  }
}

function parseMacArchs(output) {
  const text = String(output).trim();
  const architectureList = text.split(/\b(?:are|architecture):\s*/u).at(-1) ?? text;
  return architectureList
    .split(/\s+/u)
    .map((value) => value.replace(/[^a-z0-9_]/giu, ""))
    .filter((value) => ["arm64", "x86_64", "i386"].includes(value));
}

function assertPathWithin(parentPath, candidatePath, label) {
  const relative = path.relative(parentPath, candidatePath);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} находится вне app bundle`);
  }
}

export async function verifyMacReleaseAppBundle({
  appPath,
  appBundleName = path.basename(appPath),
  version,
  targetArch,
  productName = "ZCode",
  expectedBundleId = "dev.zcode.app",
  requireStaple = true,
  requireUnsigned = false,
  requireAdHocSignature = false,
  runCommand,
  captureCommand,
  hashDirectory,
}) {
  const appEntry = await lstat(appPath);
  if (!appEntry.isDirectory() || appEntry.isSymbolicLink()) {
    throw new Error(`Release app bundle должен быть обычной директорией: ${appPath}`);
  }
  const appRoot = await realpath(appPath);
  const infoPlistPath = path.join(appRoot, "Contents", "Info.plist");
  const infoPlistRealPath = await realpath(infoPlistPath);
  assertPathWithin(appRoot, infoPlistRealPath, "Info.plist");
  const bundleVersion = await captureCommand([
    "/usr/libexec/PlistBuddy",
    "-c",
    "Print :CFBundleShortVersionString",
    infoPlistPath,
  ]);
  if (bundleVersion.trim() !== version) {
    throw new Error(
      `Release app version ${bundleVersion.trim() || "отсутствует"} не совпадает с ${version}`,
    );
  }

  const bundleId = await captureCommand([
    "/usr/libexec/PlistBuddy",
    "-c",
    "Print :CFBundleIdentifier",
    infoPlistPath,
  ]);
  if (bundleId.trim() !== expectedBundleId) {
    throw new Error(
      `Release app identity ${bundleId.trim() || "отсутствует"} не совпадает с ${expectedBundleId}`,
    );
  }
  if (requireUnsigned) await assertUnsignedMacApp(appRoot);
  if (requireAdHocSignature) await assertMacAdHocSignature(appRoot);

  const executableName = await captureCommand([
    "/usr/libexec/PlistBuddy",
    "-c",
    "Print :CFBundleExecutable",
    infoPlistPath,
  ]);
  const safeExecutableName = executableName.trim();
  if (!/^[a-z0-9._-]+$/iu.test(safeExecutableName)) {
    throw new Error("CFBundleExecutable содержит невалидное имя");
  }
  const executablePath = path.join(appRoot, "Contents", "MacOS", safeExecutableName);
  const executableRealPath = await realpath(executablePath);
  assertPathWithin(appRoot, executableRealPath, "CFBundleExecutable");
  const archOutput = await captureCommand(["lipo", "-archs", executablePath]);
  const actualArchs = parseMacArchs(archOutput);
  const expectedArch = targetArch === "x64" ? "x86_64" : targetArch;
  if (actualArchs.length !== 1 || actualArchs[0] !== expectedArch) {
    throw new Error(
      `Release app architecture ${actualArchs.join(", ") || "отсутствует"} не совпадает с ${expectedArch}`,
    );
  }

  if (requireStaple) {
    await runCommand(
      ["bash", path.join(repoRoot, "scripts", "doctor-macos-release-app.sh"), appRoot],
      { env: { ZCODE_MACOS_REQUIRE_APP_STAPLE: "1" } },
    );
  }
  return {
    version: bundleVersion.trim(),
    architecture: actualArchs[0],
    productName,
    appBundleName,
    bundleId: bundleId.trim(),
    requireStaple,
    requireAdHocSignature,
    treeSha256: await hashDirectory(appRoot),
  };
}

function assertPackagedAppMatchesSource(sourceApp, packagedApp, label) {
  if (
    sourceApp.version !== packagedApp.version ||
    sourceApp.architecture !== packagedApp.architecture ||
    sourceApp.productName !== packagedApp.productName ||
    sourceApp.appBundleName !== packagedApp.appBundleName ||
    sourceApp.bundleId !== packagedApp.bundleId
  ) {
    throw new Error(`${label} app version/architecture отличается от проверенной сборки`);
  }
  if (sourceApp.treeSha256 !== packagedApp.treeSha256) {
    throw new Error(
      `${label} app payload/signature/staple отличается от проверенного source bundle (устаревший или изменённый app)`,
    );
  }
}

export async function verifyZipPayload({
  zipPath,
  sourceApp,
  version,
  targetArch,
  runCommand,
  captureCommand,
  hashDirectory,
  createTemporaryDirectory,
  removeTemporaryDirectory,
}) {
  const appDirectoryName = sourceApp.appBundleName;
  const listing = await captureCommand(["unzip", "-Z1", zipPath]);
  const entries = listing.split(/\r?\n/u).filter((entry) => entry.length > 0);
  assertZipContainsOnlyReleaseApp(entries, appDirectoryName);
  const extractionDir = await createTemporaryDirectory("zcode-release-zip-");
  try {
    await runCommand(["ditto", "-x", "-k", zipPath, extractionDir]);
    const extractionRoot = await realpath(extractionDir);
    const appPath = path.join(extractionRoot, appDirectoryName);
    const appRealPath = await realpath(appPath);
    assertPathWithin(extractionRoot, appRealPath, "ZIP app bundle");
    const packagedApp = await verifyMacReleaseAppBundle({
      appPath,
      version,
      targetArch,
      productName: sourceApp.productName,
      appBundleName: appDirectoryName,
      expectedBundleId: sourceApp.bundleId,
      requireStaple: sourceApp.requireStaple,
      // ad-hoc подпись создаёт Contents/_CodeSignature, поэтому unsigned-check допустим только без неё.
      requireUnsigned: !sourceApp.requireStaple && !sourceApp.requireAdHocSignature,
      requireAdHocSignature: sourceApp.requireAdHocSignature,
      runCommand,
      captureCommand,
      hashDirectory,
    });
    assertPackagedAppMatchesSource(sourceApp, packagedApp, "ZIP");
  } finally {
    await removeTemporaryDirectory(extractionDir);
  }
}

export async function verifyDmgPayload({
  dmgPath,
  sourceApp,
  version,
  targetArch,
  runCommand,
  captureCommand,
  hashDirectory,
  createTemporaryDirectory,
  removeTemporaryDirectory,
}) {
  const mountPoint = await createTemporaryDirectory("zcode-release-dmg-");
  let mounted = false;
  let result;
  let failure;
  try {
    await runCommand([
      "hdiutil",
      "attach",
      "-readonly",
      "-nobrowse",
      "-quiet",
      "-mountpoint",
      mountPoint,
      dmgPath,
    ]);
    mounted = true;
    const appName = selectMacReleaseAppBundle(
      await readdir(mountPoint, { withFileTypes: true }),
      sourceApp.appBundleName,
    );
    const appPath = path.join(mountPoint, appName);
    const packagedApp = await verifyMacReleaseAppBundle({
      appPath,
      version,
      targetArch,
      productName: sourceApp.productName,
      appBundleName: sourceApp.appBundleName,
      expectedBundleId: sourceApp.bundleId,
      requireStaple: sourceApp.requireStaple,
      requireUnsigned: !sourceApp.requireStaple && !sourceApp.requireAdHocSignature,
      requireAdHocSignature: sourceApp.requireAdHocSignature,
      runCommand,
      captureCommand,
      hashDirectory,
    });
    assertPackagedAppMatchesSource(sourceApp, packagedApp, "DMG");
    result = packagedApp;
  } catch (error) {
    failure = error;
  }
  if (mounted) {
    try {
      await runCommand(["hdiutil", "detach", "-quiet", mountPoint]);
    } catch (error) {
      failure ??= error;
    }
  }
  try {
    await removeTemporaryDirectory(mountPoint);
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
  return result;
}

export const defaultCreateTemporaryDirectory = (prefix) => mkdtemp(path.join(tmpdir(), prefix));
export const defaultRemoveTemporaryDirectory = (directoryPath) =>
  rm(directoryPath, { recursive: true, force: true });
