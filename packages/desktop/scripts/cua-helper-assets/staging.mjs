// staging：按 producer 契约校验源目录，原子写入 bundled-tools 下的 cua-helper 运行时与 manifest。
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, parse, resolve } from "node:path";
import {
  EXPECTED_PACKAGE_NAME,
  MODULE_TYPE_PACKAGE_JSON,
  PE_MACHINE_BY_ARCH,
  REMOVE_DIRECTORY_OPTIONS,
  RUNTIME_MANIFEST,
  assertPhysicalContainment,
  isNonEmptyTrimmedString,
  parsePeMachine,
  readContainedJson,
  readRegularFileSnapshot,
  renameDirectoryWithRetries,
  resolveCanonicalPackagedArtifact,
  samePhysicalPath,
  sha256,
} from "./common.mjs";
import { readProducerRuntimeContract } from "./verification.mjs";
import { collectRuntimeModuleClosureEntries } from "../runtime-dependency-closure.mjs";
import { resolveSharpRuntimePackageNames } from "../sharp-package-assets.mjs";

async function copyRuntimePackage(sourceRoot, targetRoot) {
  const skippedDirectories = new Set(["test", "tests", "__tests__", "node_modules"]);
  const skippedSuffixes = [".map", ".md", ".markdown", ".ts"];
  await cp(sourceRoot, targetRoot, {
    recursive: true,
    dereference: true,
    filter(source) {
      if (source === sourceRoot) {
        return true;
      }
      const name = basename(source);
      if (skippedDirectories.has(name)) {
        return false;
      }
      return !skippedSuffixes.some((suffix) => name.endsWith(suffix));
    },
  });
}

function resolveModuleLookupRoots(sourceRoot) {
  const lookupRoots = [sourceRoot];
  const volumeRoot = parse(sourceRoot).root;
  let currentDir = dirname(sourceRoot);
  while (currentDir !== volumeRoot) {
    if (basename(currentDir) === "node_modules") {
      lookupRoots.push(dirname(currentDir));
      break;
    }
    if (existsSync(resolve(currentDir, "pnpm-workspace.yaml"))) {
      lookupRoots.push(currentDir);
      break;
    }
    currentDir = dirname(currentDir);
  }
  return lookupRoots;
}

