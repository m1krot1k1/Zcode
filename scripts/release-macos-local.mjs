#!/usr/bin/env node
/**
 * Локальный выпуск macOS на этой машине.
 * Поднимает версию корня, собирает dmg и zip и создаёт GitHub Release на ветке dev.
 * В main не сливает и секрет не печатает.
 *
 * Реализация разложена по ответственности в scripts/release-macos-local/; этот файл остаётся
 * точкой входа CLI и публичной поверхностью для тестов и Preview-релиза.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./release-macos-local/main.mjs";

export {
  assertMacReleaseAssetPair,
  clearExpectedMacReleaseAssets,
  clearMacAppOutput,
  expectedMacReleaseAssetNames,
  selectMacReleaseAppBundle,
  selectMacReleaseAssets,
} from "./release-macos-local/assets.mjs";
export {
  assertUnsignedMacApp,
  assertZipContainsOnlyReleaseApp,
} from "./release-macos-local/app-verification.mjs";
export { sha256 } from "./release-macos-local/hash.mjs";
export {
  assertAssetHashes,
  assertReleaseMetadata,
  assertReleaseTargetSha,
  buildReleaseCreateArgs,
  normalizeGitHubReleaseAssetName,
  resolveTagCommitSha,
} from "./release-macos-local/github-release.mjs";
export { preflightMacRelease } from "./release-macos-local/preflight.mjs";
export {
  assertReleaseBranch,
  bumpSemver,
  macTargetArch,
  replacePackageVersion,
} from "./release-macos-local/version.mjs";

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
