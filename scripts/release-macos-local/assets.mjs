import { rm } from "node:fs/promises";
import path from "node:path";
import { bumpSemver } from "./version.mjs";

export function selectMacReleaseAssets(
  fileNames,
  version,
  targetArch,
  productName = "ZCode",
  artifactSuffix = "",
) {
  if (targetArch !== "arm64" && targetArch !== "x64") {
    throw new Error(`Нужна точная архитектура release asset: ${targetArch}`);
  }
  const expectedName = new RegExp(
    `^${productName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}-${version.replaceAll(".", "\\.")}-mac-${targetArch}${artifactSuffix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\.(?:dmg|zip)$`,
  );
  return fileNames
    .filter((fileName) => {
      const base = path.basename(fileName);
      return expectedName.test(base);
    })
    .sort();
}

export function assertMacReleaseAssetPair(
  assetNames,
  version,
  targetArch,
  productName = "ZCode",
  artifactSuffix = "",
) {
  const expected = expectedMacReleaseAssetNames(version, targetArch, productName, artifactSuffix);
  const actual = [...assetNames].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(
      `Нужна ровно пара ${expected.join(" и ")}; найдено: ${actual.join(", ") || "ничего"}`,
    );
  }
}

export function expectedMacReleaseAssetNames(
  version,
  targetArch,
  productName = "ZCode",
  artifactSuffix = "",
) {
  bumpSemver(version, "patch");
  if (targetArch !== "arm64" && targetArch !== "x64") {
    throw new Error(`Нужна точная архитектура release asset: ${targetArch}`);
  }
  return [
    `${productName}-${version}-mac-${targetArch}${artifactSuffix}.dmg`,
    `${productName}-${version}-mac-${targetArch}${artifactSuffix}.zip`,
  ].sort();
}

export async function clearExpectedMacReleaseAssets({
  distDir,
  version,
  targetArch,
  productName = "ZCode",
  artifactSuffix = "",
  removeFile = (filePath) => rm(filePath, { force: true }),
}) {
  const paths = expectedMacReleaseAssetNames(version, targetArch, productName, artifactSuffix).map(
    (name) => path.join(distDir, name),
  );
  for (const filePath of paths) await removeFile(filePath);
  return paths;
}

export function selectMacReleaseAppBundle(appEntries, expectedName = "ZCode.app") {
  const appNames = appEntries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
    .map((entry) => entry.name);
  if (appNames.length !== 1 || appNames[0] !== expectedName) {
    const requirement =
      expectedName === "ZCode.app"
        ? "Для стабильного macOS релиза нужна ровно одна production-сборка ZCode.app"
        : `Для macOS релиза нужна ровно одна сборка ${expectedName}`;
    throw new Error(`${requirement}; найдено: ${appNames.join(", ") || "ничего"}`);
  }
  return appNames[0];
}