async function atomicallyReplaceDirectory(stagedTempRoot, outputDir) {
  const backupDir = `${outputDir}.backup-${randomUUID()}`;
  let movedExistingOutput = false;
  try {
    await renameDirectoryWithRetries(outputDir, backupDir);
    movedExistingOutput = true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  try {
    await renameDirectoryWithRetries(stagedTempRoot, outputDir);
  } catch (error) {
    if (movedExistingOutput) {
      await renameDirectoryWithRetries(backupDir, outputDir);
    }
    throw error;
  }

  if (movedExistingOutput) {
    await rm(backupDir, REMOVE_DIRECTORY_OPTIONS);
  }
}

export async function resolveWindowsCuaHelperSourceRoot({
  runtimePackageDir,
  devRoot,
  servicesPackageRoot,
}) {
  const explicitRuntimePackageDir = runtimePackageDir?.trim();
  const explicitDevRoot = devRoot?.trim();
  const explicitRoot = explicitRuntimePackageDir || explicitDevRoot;
  if (explicitRoot) {
    if (!isAbsolute(explicitRoot)) {
      const variableName = explicitRuntimePackageDir
        ? "ZCODE_CUA_HELPER_RUNTIME_PACKAGE_DIR"
        : "ZCODE_CUA_DEV_ROOT";
      throw new Error(`[windows-cua-helper-assets] ${variableName} must be absolute`);
    }
    return realpath(explicitRoot);
  }

  if (!isAbsolute(servicesPackageRoot)) {
    throw new Error("[windows-cua-helper-assets] servicesPackageRoot must be absolute");
  }
  // servicesPackageRoot 固定对应当前仓库的 packages/services；CUA producer 是同一 workspace 的
  // packages/zcode-cua，禁止向上扫描到用户目录或另一个仓库。
  const workspaceRoot = resolve(servicesPackageRoot, "..", "..");
  const workspaceMarkerPath = resolve(workspaceRoot, "pnpm-workspace.yaml");
  let markerStats;
  try {
    markerStats = await lstat(workspaceMarkerPath);
  } catch (error) {
    throw new Error(
      `[windows-cua-helper-assets] pnpm-workspace.yaml is unavailable: ${workspaceMarkerPath}`,
      { cause: error },
    );
  }
  if (!markerStats.isFile() || markerStats.isSymbolicLink()) {
    throw new Error(
      `[windows-cua-helper-assets] pnpm-workspace.yaml must be a regular file: ${workspaceMarkerPath}`,
    );
  }

  const packageRoot = resolve(workspaceRoot, "packages", "zcode-cua");
  try {
    return await realpath(packageRoot);
  } catch (error) {
    throw new Error(
      `[windows-cua-helper-assets] packaged helper runtime is unavailable: ${packageRoot}`,
      { cause: error },
    );
  }
}

export async function prepareWindowsCuaHelperAssets({
  sourceRoot,
  outputRoot,
  targetPlatform,
  electronVersion,
  afterArtifactSnapshot,
  lstatOperation = lstat,
  realpathOperation = realpath,
  readFileOperation = readFile,
}) {
  if (targetPlatform?.os !== "win32") {
    return { status: "skipped", reason: "unsupported-platform" };
  }
  if (!isAbsolute(sourceRoot) || !isAbsolute(outputRoot)) {
    throw new Error("[windows-cua-helper-assets] sourceRoot and outputRoot must be absolute");
  }
  const expectedMachine = PE_MACHINE_BY_ARCH[targetPlatform.arch];
  if (!expectedMachine) {
    throw new Error(
      `[windows-cua-helper-assets] unsupported Windows architecture: ${targetPlatform.arch}`,
    );
  }
  if (!electronVersion?.trim()) {
    throw new Error("[windows-cua-helper-assets] electronVersion is required");
  }

  let sourceRootStats;
  try {
    sourceRootStats = await lstatOperation(sourceRoot);
  } catch (error) {
    throw new Error(`[windows-cua-helper-assets] source root is unavailable: ${sourceRoot}`, {
      cause: error,
    });
  }
  if (sourceRootStats.isSymbolicLink() || !sourceRootStats.isDirectory()) {
    throw new Error(
      `[windows-cua-helper-assets] source root must be a regular directory, not a symbolic link: ${sourceRoot}`,
    );
  }
  const physicalSourceRoot = await realpathOperation(sourceRoot);
  // 根因：只检查 sourceRoot 叶子会漏掉父级 junction；显式构建根必须已经解析到物理目录。
  if (!samePhysicalPath(sourceRoot, physicalSourceRoot)) {
    throw new Error(
      `[windows-cua-helper-assets] source root physical path does not match its configured location: ${sourceRoot}`,
    );
  }

  const packageJsonPath = resolve(sourceRoot, "package.json");
  const packageJson = await readContainedJson(
    physicalSourceRoot,
    packageJsonPath,
    "source package",
    { lstatOperation, realpathOperation, readFileOperation },
  );
  if (packageJson.name !== EXPECTED_PACKAGE_NAME) {
    throw new Error(
      `[windows-cua-helper-assets] unexpected package name: ${String(packageJson.name)}`,
    );
  }
  if (!isNonEmptyTrimmedString(packageJson.version)) {
    throw new Error(
      `[windows-cua-helper-assets] invalid package version: ${String(packageJson.version)}`,
    );
  }
  // 根因：消费端固定版本号和 artifact 目录会让生产者每次独立发版都必须同步改 ZCode。
  // package.json 的严格契约才是兼容边界；version 只作为安装产物的来源追踪信息。
  const producerContract = readProducerRuntimeContract(packageJson, sourceRoot);

  const entryPath = resolveCanonicalPackagedArtifact(
    sourceRoot,
    producerContract.entry,
    "zcodeCuaRuntime.windows.entry",
  );
  const addonPath = resolveCanonicalPackagedArtifact(
    sourceRoot,
    producerContract.addon,
    "zcodeCuaRuntime.windows.nativeAddon",
  );
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
  // 根因：规范相对路径仍可穿过中间 junction，必须在读取快照后核对最终物理位置。
  assertPhysicalContainment(physicalSourceRoot, physicalEntryPath, "entry");
  assertPhysicalContainment(physicalSourceRoot, physicalAddonPath, "addon");
  const actualMachine = parsePeMachine(addonBytes, addonPath);
  if (actualMachine !== expectedMachine) {
    throw new Error(
      `[windows-cua-helper-assets] PE machine mismatch: expected 0x${expectedMachine.toString(16)}, got 0x${actualMachine.toString(16)}`,
    );
  }
  await afterArtifactSnapshot?.();

  const targetKey = `win32-${targetPlatform.arch}`;
  const outputDir = resolve(outputRoot, targetKey, "cua-helper");
  const outputParent = dirname(outputDir);
  await mkdir(outputParent, { recursive: true });
  const stagedTempRoot = resolve(outputParent, `.cua-helper.tmp-${randomUUID()}`);
  await mkdir(stagedTempRoot, { recursive: true });

  try {
    const stagedEntryPath = resolveCanonicalPackagedArtifact(
      stagedTempRoot,
      producerContract.entry,
      "entry",
    );
    const stagedAddonPath = resolveCanonicalPackagedArtifact(
      stagedTempRoot,
      producerContract.addon,
      "addon",
    );
    await Promise.all([
      mkdir(dirname(stagedEntryPath), { recursive: true }),
      mkdir(dirname(stagedAddonPath), { recursive: true }),
      mkdir(resolve(stagedTempRoot, "node_modules"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(stagedEntryPath, entryBytes),
      writeFile(stagedAddonPath, addonBytes),
    ]);

    const moduleLookupRoots = resolveModuleLookupRoots(sourceRoot);
    const expressEntries = collectRuntimeModuleClosureEntries(["express"], moduleLookupRoots);
    const sharpModuleNames = resolveSharpRuntimePackageNames({
      os: "win32",
      arch: targetPlatform.arch,
    });
    const sharpModuleNameSet = new Set(sharpModuleNames);
    // Sharp 声明了所有平台的 optionalDependencies；这里只保留当前目标集合，
    // 避免把其他架构的原生包带进安装包和签名面。
    const sharpEntries = collectRuntimeModuleClosureEntries(
      sharpModuleNames,
      moduleLookupRoots,
    ).filter((entry) => sharpModuleNameSet.has(entry.moduleName));
    const runtimeEntries = [
      ...new Map(
        [...expressEntries, ...sharpEntries].map((entry) => [entry.moduleName, entry]),
      ).values(),
    ];
    for (const entry of runtimeEntries) {
      if (!entry.sourceModulePath) {
        throw new Error(
          `[windows-cua-helper-assets] missing runtime dependency: ${entry.moduleName}`,
        );
      }
      await copyRuntimePackage(
        entry.sourceModulePath,
        resolve(stagedTempRoot, "node_modules", entry.moduleName),
      );
    }

    const [stagedEntryBytes, stagedAddonBytes] = await Promise.all([
      readFile(stagedEntryPath),
      readFile(stagedAddonPath),
    ]);
    const manifest = {
      schemaVersion: 1,
      packageName: EXPECTED_PACKAGE_NAME,
      packageVersion: producerContract.packageVersion,
      platform: "win32",
      arch: targetPlatform.arch,
      electronVersion: electronVersion.trim(),
      entry: producerContract.entry,
      addon: producerContract.addon,
      sha256: {
        entry: sha256(stagedEntryBytes),
        addon: sha256(stagedAddonBytes),
      },
    };
    await writeFile(
      resolve(stagedTempRoot, RUNTIME_MANIFEST),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    // 根因（ZCT-2093176018262081536）：entry 是含裸 import 的 ESM，staging 只拷 entry/addon
    // 时把 producer 的 package.json 留在了源目录，安装目录的模块类型解析只能退到盘符根。
    // Node ≥22.7 的 detect-module 兜底了默认场景，但安装盘链上任何带 "type" 的杂散
    // package.json 都会禁用探测，fork 将以 SyntaxError exit 1 变成 broker_unavailable。
    // 在运行时根落一份显式 module 声明，让 entry 的模块类型不依赖探测、不受外部目录影响。
    const moduleTypePackageJson = {
      name: "@zcode/zcode-cua-helper-runtime",
      version: producerContract.packageVersion,
      type: "module",
      private: true,
      main: producerContract.entry,
    };
    await writeFile(
      resolve(stagedTempRoot, MODULE_TYPE_PACKAGE_JSON),
      `${JSON.stringify(moduleTypePackageJson, null, 2)}\n`,
      "utf8",
    );
    await atomicallyReplaceDirectory(stagedTempRoot, outputDir);
    return { status: "staged", outputDir, manifest, peMachine: actualMachine };
  } catch (error) {
    await rm(stagedTempRoot, REMOVE_DIRECTORY_OPTIONS);
    throw error;
  }
}
