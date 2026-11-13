import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  collectExternalRuntimeModuleNames,
  collectRuntimeModuleClosureEntries,
  copyRuntimeModulePackage,
} from "../scripts/runtime-dependency-closure.mjs";
import { copyNodePtyRuntimePackage } from "../scripts/node-pty-package-assets.mjs";
import { replaceAppAsarFromStaging } from "../scripts/app-asar-repack.mjs";
import { resolveAppAsarPath } from "./asar.mjs";

export function createRuntimeInjection({
  asar,
  requiredRuntimeModules,
  lookupRoots,
  desktopPackageRoot,
  targetPlatform,
  runTimedSync,
  runTimedAsync,
}) {
  function normalizeAsarEntry(entry) {
    return entry.trim().replaceAll("\\", "/");
  }

  function collectBundledExternalRuntimeModules() {
    const sources = [];
    const roots = ["main", "host", "scheduler"].map((name) =>
      resolve(desktopPackageRoot, "out", name),
    );
    const visit = (directory) => {
      if (!existsSync(directory)) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const entryPath = resolve(directory, entry.name);
        if (entry.isDirectory()) visit(entryPath);
        else if (entry.isFile() && entry.name.endsWith(".js"))
          sources.push(readFileSync(entryPath, "utf8"));
      }
    };
    for (const root of roots) visit(root);
    return collectExternalRuntimeModuleNames(sources);
  }

  function resolveMissingRuntimeModules(appAsarPath) {
    const asarEntries = asar
      .runAsarCommandAndReadStdout(["list", appAsarPath])
      .split("\n")
      .map(normalizeAsarEntry)
      .filter(Boolean);
    const asarEntrySet = new Set(asarEntries);

    const runtimeModules = collectRuntimeModuleClosureEntries(
      [...new Set([...requiredRuntimeModules, ...collectBundledExternalRuntimeModules()])],
      lookupRoots,
    );
    const resolvableRuntimeModules = runtimeModules.filter((entry) => {
      if (!entry.sourceModulePath) {
        // 不同平台/安装布局下，部分运行时依赖可能被裁剪或未落到本次打包工作区。
        // 之前这里直接在 copy 阶段抛错会中断整个平台出包；改为记录告警并跳过该模块，
        // 让 afterPack 只处理当前环境确实可解析的依赖，避免 CI 因单个可选依赖缺失全量失败。
        console.warn(
          `[afterPack] runtime module not found, skip injection: ${entry.moduleName}; searched=${lookupRoots
            .map((lookupRoot) => resolve(lookupRoot, "node_modules", entry.moduleName))
            .join(", ")}`,
        );
        return false;
      }
      return true;
    });
    return resolvableRuntimeModules.filter((entry) => {
      const { moduleName } = entry;
      if (
        moduleName === "node-pty" &&
        !asarEntrySet.has(`/node_modules/node-pty/prebuilds/${targetPlatform.key}/pty.node`)
      ) {
        // node-pty 的 JS 入口即使已进入 app.asar，也不能代替当前平台的 native PTY；缺失时完整补齐包。
        return true;
      }
      const moduleRoot = `/node_modules/${moduleName}`;
      if (asarEntrySet.has(moduleRoot)) {
        return false;
      }
      for (const entry of asarEntrySet) {
        if (entry.startsWith(`${moduleRoot}/`)) {
          return false;
        }
      }
      return true;
    });
  }

  async function injectHoistedRuntimeModulesIntoAsar(context) {
    const appAsarPath = resolveAppAsarPath(context);
    if (!existsSync(appAsarPath)) {
      throw new Error(`打包产物缺少 app.asar: ${appAsarPath}`);
    }

    const missingRuntimeModules = runTimedSync("afterPack:scan-missing-runtime-modules", () =>
      resolveMissingRuntimeModules(appAsarPath),
    );
    if (missingRuntimeModules.length === 0) {
      // 之前 afterPack 每次都完整 extract/pack app.asar，即使运行时依赖已经齐全也会重复重写。
      // 这会把每次打包固定拉长十几秒到几十秒。先做缺失扫描，只有真的缺包才执行重写流程。
      console.log("[afterPack] runtime modules already complete, skip app.asar rewrite");
      return;
    }
    console.log(`[afterPack] missing runtime modules count=${missingRuntimeModules.length}`);

    // CI 会把 TMPDIR 指到项目内 .tmp，GitLab get_sources/clean 可能在脚本启动前清掉该目录。
    // afterPack 里重写 app.asar 同样依赖 mkdtempSync，必须自己兜底创建父目录，避免后续签名阶段只看到 .app 消失。
    mkdirSync(tmpdir(), { recursive: true });
    const stagingDir = mkdtempSync(resolve(tmpdir(), "zcode-app-asar-"));
    try {
      runTimedSync("afterPack:asar-extract", () =>
        asar.runAsarCommand(["extract", appAsarPath, stagingDir]),
      );

      const stagingNodeModulesDir = resolve(stagingDir, "node_modules");
      mkdirSync(stagingNodeModulesDir, { recursive: true });

      runTimedSync("afterPack:copy-runtime-modules", () => {
        for (const runtimeModule of missingRuntimeModules) {
          const { moduleName, sourceModulePath } = runtimeModule;
          const targetModulePath = resolve(stagingNodeModulesDir, moduleName);

          if (!sourceModulePath) {
            throw new Error(
              `未找到运行时依赖 ${moduleName}，已搜索: ${lookupRoots
                .map((lookupRoot) => resolve(lookupRoot, "node_modules", moduleName))
                .join(", ")}`,
            );
          }

          // pnpm hoisted 布局下，electron-builder 可能把主包打进 app.asar，
          // 却漏掉它解析时还要去根 node_modules 找的运行时依赖。
          // 之前 require-in-the-middle 漏过 module-details-from-path，这次 @fiahfy/icns 又漏了 pngjs，
          // 最终都会在已安装应用里触发 Cannot find module 并让主进程启动直接崩溃。
          // 这里按 package.json 递归补齐依赖闭包，避免每次只补一个缺失包、上线后再暴露下一个子依赖。
          // 只靠 package.json 显式依赖、本包 node_modules 镜像、files include 都没让它稳定进 asar，
          // 所以在 afterPack 阶段直接重写 app.asar，先把这些运行时包补进去，再交给后续签名和出包。
          mkdirSync(dirname(targetModulePath), { recursive: true });
          rmSync(targetModulePath, { force: true, recursive: true });
          if (moduleName === "node-pty") {
            copyNodePtyRuntimePackage({
              sourcePackageRoot: sourceModulePath,
              targetPackageRoot: targetModulePath,
              targetPlatformKey: targetPlatform.key,
            });
          } else {
            copyRuntimeModulePackage(sourceModulePath, targetModulePath);
          }
        }
      });

      await runTimedAsync("afterPack:asar-pack", () =>
        replaceAppAsarFromStaging({
          sourceDir: stagingDir,
          appAsarPath,
          targetPlatformKey: targetPlatform.key,
          runAsarCommand: asar.runAsarCommand,
        }),
      );
    } finally {
      rmSync(stagingDir, { force: true, recursive: true });
    }
  }

  return { injectHoistedRuntimeModulesIntoAsar };
}
