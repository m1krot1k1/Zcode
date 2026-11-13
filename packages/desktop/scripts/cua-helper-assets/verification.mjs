// producer 契约校验与 afterPack 安装目录验收（PE/schema/哈希/运行时依赖闭包）。
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  EXPECTED_PACKAGE_NAME,
  MODULE_TYPE_PACKAGE_JSON,
  PE_MACHINE_BY_ARCH,
  RUNTIME_MANIFEST,
  assertPhysicalContainment,
  hasExactKeys,
  isCanonicalRelativeArtifactPath,
  isNonEmptyTrimmedString,
  isPlainRecord,
  parsePeMachine,
  readRegularFileSnapshot,
  resolveCanonicalPackagedArtifact,
  sha256,
} from "./common.mjs";
import { resolveSharpRuntimePackageNames } from "../sharp-package-assets.mjs";

// 2026-08-18：把「契约不满足」拆成逐条可读的判定。原来十一个条件挤在一个 if 里、只抛一句
// "invalid zcodeCuaRuntime Windows artifact path contract"，看不出是 producer 少给了契约、
// 还是仓库读错了目录。本次审计正是被这条报错误导：node_modules 停在改 pin 之前的旧提交
// （git 依赖改 pin 不会自动重装），旧包没有 zcodeCuaRuntime，于是被误读成 producer 回归。
// 报错必须自证：谁（包名@版本）、在哪（源目录）、缺哪一条。
function describeRuntimeContractViolation(packageJson) {
  if (!isPlainRecord(packageJson)) return "source package.json is not a JSON object";
  if (packageJson.name !== EXPECTED_PACKAGE_NAME) {
    return `unexpected package name ${JSON.stringify(packageJson.name)}`;
  }
  if (!isNonEmptyTrimmedString(packageJson.version)) {
    return `invalid package version ${JSON.stringify(packageJson.version)}`;
  }
  const contract = packageJson.zcodeCuaRuntime;
  if (contract === undefined) {
    return "zcodeCuaRuntime is missing — the producer package does not publish a Windows runtime contract";
  }
  if (!isPlainRecord(contract)) return "zcodeCuaRuntime is not a JSON object";
  if (!hasExactKeys(contract, ["schema", "windows"])) {
    return `zcodeCuaRuntime must have exactly the keys {schema, windows}, got {${Object.keys(contract).join(", ")}}`;
  }
  if (contract.schema !== 1) {
    return `zcodeCuaRuntime.schema must be 1, got ${JSON.stringify(contract.schema)}`;
  }
  const windowsContract = contract.windows;
  if (!isPlainRecord(windowsContract)) return "zcodeCuaRuntime.windows is not a JSON object";
  if (!hasExactKeys(windowsContract, ["entry", "nativeAddon"])) {
    return `zcodeCuaRuntime.windows must have exactly the keys {entry, nativeAddon}, got {${Object.keys(windowsContract).join(", ")}}`;
  }
  if (!isCanonicalRelativeArtifactPath(windowsContract.entry)) {
    return `zcodeCuaRuntime.windows.entry is not a canonical relative artifact path: ${JSON.stringify(windowsContract.entry)}`;
  }
  if (!isCanonicalRelativeArtifactPath(windowsContract.nativeAddon)) {
    return `zcodeCuaRuntime.windows.nativeAddon is not a canonical relative artifact path: ${JSON.stringify(windowsContract.nativeAddon)}`;
  }
  if (windowsContract.entry === windowsContract.nativeAddon) {
    return "zcodeCuaRuntime.windows.entry and zcodeCuaRuntime.windows.nativeAddon must differ";
  }
  return undefined;
}

export function readProducerRuntimeContract(packageJson, sourceRoot) {
  const violation = describeRuntimeContractViolation(packageJson);
  if (violation) {
    const identity = isPlainRecord(packageJson)
      ? `${String(packageJson.name)}@${String(packageJson.version)}`
      : "<unreadable package.json>";
    throw new Error(
      `[windows-cua-helper-assets] invalid zcodeCuaRuntime Windows artifact path contract in ${identity} (${sourceRoot}): ${violation}`,
    );
  }
  const windowsContract = packageJson.zcodeCuaRuntime.windows;
  return {
    packageVersion: packageJson.version,
    entry: windowsContract.entry,
    addon: windowsContract.nativeAddon,
  };
}

