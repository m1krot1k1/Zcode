// staging 与 afterPack verifier 共用的发布契约、PE 头解析、路径/快照校验与原子目录切换。
// 规则只在这里定义一次，避免 schema/PE 判定在 staging 与验收侧漂移。
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, rename } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const EXPECTED_PACKAGE_NAME = "@zcode/zcode-cua";
export const RUNTIME_MANIFEST = "runtime-manifest.json";
export const MODULE_TYPE_PACKAGE_JSON = "package.json";
export const REMOVE_DIRECTORY_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100,
};
export const PE_MACHINE_BY_ARCH = {
  x64: 0x8664,
  arm64: 0xaa64,
};
const ELECTRON_BUILDER_ARCH = {
  1: "x64",
  3: "arm64",
};

export function resolveElectronBuilderWindowsTarget({
  electronPlatformName,
  arch,
  configuredTargetPlatform,
}) {
  if (electronPlatformName !== "win32") {
    throw new Error(
      `[windows-cua-helper-assets] electron-builder context platform is not win32: ${String(electronPlatformName)}`,
    );
  }
  const actualArch = ELECTRON_BUILDER_ARCH[arch];
  if (!actualArch) {
    throw new Error(
      `[windows-cua-helper-assets] unsupported electron-builder Windows architecture: ${String(arch)}`,
    );
  }
  const actualTarget = {
    os: "win32",
    arch: actualArch,
    key: `win32-${actualArch}`,
  };
  if (
    configuredTargetPlatform?.os !== actualTarget.os ||
    configuredTargetPlatform?.arch !== actualTarget.arch ||
    configuredTargetPlatform?.key !== actualTarget.key
  ) {
    // 根因：交叉构建时 process.env 目标可能与 electron-builder 实际 context 不同；
    // 继续使用全局目标会让 afterPack 跳过或按错误架构验收。
    throw new Error(
      `[windows-cua-helper-assets] configured target ${String(configuredTargetPlatform?.key)} does not match electron-builder target ${actualTarget.key}`,
    );
  }
  return actualTarget;
}

export async function readContainedJson(
  physicalRoot,
  path,
  label,
  { lstatOperation = lstat, realpathOperation = realpath, readFileOperation = readFile } = {},
) {
  const bytes = await readRegularFileSnapshot(path, label, {
    lstatOperation,
    readFileOperation,
  });
  const physicalPath = await realpathOperation(path);
  assertPhysicalContainment(physicalRoot, physicalPath, label);
  try {
    return JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes));
  } catch (error) {
    throw new Error(`[windows-cua-helper-assets] invalid ${label}: ${path}`, {
      cause: error,
    });
  }
}

export async function readRegularFileSnapshot(
  path,
  artifact,
  { lstatOperation = lstat, readFileOperation = readFile } = {},
) {
  let stats;
  try {
    stats = await lstatOperation(path);
  } catch (error) {
    throw new Error(`[windows-cua-helper-assets] missing ${artifact}: ${path}`, {
      cause: error,
    });
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(
      `[windows-cua-helper-assets] ${artifact} must be a regular file, not a symbolic link: ${path}`,
    );
  }
  try {
    // TOCTOU 根因：校验/哈希后再次按源路径复制，可能把变化后的另一组字节写入产物。
    // 这里只读取一次确定快照；后续校验、落盘和 manifest 都沿用这组字节。
    return await readFileOperation(path);
  } catch (error) {
    throw new Error(`[windows-cua-helper-assets] cannot snapshot ${artifact}: ${path}`, {
      cause: error,
    });
  }
}

export function parsePeMachine(bytes, addonPath) {
  if (bytes.length < 0x40 || bytes.toString("ascii", 0, 2) !== "MZ") {
    throw new Error(`[windows-cua-helper-assets] invalid PE header: ${addonPath}`);
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (
    peOffset > bytes.length - 6 ||
    bytes.toString("binary", peOffset, peOffset + 4) !== "PE\u0000\u0000"
  ) {
    throw new Error(`[windows-cua-helper-assets] invalid PE header: ${addonPath}`);
  }
  return bytes.readUInt16LE(peOffset + 4);
}

export async function renameDirectoryWithRetries(
  source,
  destination,
  { renameOperation = rename, retryDelayMs = 100, maxAttempts = 5 } = {},
) {
  const transientWindowsErrors = new Set(["EACCES", "EBUSY", "EPERM"]);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await renameOperation(source, destination);
      return;
    } catch (error) {
      if (!transientWindowsErrors.has(error?.code) || attempt === maxAttempts) {
        throw error;
      }
      // Windows Defender 或索引器可能在原子目录切换的瞬间短暂持有文件句柄。
      await delay(retryDelayMs * attempt);
    }
  }
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isPlainRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactKeys(value, expectedKeys) {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

export function isNonEmptyTrimmedString(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

export function isCanonicalRelativeArtifactPath(artifact) {
  return (
    typeof artifact === "string" &&
    artifact.length > 0 &&
    !artifact.includes("\\") &&
    !isAbsolute(artifact) &&
    !posix.isAbsolute(artifact) &&
    !win32.isAbsolute(artifact) &&
    posix.normalize(artifact) === artifact &&
    !artifact.split("/").some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        // Windows 会把冒号解释成 ADS、把 NUL 当作路径终止符，必须在进入文件系统前拒绝。
        segment.includes(":") ||
        segment.includes("\0"),
    )
  );
}

export function resolveCanonicalPackagedArtifact(root, artifact, label) {
  if (!isCanonicalRelativeArtifactPath(artifact)) {
    throw new Error(
      `[windows-cua-helper-assets] invalid ${label} path in ${RUNTIME_MANIFEST}: ${String(artifact)}`,
    );
  }
  const artifactPath = resolve(root, ...artifact.split("/"));
  const relativePath = relative(root, artifactPath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`[windows-cua-helper-assets] ${label} path escapes packaged root: ${artifact}`);
  }
  return artifactPath;
}

export function assertPhysicalContainment(root, artifactPath, label) {
  const relativePath = relative(root, artifactPath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(
      `[windows-cua-helper-assets] ${label} physical path is not contained by packaged root`,
    );
  }
}

export function samePhysicalPath(expected, actual) {
  const normalize = (path) => {
    const normalized = resolve(path);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(expected) === normalize(actual);
}
