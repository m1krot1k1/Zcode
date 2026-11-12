function parseVersion(version) {
  const match =
    typeof version === "string" &&
    version.match(
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/,
    );
  const prerelease = match && match[4] ? match[4].split(".") : [];
  if (!match || match[0] !== version || prerelease.some((part) => /^0\d+$/.test(part))) {
    throw new Error("Expected a package version such as 3.12.2");
  }
  return { core: match.slice(1, 4).map(BigInt), prerelease };
}

/** 构建与发布共用版本解析；随 packages/web 复制进 Docker，避免依赖未复制的根 scripts。 */
export function resolveRemoteFrontendVersion(packageVersion, override) {
  const version = override?.trim() || packageVersion;
  parseVersion(version);
  return version;
}