function resolvePackagedRuntimePackageRoot(nodeModulesRoot, packageName) {
  if (
    typeof packageName !== "string" ||
    !/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu.test(packageName)
  ) {
    throw new Error(
      `[windows-cua-helper-assets] invalid runtime dependency name: ${String(packageName)}`,
    );
  }
  return resolve(nodeModulesRoot, ...packageName.split("/"));
}

async function verifyPackagedRuntimeDependencyClosure({
  root,
  physicalRoot,
  targetPlatform,
  lstatOperation,
  realpathOperation,
  readFileOperation,
}) {
  const nodeModulesRoot = resolve(root, "node_modules");
  const visited = new Set();
  const verifyPackage = async (packageName) => {
    if (visited.has(packageName)) return;
    visited.add(packageName);
    const packageRoot = resolvePackagedRuntimePackageRoot(nodeModulesRoot, packageName);
    let packageStats;
    try {
      packageStats = await lstatOperation(packageRoot);
    } catch (error) {
      throw new Error(`[windows-cua-helper-assets] missing runtime dependency: ${packageName}`, {
        cause: error,
      });
    }
    if (packageStats.isSymbolicLink() || !packageStats.isDirectory()) {
      throw new Error(
        `[windows-cua-helper-assets] runtime dependency must be a regular directory, not a symbolic link: ${packageName}`,
      );
    }
    const physicalPackageRoot = await realpathOperation(packageRoot);
    assertPhysicalContainment(
      physicalRoot,
      physicalPackageRoot,
      `runtime dependency ${packageName}`,
    );

    const packageJsonPath = resolve(packageRoot, "package.json");
    const packageJsonBytes = await readRegularFileSnapshot(
      packageJsonPath,
      `runtime dependency ${packageName}/package.json`,
      { lstatOperation, readFileOperation },
    );
    const physicalPackageJsonPath = await realpathOperation(packageJsonPath);
    assertPhysicalContainment(
      physicalRoot,
      physicalPackageJsonPath,
      `runtime dependency ${packageName}/package.json`,
    );
    let packageJson;
    try {
      packageJson = JSON.parse(
        Buffer.isBuffer(packageJsonBytes)
          ? packageJsonBytes.toString("utf8")
          : String(packageJsonBytes),
      );
    } catch (error) {
      throw new Error(
        `[windows-cua-helper-assets] invalid runtime dependency package.json: ${packageName}`,
        { cause: error },
      );
    }
    if (
      !isPlainRecord(packageJson) ||
      packageJson.name !== packageName ||
      (packageJson.dependencies !== undefined && !isPlainRecord(packageJson.dependencies))
    ) {
      throw new Error(
        `[windows-cua-helper-assets] invalid runtime dependency metadata: ${packageName}`,
      );
    }
    for (const dependencyName of Object.keys(packageJson.dependencies ?? {}).sort()) {
      await verifyPackage(dependencyName);
    }
  };

  const runtimePackageNames = ["express", ...resolveSharpRuntimePackageNames(targetPlatform)];
  for (const packageName of runtimePackageNames) {
    await verifyPackage(packageName);
  }
}

/**
 * electron-builder 完成资源复制后，按发布 manifest 重新验证最终安装目录。
 */
