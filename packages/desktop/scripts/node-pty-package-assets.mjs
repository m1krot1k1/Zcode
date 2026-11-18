import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);

export function restoreTargetNodePtyPrebuild({ desktopPackageRoot, targetPlatform }) {
  if (targetPlatform.os !== "linux") {
    console.log(`[beforePack] node-pty prebuild restore skipped for ${targetPlatform.key}`);
    return;
  }

  const platformKey = targetPlatform.key;
  const sourcePackageName = `@lydell/node-pty-${platformKey}`;
  let sourceBinaryPath;

  try {
    sourceBinaryPath = resolveSourceNodePtyPrebuildPath({ sourcePackageName, platformKey });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`缺少 ${sourcePackageName}，无法为 ${platformKey} 打包 node-pty: ${message}`);
  }

  const nodePtyPackageRoot = dirname(
    require.resolve("node-pty/package.json", { paths: [desktopPackageRoot] }),
  );
  const targetPrebuildDir = resolve(nodePtyPackageRoot, "prebuilds", platformKey);
  const targetBinaryPath = resolve(targetPrebuildDir, "pty.node");

  // Linux 包中 node-pty 本体只会查自己的 prebuilds/linux-*/pty.node，
  // 但 Linux 预编译文件实际来自 @lydell/node-pty-linux-* 平台包；若排除该平台包，
  // 而 node-pty 自身目录没有 linux prebuild，最终安装包里会缺 pty.node，终端启动失败。
  // 这里在 beforePack 阶段恢复依赖资产，让后续 asarUnpack 按标准链路处理 native addon。
  mkdirSync(targetPrebuildDir, { recursive: true });
  cpSync(sourceBinaryPath, targetBinaryPath);

  if (!existsSync(targetBinaryPath))
    throw new Error(`node-pty 预编译产物恢复失败: ${targetBinaryPath}`);

  console.log(`[beforePack] node-pty prebuild restored: ${targetBinaryPath}`);
}

export function shouldIncludeNodePtyRuntimePath(relativePath, targetPlatformKey) {
  const normalizedPath = relativePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (!normalizedPath) return true;

  if (
    normalizedPath === "build" ||
    normalizedPath.startsWith("build/") ||
    normalizedPath === "bin" ||
    normalizedPath.startsWith("bin/")
  ) {
    return false;
  }

  const prebuildMatch = /^prebuilds\/([^/]+)(?:\/|$)/.exec(normalizedPath);
  return !prebuildMatch || prebuildMatch[1] === targetPlatformKey;
}

export function copyNodePtyRuntimePackage({
  sourcePackageRoot,
  targetPackageRoot,
  targetPlatformKey,
}) {
  cpSync(sourcePackageRoot, targetPackageRoot, {
    recursive: true,
    filter: (sourcePath) => {
      const relativePath = sourcePath.slice(sourcePackageRoot.length).replace(/^[/\\]/, "");
      return shouldIncludeNodePtyRuntimePath(relativePath, targetPlatformKey);
    },
  });
}

export function resolveSourceNodePtyPrebuildPath({ sourcePackageName, platformKey }) {
  const sourcePackageEntry = require.resolve(sourcePackageName);
  let currentDir = dirname(sourcePackageEntry);

  while (currentDir !== dirname(currentDir)) {
    const candidatePath = resolve(currentDir, "prebuilds", platformKey, "pty.node");
    if (existsSync(candidatePath)) return candidatePath;

    currentDir = dirname(currentDir);
  }

  // @lydell/node-pty-linux-* 通过 package exports 只暴露 lib/index.js，
  // 不能再解析 package.json。这里从公开入口向上寻找 prebuilds，兼容 exports 限制。
  throw new Error(
    `缺少 node-pty 预编译产物: ${sourcePackageName}/prebuilds/${platformKey}/pty.node`,
  );
}

export function resolvePackagedNodePtyPrebuildPath({ resourcesDir, platformKey }) {
  return resolve(
    resourcesDir,
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
    "prebuilds",
    platformKey,
    "pty.node",
  );
}

/** CLI bundle исполняется из resources/glm и не видит app.asar.unpacked. */
export function resolvePackagedBundledAgentNodePtyRoot({ resourcesDir }) {
  return resolve(resourcesDir, "glm", "node_modules", "node-pty");
}

export function resolvePackagedBundledAgentNodePtyPrebuildPath({ resourcesDir, platformKey }) {
  return resolve(
    resolvePackagedBundledAgentNodePtyRoot({ resourcesDir }),
    "prebuilds",
    platformKey,
    "pty.node",
  );
}

/**
 * Кладёт node-pty рядом с agent bundle. Резолв `require("node-pty")` из
 * `resources/glm/zcode.cjs` ищет `resources/glm/node_modules`, а не app.asar.
 */
export function stageNodePtyIntoBundledAgent({
  desktopPackageRoot,
  glmDir,
  targetPlatform,
  sourcePackageRoot,
}) {
  if (!glmDir || !targetPlatform?.os || !targetPlatform?.arch) {
    throw new Error("[node-pty-package-assets] glmDir and targetPlatform are required");
  }
  const platformKey = `${targetPlatform.os}-${targetPlatform.arch}`;
  if (targetPlatform.os === "linux" && !sourcePackageRoot) {
    restoreTargetNodePtyPrebuild({
      desktopPackageRoot,
      targetPlatform: { ...targetPlatform, key: platformKey },
    });
  }
  const resolvedSourceRoot =
    sourcePackageRoot ??
    dirname(require.resolve("node-pty/package.json", { paths: [desktopPackageRoot] }));
  const targetPackageRoot = resolve(glmDir, "node_modules", "node-pty");
  // stageAgentBundle очищает glm; повторный вызов не должен оставлять prebuild другой платформы.
  rmSync(targetPackageRoot, { recursive: true, force: true });
  copyNodePtyRuntimePackage({
    sourcePackageRoot: resolvedSourceRoot,
    targetPackageRoot,
    targetPlatformKey: platformKey,
  });
  const prebuildPath = resolve(targetPackageRoot, "prebuilds", platformKey, "pty.node");
  if (!existsSync(prebuildPath)) {
    throw new Error(`node-pty prebuild missing for ${platformKey}: ${prebuildPath}`);
  }
  return targetPackageRoot;
}
