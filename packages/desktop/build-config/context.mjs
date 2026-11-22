import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { HELPER_APP_NAME } from "@zcode/zcode-cua/broker/helperConstants";
import { loadBuiltinProviderConfig } from "../../../scripts/builtin-provider-config.mjs";
import { resolveMacReleaseBuildSettings } from "../../../scripts/macos-release-security.mjs";
import { resolveNativeSearchReleasePlan } from "../../../scripts/native-search-tools-config.mjs";
import { getBuildMetadata } from "../scripts/build-metadata.mjs";
import { getTargetPlatform } from "../scripts/target-platform.mjs";
import {
  resolveDesktopArtifactSuffix,
  resolveDesktopProductIdentity,
} from "../scripts/desktop-product-identity.mjs";
import { isRealComputerUseProducerInstalled } from "../scripts/computer-use-producer.mjs";

const buildConfigDir = import.meta.dirname;
const desktopPackageRoot = resolve(buildConfigDir, "..");
const workspaceRoot = resolve(desktopPackageRoot, "../..");

export const DEFAULT_ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/";
export const HELPER_FILENAME = "zcode-browser-import-helper.exe";
export const CUA_HELPER_APP_NAME = HELPER_APP_NAME;
export const WINDOWS_INSTALL_MANIFEST_NAME = ".zcode-install-manifest";
export const PACKAGING_PRUNE_PATTERNS = [
  "!**/*.map",
  "!**/*.pdb",
  "!**/__tests__/**",
  "!**/test/**",
  "!**/tests/**",
  "!**/example/**",
  "!**/examples/**",
  "!**/README*",
  "!**/CHANGELOG*",
  "!**/CONTRIBUTING*",
  "!**/CODE_OF_CONDUCT*",
  "!**/SECURITY*",
];
// pacman 依赖必须使用 Arch 官方仓库中的包名。electron-builder 的历史默认集合包含
// 已移除的 libappindicator-gtk3/http-parser，且缺少 Electron 实际需要的运行库；显式
// 维护最小运行时闭包，避免 pacman -U 无法解析依赖或启动时才暴露缺库。
export const PACMAN_RUNTIME_DEPENDENCIES = [
  "gtk3",
  "nss",
  "libxss",
  "libxtst",
  "libnotify",
  "alsa-lib",
  "mesa",
  "xdg-utils",
];

// `pnpm exec asar` 依赖 `.bin/asar`，但 @electron/asar 仅是 electron-builder 传递依赖时，
// Linux CI（pnpm hoisted）往往解析不到该二进制，`asar list` 未运行即 exit 1。
// 显式依赖 @electron/asar 并用 Node 直接执行 CLI，避免跨平台找不齐 shim。
const requireFromConfig = createRequire(resolve(desktopPackageRoot, "electron-builder.config.js"));

export { requireFromConfig };

const asarCliPath = resolve(
  dirname(requireFromConfig.resolve("@electron/asar/package.json")),
  "bin",
  "asar.js",
);

export function resolveElectronDownloadMirror(env = process.env) {
  const existingMirror =
    env.ZCODE_ELECTRON_RUNTIME_MIRROR ||
    env.NPM_CONFIG_ELECTRON_MIRROR ||
    env.npm_config_electron_mirror ||
    env.npm_package_config_electron_mirror ||
    env.ELECTRON_MIRROR;
  if (existingMirror?.trim()) {
    return existingMirror.trim();
  }

  return DEFAULT_ELECTRON_MIRROR;
}

export async function createBuildContext() {
  const buildMetadata = getBuildMetadata();
  const targetPlatform = getTargetPlatform();
  // 修复原因：Windows Chrome 导入入口已暂时隐藏，默认安装包不应继续携带、签名或校验原生 helper。
  // 代码和完整供应链保留在显式 opt-in 后，便于未来恢复而不影响当前发布流程。
  const shouldPackageWindowsBrowserImportHelper =
    targetPlatform.os === "win32" && process.env.ZCODE_ENABLE_WINDOWS_BROWSER_IMPORT === "1";
  const builtinProviderConfig = await loadBuiltinProviderConfig();
  const desktopProductIdentity = resolveDesktopProductIdentity({
    ...process.env,
    ZCODE_ENV: builtinProviderConfig.environment,
  });
  const nativeSearchReleasePlan = resolveNativeSearchReleasePlan({
    platform: targetPlatform.os,
    arch: targetPlatform.arch,
  });
  const macBuildSecurity = resolveMacReleaseBuildSettings(process.env);
  const macSigningIdentity = macBuildSecurity.identity;
  const shouldEnableMacSigning = macBuildSecurity.signingEnabled;
  // Computer Use Helper（macOS .app、Windows runtime）只随真实 producer 打包；开源占位包下跳过随包资源与校验。
  const shouldPackageComputerUseHelper = isRealComputerUseProducerInstalled({ desktopPackageRoot });
  const runtimeModuleLookupRoots = [
    desktopPackageRoot,
    workspaceRoot,
    resolve(desktopPackageRoot, "node_modules", ".pnpm", "node_modules"),
    resolve(workspaceRoot, "node_modules", ".pnpm", "node_modules"),
  ];
  const desktopDistDir = process.env.ZCODE_DESKTOP_DIST_DIR || "dist";
  const bundledCuaHelperSource = resolve(
    desktopPackageRoot,
    "bundled-cua-helper",
    targetPlatform.arch,
    HELPER_APP_NAME,
  );
  const shouldEnableWindowsVsign =
    process.platform === "win32" && process.env.ZCODE_ENABLE_WINDOWS_SIGN === "1";
  // 产物后缀只标记后端环境（_TEST）；身份靠 productName 区分，生产后端的 Preview 包没有后缀。
  const desktopArtifactEnvSuffix = resolveDesktopArtifactSuffix(process.env);
  const desktopElectronVersion = requireFromConfig("./package.json").devDependencies.electron;

  // Preview 是内部签名测试包。CI 明确打开 macOS 签名时若没有身份，必须在生成未签名包前失败，
  // 避免“产物存在”被误认为已经走完和生产版相同的签名链路。
  if (
    desktopProductIdentity.flavor === "preview" &&
    process.env.ZCODE_ENABLE_MAC_SIGN === "1" &&
    !macSigningIdentity
  ) {
    throw new Error(
      "ZCode Preview macOS packaging requires APPLE_SIGNING_IDENTITY or CSC_NAME when ZCODE_ENABLE_MAC_SIGN=1",
    );
  }

  return {
    asarCliPath,
    buildMetadata,
    builtinProviderConfig,
    bundledCuaHelperSource,
    desktopArtifactEnvSuffix,
    desktopDistDir,
    desktopElectronVersion,
    desktopPackageRoot,
    desktopProductIdentity,
    macBuildSecurity,
    macSigningIdentity,
    nativeSearchReleasePlan,
    runtimeModuleLookupRoots,
    shouldEnableMacSigning,
    shouldEnableWindowsVsign,
    shouldPackageComputerUseHelper,
    shouldPackageWindowsBrowserImportHelper,
    targetPlatform,
    workspaceRoot,
  };
}
