export function assertReleaseTargetSha(actualSha, expectedSha) {
  const actual = typeof actualSha === "string" ? actualSha.trim().toLowerCase() : "";
  const expected = typeof expectedSha === "string" ? expectedSha.trim().toLowerCase() : "";
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(expected) || actual !== expected) {
    throw new Error(
      `SHA ${actual || "отсутствует"} не совпадает с ожидаемым ${expected || "невалиден"}`,
    );
  }
}

export function buildReleaseCreateArgs({ tag, commitSha, targetArch, assetPaths }) {
  assertReleaseTargetSha(commitSha, commitSha);
  if (!/^v\d+\.\d+\.\d+$/u.test(tag)) throw new Error(`Невалидный release tag: ${tag}`);
  if (!Array.isArray(assetPaths) || assetPaths.length !== 2) {
    throw new Error("GitHub Release должен содержать ровно два macOS assets");
  }
  return [
    "gh",
    "release",
    "create",
    tag,
    "--target",
    commitSha,
    "--title",
    `Zcode ${tag.slice(1)} для macOS`,
    "--notes",
    `Локальная сборка macOS ${targetArch}: dmg и zip.`,
    ...assetPaths,
  ];
}

export async function resolveTagCommitSha(tagName, readApiJson) {
  let route = `repos/{owner}/{repo}/git/ref/tags/${tagName}`;
  let response = await readApiJson(route);
  let object = response?.object;
  const seen = new Set();
  while (object?.type === "tag") {
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(object.sha ?? "") || seen.has(object.sha)) {
      throw new Error(`GitHub tag ${tagName} содержит невалидную или циклическую цепочку`);
    }
    seen.add(object.sha);
    route = `repos/{owner}/{repo}/git/tags/${object.sha}`;
    response = await readApiJson(route);
    object = response?.object;
    if (seen.size > 8) throw new Error(`GitHub tag ${tagName} слишком глубоко вложен`);
  }
  if (object?.type !== "commit" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(object.sha ?? "")) {
    throw new Error(`GitHub tag ${tagName} не разрешается напрямую в commit`);
  }
  return object.sha.toLowerCase();
}

export function assertReleaseMetadata(release, expectedTag, expectedAssetNames) {
  if (!release || release.tagName !== expectedTag || release.isDraft !== false) {
    throw new Error(`GitHub не подтвердил опубликованный release ${expectedTag}`);
  }
  const actualAssetNames = Array.isArray(release.assets)
    ? release.assets
        .map((asset) => asset?.name)
        .filter((name) => typeof name === "string")
        .sort()
    : [];
  const expected = expectedAssetNames.map(normalizeGitHubReleaseAssetName).sort();
  if (
    actualAssetNames.length !== expected.length ||
    actualAssetNames.some((name, index) => name !== expected[index])
  ) {
    throw new Error(
      `GitHub release ${expectedTag} имеет неверный набор файлов: ${actualAssetNames.join(", ") || "пусто"}`,
    );
  }
}

export function assertAssetHashes(expectedHashes, downloadedHashes) {
  const localNameByGitHubName = new Map(
    [...expectedHashes.keys()].map((name) => [normalizeGitHubReleaseAssetName(name), name]),
  );
  for (const [githubName, downloadedHash] of downloadedHashes) {
    const localName = localNameByGitHubName.get(githubName);
    if (!localName) {
      throw new Error(`Неожиданный GitHub asset: ${githubName}`);
    }
    const expectedHash = expectedHashes.get(localName);
    if (!downloadedHash || downloadedHash !== expectedHash) {
      throw new Error(`GitHub asset ${localName} не совпадает с локальной сборкой`);
    }
  }
  if (downloadedHashes.size !== expectedHashes.size) {
    throw new Error("Набор скачанных GitHub assets не совпадает с локальной сборкой");
  }
}

export function normalizeGitHubReleaseAssetName(localName) {
  return localName.replaceAll(" ", ".");
}
