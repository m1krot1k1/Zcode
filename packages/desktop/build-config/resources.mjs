import { resolve } from "node:path";
import { noticesFileName } from "../../../scripts/third-party-notices.mjs";
import { CUA_HELPER_APP_NAME } from "./context.mjs";

export function createExtraResources(ctx) {
  const { targetPlatform } = ctx;
  return [
    { from: resolve(ctx.workspaceRoot, noticesFileName), to: noticesFileName },
    ...(targetPlatform.os === "darwin"
      ? [
          ...(ctx.shouldPackageComputerUseHelper
            ? [
                {
                  from: ctx.bundledCuaHelperSource,
                  to: `cua-helper/${CUA_HELPER_APP_NAME}`,
                },
              ]
            : []),
          {
            // CUA 权限浮窗的吸附数据源（CGWindowListCopyWindowInfo，不需要任何 TCC 权限）。
            // 主进程按 process.resourcesPath 解析；缺失时 watcher fail-open，浮窗仍可用
            // 只是不吸附，所以这里不做存在性断言。
            from: "resources/macos-window-bounds/zcode-window-bounds",
            to: "macos-window-bounds/zcode-window-bounds",
          },
        ]
      : []),
    {
      // 正式包不能依赖仓库目录读取社区、反馈等内置兜底配置。
      // 显式放入 resources/config，与主进程的 process.resourcesPath 解析保持一致。
      from: resolve(ctx.workspaceRoot, "config/default.json"),
      to: "config/default.json",
    },
    {
      // Provider Registry 的 ZCode Built-in Config 是静态 Provider/Model 事实的唯一内置来源。
      // 显式随包发布，避免正式 Host 回退到旧 Catalog/Preset hardcode。
      from: ctx.builtinProviderConfig.sourcePath,
      to: "config/provider/zcode-builtin.json",
    },
    {
      // 应用图标：打包后放入 resources 目录，主进程通过 process.resourcesPath 加载
      from: "build/icon.png",
      to: "icon.png",
    },
    ...(targetPlatform.os === "linux"
      ? [
          {
            // AppImage 用户级 hicolor 图标安装使用真实 512x512 资源，避免目录标称尺寸和 PNG IHDR 不一致。
            from: "build/icons/512x512.png",
            to: "icon_512x512.png",
          },
        ]
      : []),
    {
      // Windows 独立图标：开发态和打包态都统一走同一套任务栏/窗口图标资源。
      from: "build/icon_windows.png",
      to: "icon_windows.png",
    },
    ...(targetPlatform.os === "win32"
      ? [
          {
            // Windows 托盘图标：Tray 在打包态只能稳定读取 resources 下的独立资源。
            // 这里不复用窗口 PNG，避免通知区域在高 DPI 下退化成模糊缩放图。
            from: "build/icon.ico",
            to: "tray_icon.ico",
          },
        ]
      : []),
    ...(targetPlatform.os === "win32" && ctx.shouldPackageComputerUseHelper
      ? [
          {
            // 根因：electron-builder 会跳过 from 根目录下的 node_modules；主树与依赖树必须分开映射，
            // 否则安装包有 manifest/entry，却会在 Helper 启动时缺 express/Sharp。
            from: `bundled-tools/${targetPlatform.key}/cua-helper`,
            to: "tools/cua-helper",
            filter: ["**/*", "!node_modules{,/**/*}"],
          },
          {
            from: `bundled-tools/${targetPlatform.key}/cua-helper/node_modules`,
            to: "tools/cua-helper/node_modules",
            filter: ["**/*", "!**/*.map"],
          },
        ]
      : []),
    {
      // agent 运行时资产，打包到 resources/glm。
      // 桌面端内置的是 agent 的 JS bundle（glm/zcode.cjs，由 prepare:agent-bundle 生成），
      // Host 进程用 app 自带的 Electron Node runtime（ELECTRON_RUN_AS_NODE）执行 `zcode.cjs app-server --stdio`，
      // 不再随包内置独立 Node 二进制。远端 SSH/WSL 仍走原生二进制（无 Electron）。
      from: `bundled-agents/${targetPlatform.key}/glm`,
      to: "glm",
      filter: ["**/*", "!**/*.map"],
    },
    {
      // agent shell 之前完全依赖宿主系统 PATH，GUI 启动时经常拿不到用户自己装的 rg。
      // 这里把 ripgrep 作为桌面端内置 runtime tool 打进 resources/tools，
      // 后续 host/server 把该目录追加到 PATH；用户版本优先，缺失时再由随包 rg 兜底。
      from: `bundled-tools/${targetPlatform.key}/ripgrep`,
      to: "tools/ripgrep",
      filter: ["**/*"],
    },
    ...ctx.nativeSearchReleasePlan.extraResourceToolIds.map((toolId) => ({
      from: `bundled-tools/${targetPlatform.key}/${toolId}`,
      to: `tools/${toolId}`,
      filter: ["**/*"],
    })),
  ];
}
