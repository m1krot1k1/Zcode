import { dirname, resolve } from "node:path";
import { stageElectronNotices } from "../../../scripts/third-party-notices.mjs";
import { restoreTargetNodePtyPrebuild } from "../scripts/node-pty-package-assets.mjs";
import {
  patchNsisInstallSectionFile,
  restoreNsisInstallSectionFileSync,
} from "../scripts/patch-nsis-install-section.mjs";
import {
  finalizePackagedWindowsCuaHelper,
  resolveElectronBuilderWindowsTarget,
} from "../scripts/windows-cua-helper-assets.mjs";
import { resolvePackagedResourcesDir } from "./asar.mjs";
import { requireFromConfig } from "./context.mjs";

export function createPackagingHooks(ctx, deps) {
  const { runtimeInjection, assertions, macAdHocSigner, runTimedSync, runTimedAsync } = deps;
  let nsisInstallSectionPatched = false;
  let nsisInstallSectionOriginalSource = null;
  let nsisInstallSectionPath = null;

  const beforePack = async (context) => {
    runTimedSync("beforePack:restoreTargetNodePtyPrebuild", () =>
      restoreTargetNodePtyPrebuild({
        desktopPackageRoot: ctx.desktopPackageRoot,
        targetPlatform: ctx.targetPlatform,
      }),
    );
    if (context.electronPlatformName !== "win32" || nsisInstallSectionPatched) {
      return;
    }

    nsisInstallSectionPath = resolve(
      dirname(requireFromConfig.resolve("app-builder-lib/package.json")),
      "templates",
      "nsis",
      "installSection.nsh",
    );
    const patchResult = await runTimedAsync("beforePack:patchNsisInstallSection", () =>
      patchNsisInstallSectionFile(nsisInstallSectionPath),
    );
    nsisInstallSectionPatched = true;
    nsisInstallSectionOriginalSource = patchResult.originalSource;
    if (patchResult.changed) {
      // electron-builder 在当前进程内随后才会编译 NSIS；等整个构建进程退出后恢复 node_modules
      // 中的上游模板，避免把一次打包的定制内容永久留在开发依赖里。
      process.once("exit", () => {
        restoreNsisInstallSectionFileSync({
          filePath: nsisInstallSectionPath,
          originalSource: nsisInstallSectionOriginalSource,
        });
      });
    }
  };

  const afterExtract = async (context) => {
    // 修复：macOS 重命名阶段会删除归档顶层许可证，必须在 afterExtract 保留目标平台原文。
    const framework = context.packager.info.framework;
    const resources =
      context.electronPlatformName === "darwin"
        ? resolve(context.appOutDir, framework.distMacOsAppName, "Contents", "Resources")
        : resolve(context.appOutDir, "resources");
    await stageElectronNotices(context.appOutDir, resources, framework.version);
  };

  const afterPack = async (context) => {
    const actualWindowsTarget =
      context.electronPlatformName === "win32"
        ? resolveElectronBuilderWindowsTarget({
            electronPlatformName: context.electronPlatformName,
            arch: context.arch,
            configuredTargetPlatform: ctx.targetPlatform,
          })
        : null;
    await runTimedAsync("afterPack:injectHoistedRuntimeModulesIntoAsar", () =>
      runtimeInjection.injectHoistedRuntimeModulesIntoAsar(context),
    );
    await runTimedAsync("afterPack:stripPackagedSourcemapReferences", () =>
      assertions.stripPackagedSourcemapReferences(context),
    );
    runTimedSync("afterPack:assertPackagedNativeResourcePolicy", () =>
      assertions.assertPackagedNativeResourcePolicy(context),
    );
    runTimedSync("afterPack:assertPackagedNodePtyPrebuild", () =>
      assertions.assertPackagedNodePtyPrebuild(context),
    );
    runTimedSync("afterPack:assertPackagedCuaSharp", () =>
      assertions.assertPackagedCuaSharp(context),
    );
    runTimedSync("afterPack:assertPackagedCuaKoffi", () =>
      assertions.assertPackagedCuaKoffi(context),
    );
    runTimedSync("afterPack:assertPackagedCuaHelper", () =>
      assertions.assertPackagedCuaHelper(context),
    );
    if (actualWindowsTarget && ctx.shouldPackageComputerUseHelper) {
      await runTimedAsync("afterPack:finalizePackagedWindowsCuaHelper", () =>
        finalizePackagedWindowsCuaHelper({
          resourcesDir: resolvePackagedResourcesDir(context),
          targetPlatform: actualWindowsTarget,
          electronVersion: ctx.desktopElectronVersion,
        }),
      );
      await runTimedAsync("afterPack:writeWindowsInstallManifest", () =>
        assertions.writeWindowsInstallManifest(context),
      );
    }
    if (ctx.shouldPackageWindowsBrowserImportHelper) {
      runTimedSync("afterPack:signWindowsBrowserImportHelper", () =>
        assertions.signWindowsBrowserImportHelper(context),
      );
    }
    // Preview без Apple credentials должен получить ad-hoc подпись до упаковки DMG/ZIP:
    // electron-builder 在 identity=null 时 сам не подписывает bundle, а DMG/ZIP собираются
    // из готового .app в packageInDistributableFormat уже после этого hook.
    runTimedSync("afterPack:applyMacAdHocSignature", () =>
      macAdHocSigner.applyMacAdHocSignatureIfNeeded(context),
    );
  };

  const afterSign = async (context) => {
    runTimedSync("afterSign:assertSignedWindowsBrowserImportHelper", () =>
      assertions.assertSignedWindowsBrowserImportHelper(context),
    );
  };

  return { beforePack, afterExtract, afterPack, afterSign };
}