export async function inspectPackagedWindowsCuaHelper({
  resourcesDir,
  targetPlatform,
  electronVersion,
  verifyHashes,
  lstatOperation = lstat,
  realpathOperation = realpath,
  readFileOperation = readFile,
}) {
  if (targetPlatform?.os !== "win32") {
    return { status: "skipped", reason: "unsupported-platform" };
  }
  if (!isAbsolute(resourcesDir)) {
    throw new Error("[windows-cua-helper-assets] resourcesDir must be absolute");
  }
  const expectedMachine = PE_MACHINE_BY_ARCH[targetPlatform.arch];
  if (!expectedMachine) {
    throw new Error(
      `[windows-cua-helper-assets] unsupported Windows architecture: ${targetPlatform.arch}`,
    );
  }
  const expectedElectronVersion = electronVersion?.trim();
  if (!expectedElectronVersion) {
    throw new Error("[windows-cua-helper-assets] electronVersion is required");
  }

  const root = resolve(resourcesDir, "tools", "cua-helper");
  let rootStats;
  try {
    rootStats = await lstatOperation(root);
  } catch (error) {
    throw new Error(`[windows-cua-helper-assets] packaged root is missing: ${root}`, {
      cause: error,
    });
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(
      `[windows-cua-helper-assets] packaged root must be a regular directory: ${root}`,
    );
  }
  const [physicalResourcesDir, physicalRoot] = await Promise.all([
    realpathOperation(resourcesDir),
    realpathOperation(root),
  ]);
  // 根因：root 自身不是链接并不能排除父级 tools 是 junction；整棵 Helper 树仍可能落到 resources 外。
  assertPhysicalContainment(physicalResourcesDir, physicalRoot, "packaged root");

  const manifestPath = resolve(root, RUNTIME_MANIFEST);
  const manifestBytes = await readRegularFileSnapshot(manifestPath, RUNTIME_MANIFEST, {
    lstatOperation,
    readFileOperation,
  });
  const physicalManifestPath = await realpathOperation(manifestPath);
  assertPhysicalContainment(physicalRoot, physicalManifestPath, RUNTIME_MANIFEST);

  let manifest;
  try {
    manifest = JSON.parse(
      Buffer.isBuffer(manifestBytes) ? manifestBytes.toString("utf8") : String(manifestBytes),
    );
  } catch (error) {
    throw new Error(`[windows-cua-helper-assets] invalid ${RUNTIME_MANIFEST}: ${manifestPath}`, {
      cause: error,
    });
  }
  if (
    !isPlainRecord(manifest) ||
    !isPlainRecord(manifest.sha256) ||
    !hasExactKeys(manifest, [
      "schemaVersion",
      "packageName",
      "packageVersion",
      "platform",
      "arch",
      "electronVersion",
      "entry",
      "addon",
      "sha256",
    ]) ||
    !hasExactKeys(manifest.sha256, ["entry", "addon"]) ||
    !isNonEmptyTrimmedString(manifest.packageVersion) ||
    typeof manifest.entry !== "string" ||
    typeof manifest.addon !== "string" ||
    typeof manifest.sha256.entry !== "string" ||
    typeof manifest.sha256.addon !== "string" ||
    !/^[0-9a-f]{64}$/u.test(manifest.sha256.entry) ||
    !/^[0-9a-f]{64}$/u.test(manifest.sha256.addon)
  ) {
    throw new Error(
      `[windows-cua-helper-assets] invalid ${RUNTIME_MANIFEST} shape: ${manifestPath}`,
    );
  }
  if (manifest.entry === manifest.addon) {
    throw new Error(
      `[windows-cua-helper-assets] ${RUNTIME_MANIFEST} entry and addon must be distinct artifacts`,
    );
  }

  const expectedManifestFields = {
    schemaVersion: 1,
    packageName: EXPECTED_PACKAGE_NAME,
    platform: "win32",
    arch: targetPlatform.arch,
    electronVersion: expectedElectronVersion,
  };
  for (const [field, expected] of Object.entries(expectedManifestFields)) {
    if (manifest[field] !== expected) {
      throw new Error(
        `[windows-cua-helper-assets] incompatible ${RUNTIME_MANIFEST} ${field}: expected ${String(expected)}`,
      );
    }
  }

  const moduleTypePackageJsonPath = resolve(root, MODULE_TYPE_PACKAGE_JSON);
  const moduleTypePackageJsonBytes = await readRegularFileSnapshot(
    moduleTypePackageJsonPath,
    MODULE_TYPE_PACKAGE_JSON,
    {
      lstatOperation,
      readFileOperation,
    },
  );
  const physicalModuleTypePackageJsonPath = await realpathOperation(moduleTypePackageJsonPath);
  assertPhysicalContainment(
    physicalRoot,
    physicalModuleTypePackageJsonPath,
    MODULE_TYPE_PACKAGE_JSON,
  );
  let moduleTypePackageJson;
  try {
    moduleTypePackageJson = JSON.parse(
      Buffer.isBuffer(moduleTypePackageJsonBytes)
        ? moduleTypePackageJsonBytes.toString("utf8")
        : String(moduleTypePackageJsonBytes),
    );
  } catch (error) {
    throw new Error(
      `[windows-cua-helper-assets] invalid ${MODULE_TYPE_PACKAGE_JSON}: ${moduleTypePackageJsonPath}`,
      { cause: error },
    );
  }
  if (
    !isPlainRecord(moduleTypePackageJson) ||
    moduleTypePackageJson.type !== "module" ||
    moduleTypePackageJson.version !== manifest.packageVersion
  ) {
    // 根因：entry 是 ESM；缺 module 声明或声明成 commonjs 时，模块类型只能靠 detect-module
    // 探测兜底，安装盘链上的杂散 package.json 会直接把 fork 打成 SyntaxError exit 1。
    throw new Error(
      `[windows-cua-helper-assets] ${MODULE_TYPE_PACKAGE_JSON} must declare {"type":"module"} and carry the same version as ${RUNTIME_MANIFEST}: ${moduleTypePackageJsonPath}`,
    );
  }

  const entryPath = resolveCanonicalPackagedArtifact(root, manifest.entry, "entry");
  const addonPath = resolveCanonicalPackagedArtifact(root, manifest.addon, "addon");
  const [entryBytes, addonBytes] = await Promise.all([
    readRegularFileSnapshot(entryPath, "entry", {
      lstatOperation,
      readFileOperation,
    }),
    readRegularFileSnapshot(addonPath, "addon", {
      lstatOperation,
      readFileOperation,
    }),
  ]);
  const [physicalEntryPath, physicalAddonPath] = await Promise.all([
    realpathOperation(entryPath),
    realpathOperation(addonPath),
  ]);
  // 根因：manifest 的词法路径即使位于 root 内，也可能经 junction/reparse point 指向 root 外。
  // afterPack 必须同时验证 realpath containment，不能只依赖 resolve/relative 的字符串检查。
  assertPhysicalContainment(physicalRoot, physicalEntryPath, "entry");
  assertPhysicalContainment(physicalRoot, physicalAddonPath, "addon");

  if (verifyHashes) {
    if (sha256(entryBytes) !== manifest.sha256.entry) {
      throw new Error("[windows-cua-helper-assets] entry SHA-256 hash mismatch");
    }
    if (sha256(addonBytes) !== manifest.sha256.addon) {
      throw new Error("[windows-cua-helper-assets] addon SHA-256 hash mismatch");
    }
  }
  const peMachine = parsePeMachine(addonBytes, addonPath);
  if (peMachine !== expectedMachine) {
    throw new Error(
      `[windows-cua-helper-assets] PE machine mismatch: expected 0x${expectedMachine.toString(16)}, got 0x${peMachine.toString(16)}`,
    );
  }
  // 根因：extraResources 会跳过 from 根目录下的 node_modules；仅校验 entry/addon 会让
  // “Helper 主树存在但 express/Sharp 闭包缺失”的安装包通过 afterPack。
  await verifyPackagedRuntimeDependencyClosure({
    root,
    physicalRoot,
    targetPlatform,
    lstatOperation,
    realpathOperation,
    readFileOperation,
  });

  return {
    status: "verified",
    root,
    entryPath,
    addonPath,
    peMachine,
    manifestPath,
    manifest,
    entryBytes,
    addonBytes,
  };
}

function toPackagedVerificationResult(inspection) {
  if (inspection.status === "skipped") return inspection;
  return {
    status: inspection.status,
    root: inspection.root,
    entryPath: inspection.entryPath,
    addonPath: inspection.addonPath,
    peMachine: inspection.peMachine,
  };
}

/**
 * electron-builder 完成资源复制后，按发布 manifest 严格验证最终安装目录。
 */
export async function verifyPackagedWindowsCuaHelper(options) {
  const inspection = await inspectPackagedWindowsCuaHelper({
    ...options,
    verifyHashes: true,
  });
  return toPackagedVerificationResult(inspection);
}
