import { createDesktopNativePackagePrunePatterns } from "./scripts/desktop-native-package-policy.mjs";
import {
  PACKAGING_PRUNE_PATTERNS,
  createBuildContext,
  resolveElectronDownloadMirror,
} from "./build-config/context.mjs";
import { createAsarTools } from "./build-config/asar.mjs";
import { runTimedAsync, runTimedSync } from "./build-config/timing.mjs";
import { createRuntimeInjection } from "./build-config/runtime-injection.mjs";
import { createPackagingAssertions } from "./build-config/packaging-assertions.mjs";
import { createMacAdHocSigner } from "./build-config/macos-adhoc-signing.mjs";
import { createPackagingHooks } from "./build-config/hooks.mjs";
import { createExtraResources } from "./build-config/resources.mjs";
import {
  createDebOptions,
  createDmgOptions,
  createLinuxOptions,
  createMacOptions,
  createNsisOptions,
  createPacmanOptions,
  createProtocols,
  createPublishOptions,
  createRpmOptions,
  createWindowsOptions,
} from "./build-config/targets.mjs";

const REQUIRED_ASAR_RUNTIME_MODULES = [
  // pnpm hoists node-pty to the workspace root, which electron-builder does not consistently copy
  // from a nested desktop package. The packaged terminal needs its JS runtime and target native prebuild.
  "node-pty",
  "module-details-from-path",
  "@opentelemetry/api-logs",
  // Bugfix: telemetry 的 OTLP exporter 会在启动阶段加载 sdk-metrics。pnpm 开发态可从
  // workspace 根目录解析，但 electron-builder 不会稳定复制这条 hoisted 依赖，导致安装包启动即崩溃。
  // 将 sdk-metrics 作为闭包根注入，同时递归带齐它的 OpenTelemetry 运行时依赖。
  "@opentelemetry/sdk-metrics",
  // Bugfix：主进程的本地 TTFT / renderer 动作追踪导出器使用 OTLP proto 导出链。pnpm hoisted 布局下
  // electron-builder 会把 otlp-transformer 打进 app.asar，却漏拷其传递依赖 protobufjs，已安装应用启动即报
  // Cannot find module protobufjs/minimal（开源侧 3.14.0 arm64 DMG 实测复现）。以两个 proto exporter
  // 作为闭包根注入，递归带齐 otlp-transformer、protobufjs 与 @protobufjs/* 全链。
  "@opentelemetry/exporter-trace-otlp-proto",
  "@opentelemetry/exporter-metrics-otlp-proto",
  "pngjs",
  // Bugfix: @arms/rum-core 把 @babel/runtime 声明成 peerDependency，pnpm 安装时可由 peer 解析兜住，
  // 但 electron-builder 重打 app.asar 时不会因为 @arms/rum-electron 本体进包，就稳定把这个 peer 运行时一起带上。
  // 线上已出现安装包启动即报 Cannot find module '@babel/runtime/helpers/interopRequireDefault'，
  // 这里显式把 @babel/runtime 作为闭包根注入，确保 ARMS 主进程埋点链路在生产包内可解析。
  "@babel/runtime",
  // Bugfix: @zcode/services 的代理连通性探测会动态 require("undici") 取 ProxyAgent。
  // tsup 虽然把 services 代码并进了主/host 产物，但不会把这个运行时 require 的包内联进去，
  // electron-builder 产物又可能漏掉 hoisted 的 undici，最终 mac 安装包启动即报 Cannot find module "undici"。
  // 这里把 undici 和其他兜底依赖一样强制注入 app.asar，避免用户在已安装应用里主进程直接崩溃。
  "undici",
  // Bugfix：main/host 将 yaml 外置以避免 Electron ESM 动态加载崩溃；声明直接依赖仍不保证
  // electron-builder 会将其放进 app.asar。缺少 yaml 会让已安装应用启动时触发 ERR_MODULE_NOT_FOUND。
  // 纳入 afterPack 注入闭包，并与 bundle.mjs 的最终产物校验保持一致。
  "yaml",
  // Bugfix：electron-builder 的 pnpm collector 会漏掉 main entry 的 ARMS ESM 依赖，
  // 导致应用启动时报 Cannot find package '@arms/rum-electron'。显式列入注入根。
  "@arms/rum-electron",
  // node-forge 一直只写在 bundle.mjs 的校验名单里，靠 electron-builder 自己打进 app.asar；
  // 这与 yauzl 漏 pend 是同一类隐患——校验要求的模块必须有人负责补齐。node-forge 无子依赖，
  // 已在产物里时 afterPack 扫描会跳过它，不改变现有打包结果。
  "node-forge",
  // 2.7.0 起 services 新增反馈日志压缩链路并引入 yazl；2.6.0 没有这条启动期依赖，
  // pnpm hoisted 布局下 yazl 可能进了 app.asar，但子依赖 buffer-crc32 没有稳定随包进入产物；
  // 这里显式以 yazl 作为闭包根注入，让递归依赖收集把 ZIP 打包链路所需依赖一起补齐。
  "yazl",
  // yauzl 成为 desktop/services 的直接生产依赖后，pnpm list --prod 会把顶层 yauzl 节点
  // 去重成没有子依赖的空节点；electron-builder 的 pnpm collector 以先登记的空节点为准，
  // 跳过后面带完整子树的那个，于是 app.asar 里有 yauzl 却没有它的运行时依赖 pend，
  // 要到 bundle 校验阶段才报「缺少运行时依赖 pend」。这里以 yauzl 作为闭包根注入，
  // 与 bundle.mjs 的校验名单保持一致，让递归依赖收集把 pend 一起补进产物。
  "yauzl",
  // Code Intelligence 使用 TypeScript compiler API。其 CommonJS 动态 require 不能内联到 ESM；
  // 必须随安装包提供，并在 bundle 阶段校验，避免 main/host 启动失败。
  "typescript",
  // Bugfix: 飞书 SDK 被 desktop main/host 外置后，安装包运行时必须能从 app.asar 解析到它。
  // 这里显式注入 scoped 包，避免开发态正常、生产包启动时才报 Cannot find module。
  "@larksuiteoapi/node-sdk",
  // 生产态里 ssh2 虽然被打进 app.asar，但它的依赖链偶发被 electron-builder 漏拷。
  // 已出现线上报错 Cannot find module 'asn1'（Require stack: ssh2 keyParser）。
  // 这里把 ssh2 关键依赖链一起注入，避免远程 SSH 连接在已安装应用里因缺包直接失败。
  "asn1",
  "bcrypt-pbkdf",
  "tweetnacl",
  // electron-updater → builder-util-runtime → debug 运行时 require("ms")。
  // pnpm hoisted 布局下 electron-builder 偶发漏拷这个叶子依赖；3.4.0(ci/cua-v0.3.17 打的)
  // 已在线上触发安装包启动即报 Cannot find module 'ms'（Require stack: debug/src/common.js），
  // 自动更新链路直接崩。ms 是叶子包，显式注入即可让 debug 在 app.asar 内稳定解析。
  "ms",
];

