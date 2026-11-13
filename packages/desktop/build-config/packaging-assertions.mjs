import { existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { cleanupPackagedSourcemaps } from "../scripts/packaged-sourcemap-cleanup.mjs";
import { replaceAppAsarFromStaging } from "../scripts/app-asar-repack.mjs";
import { resolvePackagedNodePtyPrebuildPath } from "../scripts/node-pty-package-assets.mjs";
import {
  findDesktopNativePackageViolations,
  parseAsarListWithPackState,
} from "../scripts/desktop-native-package-policy.mjs";
import { createWindowsPowerShellSecurityArgs } from "../scripts/powershell-command.mjs";
import {
  isSharpRequiredByComputerUse,
  verifyStagedSharp,
} from "../scripts/sharp-package-assets.mjs";
import { verifyStagedKoffi } from "../scripts/koffi-package-assets.mjs";
import { CUA_HELPER_APP_NAME, HELPER_FILENAME, WINDOWS_INSTALL_MANIFEST_NAME } from "./context.mjs";
import { resolveAppAsarPath, resolvePackagedResourcesDir } from "./asar.mjs";

export function createPackagingAssertions({ asar, ctx, runTimedSync, runTimedAsync }) {
  async function writeWindowsInstallManifest(context) {
    if (context.electronPlatformName !== "win32") return;

    const root = context.appOutDir;
    const files = [];
    const visit = async (directory, relativeDirectory = "") => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        const absolutePath = join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(absolutePath, relativePath);
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          files.push(relativePath.replaceAll("/", "\\"));
        }
      }
    };

    await visit(root);
    files.sort();
    await writeFile(join(root, WINDOWS_INSTALL_MANIFEST_NAME), `${files.join("\r\n")}\r\n`, "utf8");
  }

  function assertPackagedCuaHelper(context) {
    if (ctx.targetPlatform.os !== "darwin" || !ctx.shouldPackageComputerUseHelper) return;
    const appPath = join(
      context.appOutDir,
      `${ctx.desktopProductIdentity.macExecutableName}.app`,
      "Contents",
      "Resources",
      "cua-helper",
      CUA_HELPER_APP_NAME,
    );
    if (!existsSync(appPath)) {
      throw new Error(`Packaged ZCode is missing bundled Computer Use Helper: ${appPath}`);
    }
  }

  async function stripPackagedSourcemapReferences(context) {
    // electron-builder 的 files 规则能排除 .map 文件，但无法删除 JS/CSS 末尾
    // 指向 sourcemap 的注释；afterPack 注入运行时依赖后也可能重新带入第三方 sourceMappingURL。
    // 这里统一清理 app.asar 与 unpacked/extraResources，保证最终发布包不暴露 sourcemap 路径入口。
    await cleanupPackagedSourcemaps({
      appAsarPath: resolveAppAsarPath(context),
      resourcesDir: resolvePackagedResourcesDir(context),
      runAsarCommand: asar.runAsarCommand,
      runTimedSync,
      runTimedAsync,
      replaceAppAsarFromStaging: ({ sourceDir, appAsarPath }) =>
        replaceAppAsarFromStaging({
          sourceDir,
          appAsarPath,
          targetPlatformKey: ctx.targetPlatform.key,
          runAsarCommand: asar.runAsarCommand,
        }),
    });
  }

  function assertPackagedNativeResourcePolicy(context) {
    const appAsarPath = resolveAppAsarPath(context);
    const entries = parseAsarListWithPackState(
      asar.runAsarCommandAndReadStdout(["list", "--is-pack", appAsarPath]),
    );
    const violations = findDesktopNativePackageViolations(entries, ctx.targetPlatform.key);
    if (violations.length > 0) {
      // supportedArchitectures 允许工作区准备多平台依赖，但安装包只能携带目标平台资源。
      // 之前 Canvas 和 node-pty 的其他平台 native 被同时写进 asar/unpacked，包体被放大数百 MiB。
      throw new Error(`桌面 native 资源边界校验失败:\n- ${violations.join("\n- ")}`);
    }
  }

  function assertPackagedNodePtyPrebuild(context) {
    const targetBinaryPath = resolvePackagedNodePtyPrebuildPath({
      resourcesDir: resolvePackagedResourcesDir(context),
      platformKey: ctx.targetPlatform.key,
    });
    if (!existsSync(targetBinaryPath))
      throw new Error(`node-pty 预编译产物缺失: ${targetBinaryPath}`);
  }

  function assertPackagedCuaSharp(context) {
    if (!isSharpRequiredByComputerUse({ desktopPackageRoot: ctx.desktopPackageRoot })) return;
    const problems = [
      [
        "packages/browser-use-plugin",
        verifyStagedSharp({
          resourcesDir: resolvePackagedResourcesDir(context),
          targetPlatform: ctx.targetPlatform,
          pluginRelativePath: "packages/browser-use-plugin",
        }),
      ],
      [
        "packages/zcode-cua-plugin",
        verifyStagedSharp({
          resourcesDir: resolvePackagedResourcesDir(context),
          targetPlatform: ctx.targetPlatform,
          pluginRelativePath: "packages/zcode-cua-plugin",
        }),
      ],
    ].flatMap(([pluginPath, pluginProblems]) =>
      pluginProblems.map((problem) => `${pluginPath}: ${problem}`),
    );
    if (problems.length > 0) {
      throw new Error(
        `node_repl sharp runtime is incomplete in the packaged app:\n- ${problems.join("\n- ")}`,
      );
    }
  }

  function assertPackagedCuaKoffi(context) {
    const problems = verifyStagedKoffi({
      resourcesDir: resolvePackagedResourcesDir(context),
      targetPlatform: ctx.targetPlatform,
    });
    if (problems.length > 0) {
      throw new Error(
        `CUA plugin koffi runtime is incomplete in the packaged app:\n- ${problems.join("\n- ")}`,
      );
    }
  }

  function assertSignedWindowsBrowserImportHelper(context) {
    if (
      !ctx.shouldPackageWindowsBrowserImportHelper ||
      context.electronPlatformName !== "win32" ||
      !ctx.shouldEnableWindowsVsign
    )
      return;
    const helperPath = resolve(context.appOutDir, "resources", "browser-import", HELPER_FILENAME);
    const appExecutablePath = resolve(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.exe`,
    );
    const script = [
      "$helper=Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $zcodeArg0;",
      "$app=Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $zcodeArg1;",
      "if($helper.Status -ne 'Valid' -or $app.Status -ne 'Valid'){",
      "[Console]::Error.WriteLine(('Authenticode status invalid: helper={0} ({1}); app={2} ({3})' -f $helper.Status,$helper.StatusMessage,$app.Status,$app.StatusMessage));",
      "exit 23};",
      "if($null -eq $helper.SignerCertificate -or $null -eq $app.SignerCertificate){",
      "[Console]::Error.WriteLine('Authenticode signer certificate missing');exit 24};",
      "if($helper.SignerCertificate.Thumbprint -ne $app.SignerCertificate.Thumbprint){",
      "[Console]::Error.WriteLine(('Authenticode signer mismatch: helper={0}; app={1}' -f $helper.SignerCertificate.Thumbprint,$app.SignerCertificate.Thumbprint));",
      "exit 25};",
    ].join("");
    // Bugfix 原因：extraResources 下的 EXE 是否进入 electron-builder 默认签名遍历会随版本变化；
    // 同时 Windows PowerShell 的 `-Command` 不会把尾随路径放进 `$args`，旧校验因此固定误报 exit 23。
    // 发布态改用 EncodedCommand，并从 PSHOME 显式加载系统 Security 模块，避免 pwsh 继承的
    // PSModulePath 让 Windows PowerShell 5.1 错误加载不兼容模块。
    runCommand(
      "powershell.exe",
      createWindowsPowerShellSecurityArgs(script, [helperPath, appExecutablePath]),
    );
  }

  function signWindowsBrowserImportHelper(context) {
    if (
      !ctx.shouldPackageWindowsBrowserImportHelper ||
      context.electronPlatformName !== "win32" ||
      !ctx.shouldEnableWindowsVsign
    )
      return;
    const helperPath = resolve(context.appOutDir, "resources", "browser-import", HELPER_FILENAME);
    runCommand("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(ctx.workspaceRoot, "scripts/sign-windows.ps1"),
      "-FilePath",
      helperPath,
    ]);
  }

  return {
    assertPackagedCuaHelper,
    assertPackagedCuaKoffi,
    assertPackagedCuaSharp,
    assertPackagedNativeResourcePolicy,
    assertPackagedNodePtyPrebuild,
    assertSignedWindowsBrowserImportHelper,
    signWindowsBrowserImportHelper,
    stripPackagedSourcemapReferences,
    writeWindowsInstallManifest,
  };
}