const ctx = await createBuildContext();
const asar = createAsarTools({
  asarCliPath: ctx.asarCliPath,
  workingDirectory: ctx.desktopPackageRoot,
});
const runtimeInjection = createRuntimeInjection({
  asar,
  requiredRuntimeModules: REQUIRED_ASAR_RUNTIME_MODULES,
  lookupRoots: ctx.runtimeModuleLookupRoots,
  desktopPackageRoot: ctx.desktopPackageRoot,
  targetPlatform: ctx.targetPlatform,
  runTimedSync,
  runTimedAsync,
});
const assertions = createPackagingAssertions({ asar, ctx, runTimedSync, runTimedAsync });
const packagingHooks = createPackagingHooks(ctx, {
  runtimeInjection,
  assertions,
  macAdHocSigner: createMacAdHocSigner(ctx),
  runTimedSync,
  runTimedAsync,
});

/** @type {import("electron-builder").Configuration} */
export default {
  appId: ctx.desktopProductIdentity.appId,
  // Release устанавливает флаг явно; electron-builder не должен молча собрать unsigned production app.
  forceCodeSigning: ctx.macBuildSecurity.forceCodeSigning,
  // Linux deb 打包（fpm）会校验 package metadata 中的 homepage、author.email、maintainer。
  // CI 环境下若这些字段缺失会在产物阶段直接失败。这里统一在构建配置补齐，避免依赖外部注入。
  extraMetadata: {
    version: ctx.buildMetadata.appVersion,
    zcodeProductFlavor: ctx.desktopProductIdentity.flavor,
    homepage: "https://zcode.z.ai",
    author: {
      name: "ZCode",
      email: "dev@zcode.z.ai",
    },
  },
  // macOS 签名阶段会对 Electron Framework 下每个语言包逐个 codesign。
  // 默认全量语言会产生大量 locale.pak 签名调用，显著拉长打包时长。
  // 这里仅保留当前产品必需语言，减少签名文件数并缩短 CI 总耗时。
  electronLanguages: ["en-US", "zh-CN"],
  // pnpm workspace + semver range（如 ^41.0.3）下，electron-builder
  // 有时无法从依赖树里稳定推导出 Electron 版本，导致 bundle 直接中断。
  // 显式写死当前桌面端使用的 Electron 版本，避免打包阶段再做不可靠的猜测。
  electronVersion: "41.0.3",
  // 旧 Windows 协议注册可能在应用 JS 重写注册表前注入 --inspect-brk。
  // 在签名前关闭原生 Inspector 参数，覆盖升级后首次启动；保留 Agent 所需的 RunAsNode。
  ...(ctx.targetPlatform.os === "win32"
    ? { electronFuses: { enableNodeCliInspectArguments: false } }
    : {}),
  electronDownload: {
    // ELECTRON_MIRROR 是 @electron/get 的全局环境变量，会覆盖 dmg-builder 等
    // generic artifact 自己传入的 mirrorOptions，导致 builder 辅助包被错误拼到 Electron runtime 镜像目录。
    // 这里改用 electron-builder 的专用配置，只影响 Electron runtime zip 下载。
    mirror: resolveElectronDownloadMirror(),
  },
  productName: ctx.desktopProductIdentity.productName,
  directories: {
    // macOS arm64/x64 CI 可能共享同一个 checkout 并行打包。
    // 输出根目录允许按架构隔离，避免一个 job 清理 dist 时删除另一个 job 正在签名的 .app。
    output: ctx.desktopDistDir,
    buildResources: "build",
  },
  files: [
    "out/**/*",
    "package.json",
    // app.asar 会把桌面端运行时 node_modules 一并打进去，依赖包自带的 .map / README
    // 默认也会原样进入安装包。这里统一在主包层做一次裁剪，只移除非运行时文件，LICENSE 继续保留。
    ...PACKAGING_PRUNE_PATTERNS,
    ...createDesktopNativePackagePrunePatterns(ctx.targetPlatform.key),
    "!node_modules/@zcode/**",
    "!node_modules/react/**",
    "!node_modules/react-dom/**",
  ],
  asarUnpack: [
    // node-pty 的 target prebuild 还包含 spawn-helper / winpty-agent.exe 等辅助可执行文件，
    // 整个目标目录必须 unpack；其他平台目录已由 files 规则裁剪。
    `node_modules/node-pty/prebuilds/${ctx.targetPlatform.key}/**`,
  ],
  beforePack: packagingHooks.beforePack,
  afterExtract: packagingHooks.afterExtract,
  afterPack: packagingHooks.afterPack,
  ...(ctx.shouldPackageWindowsBrowserImportHelper
    ? {
        afterSign: packagingHooks.afterSign,
      }
    : {}),
  extraResources: createExtraResources(ctx),
  // postinstall 会先优先复用 node-pty 自带的 Windows 预编译产物，其他平台再按需 electron-rebuild。
  // 打包阶段统一复用安装时准备好的原生文件，避免 electron-builder 再触发一轮不受控的本地编译。
  npmRebuild: false,
  // OAuth deep link 协议注册（macOS 打包后需要 Info.plist 中声明 CFBundleURLTypes）
  protocols: createProtocols(ctx),
  mac: createMacOptions(ctx),
  win: createWindowsOptions(ctx),
  linux: createLinuxOptions(ctx),
  deb: createDebOptions(ctx),
  pacman: createPacmanOptions(ctx),
  rpm: createRpmOptions(ctx),
  dmg: createDmgOptions(),
  nsis: createNsisOptions(),
  detectUpdateChannel: false,
  publish: createPublishOptions(),
};
