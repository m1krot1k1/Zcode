import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { shouldReuseDesktopE2EBuild } from "../helpers/coding-plan-mock-env.js";
import { stageE2EAppOutput } from "../helpers/e2e-app-output-stage.js";
import { ensureSshRemoteReleaseAssets } from "../helpers/e2e-ssh-remote-release-assets.js";
import { hasRequiredSshE2EEnvironment } from "../../../scripts/e2e-formal-spec-selection.mjs";
import {
  BUILD_DESKTOP_AGENT_SCRIPT,
  DESKTOP_BUILD_ENTRY_POINT,
  DESKTOP_BUILD_OUTPUT_DIR,
  E2E_PACKAGED_APP_BINARY_PATH,
  E2E_RENDERER_ASSETS_DIR,
  HOST_HOME_DIR,
  HOST_USERPROFILE_DIR,
  PNPM_COMMAND,
  REPO_ROOT,
  ZCODE_CLI_ENTRYPOINT,
} from "./paths.js";
import {
  E2E_APP_ENTRY_POINT,
  E2E_APP_OUTPUT_DIR,
  E2E_APP_RENDERER_ASSETS_DIR,
  E2E_REMOTE_RELEASE_OUTPUT_DIR,
  E2E_REMOTE_RELEASE_SOURCE_DIR,
} from "./reporters.js";

export function prepareDesktopAppBuild() {
  if (E2E_PACKAGED_APP_BINARY_PATH) {
    if (!existsSync(E2E_PACKAGED_APP_BINARY_PATH)) {
      throw new Error(`[e2e] packaged app binary missing: ${E2E_PACKAGED_APP_BINARY_PATH}`);
    }
    console.log(`[e2e] using packaged app: ${E2E_PACKAGED_APP_BINARY_PATH}`);
    return;
  }
  // 修复原因：WDIO 配置会先被 esbuild 解析，CI 可执行字符串必须保持 ASCII 引号。
  // shard 的 mock 端口在父构建后才分配；有网页 mock 时必须按当前端口重建编译期 origin。
  if (shouldReuseDesktopE2EBuild(process.env)) {
    console.log("[e2e] ZCODE_E2E_SKIP_BUILD=1, skipping onPrepare build");
    assertDesktopE2EBuildReady("ZCODE_E2E_SKIP_BUILD=1");
    return;
  }
  // Bugfix: 直接执行 `wdio run` 会绕过 package.json 的 pretest:e2e；只检查
  // out 文件是否存在又会跑到旧 renderer，表现成”已修复但 e2e 仍白屏/没动作”。
  // 因此 WDIO 入口始终先构建，确保测试使用当前源码对应的桌面产物。
  runPnpmWorkspaceCommand(["--filter", "@zcode/desktop", "build:no-runtime-assets"]);
  assertDesktopE2EBuildReady("onPrepare build");
}

function runPnpmWorkspaceCommand(args: string[], options?: { timeoutMs?: number }) {
  execFileSync(PNPM_COMMAND, args, {
    cwd: REPO_ROOT,
    env: createPnpmChildEnv(),
    stdio: "inherit",
    // Bug 根因：prepare:remote-assets 会在 CI 上下载 node 二进制并串行构建多个包，
    // 无 timeout 时一旦下载/构建挂死，wdio onPrepare 会一直占住专用 runner 直到 job
    // 全局超时。这里只给防挂死的宽裕上限（冷缓存全量 prepare 约 10 分钟），不参与限速；
    // 其余调用点（本地构建）保持无 timeout。
    ...(options?.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    // 修复原因：Windows runner 上 `pnpm` 由 cmd shim 提供，直接 execFileSync("pnpm.cmd")
    // 在部分 CI 环境会报 spawnSync EINVAL，导致 WDIO 继续用缺失/旧产物启动 Electron。
    shell: process.platform === "win32",
  });
}

function assertDesktopE2EBuildReady(context: string) {
  if (!existsSync(DESKTOP_BUILD_ENTRY_POINT)) {
    throw new Error(
      `[e2e] ${context}: desktop main entrypoint missing: ${DESKTOP_BUILD_ENTRY_POINT}`,
    );
  }

  if (!isRendererE2EStoreBridgeCompiled(E2E_RENDERER_ASSETS_DIR)) {
    throw new Error(`[e2e] ${context}: renderer build is missing VITE_ZCODE_E2E_STORE_BRIDGE=1`);
  }
}

export async function stageDesktopE2EAppOutput() {
  await rm(E2E_APP_OUTPUT_DIR, { force: true, recursive: true });
  // 修复原因：开发态 pre-dev/tsup watch 会重建共享 packages/desktop/out；长批次若直接
  // 从 out 启动，运行中目录被清空后后续 loadFile 会进入 chrome-error://。构建完成后
  // 按 runId 复制不可变应用产物，让 E2E 与并行开发进程彻底隔离。
  // 使用写时复制降低多 shard 的准备成本；不能使用共享 inode 的硬链接，否则类型检查
  // 原地覆盖 out/host 时会同时破坏已经启动的隔离副本。
  await stageE2EAppOutput(DESKTOP_BUILD_OUTPUT_DIR, E2E_APP_OUTPUT_DIR);
  if (
    hasRequiredSshE2EEnvironment(process.env) ||
    process.env.ZCODE_E2E_SSH_HOST?.trim() ||
    process.env.ZCODE_E2E_SSH_A_HOST?.trim() ||
    process.env.ZCODE_E2E_SSH_B_HOST?.trim()
  ) {
    // Bug 根因：CI 只有 build:remote:assets job 产出 mock-cdn/releases/<version>，且跑在通用
    // macos runner 槽位；conversation e2e 在专用 runner 上，mock-cdn 工作区持久化目录互不
    // 相通，版本 bump 后专用 runner 必然缺新版本 release，直接 fatal 会把每次升级变成
    // CI-only 失败。改为缺目录时自动跑 prepare:remote-assets（幂等），产出后仍缺失才
    // fail-closed。
    // Bug 根因：packages/desktop 的 prepare:remote-assets 已随 legacy asset pipeline 一并删除，
    // `pnpm --filter @zcode/desktop prepare:remote-assets` 会以 ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT
    // 失败并让所有 SSH E2E 在 onPrepare 阶段 fatal；必须调用根 package.json 的
    // prepare:remote-assets（→ @zcode/server-cli stage:remote-assets）。runPnpmWorkspaceCommand
    // 的 cwd 固定为 REPO_ROOT，直接传脚本名即可命中根脚本。
    ensureSshRemoteReleaseAssets({
      releaseDir: E2E_REMOTE_RELEASE_SOURCE_DIR,
      prepareReleaseAssets: () =>
        runPnpmWorkspaceCommand(["prepare:remote-assets"], {
          // 防挂死上限：冷缓存全量 prepare 约 10 分钟，给到 30 分钟只兑现在「彻底卡死」时
          // 让 onPrepare 失败退出，正常慢路径不受影响。
          timeoutMs: 30 * 60 * 1000,
        }),
    });
    // Bug 根因：dual-SSH case 只配置 A/B target；若这里只识别 common host，就不会把
    // 当前源码构建的 remote release 放进 runId 隔离目录，远端会继续复用同版本的旧
    // server bundle，并用旧协议 schema 拒绝 enabledSource 等新字段。
    await stageE2EAppOutput(E2E_REMOTE_RELEASE_SOURCE_DIR, E2E_REMOTE_RELEASE_OUTPUT_DIR);
  }
  if (!existsSync(E2E_APP_ENTRY_POINT)) {
    throw new Error(`[e2e] staged desktop main entrypoint missing: ${E2E_APP_ENTRY_POINT}`);
  }
  if (!isRendererE2EStoreBridgeCompiled(E2E_APP_RENDERER_ASSETS_DIR)) {
    throw new Error("[e2e] staged renderer is missing VITE_ZCODE_E2E_STORE_BRIDGE=1");
  }
}

function isRendererE2EStoreBridgeCompiled(rendererAssetsDir: string) {
  if (!existsSync(rendererAssetsDir)) {
    return false;
  }

  return readdirSync(rendererAssetsDir, { withFileTypes: true }).some((entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".js")) {
      return false;
    }

    const source = readFileSync(resolve(rendererAssetsDir, entry.name), "utf-8");
    return /["'\x60]?VITE_ZCODE_E2E_STORE_BRIDGE["'\x60]?\s*:\s*["'\x60]1["'\x60]/u.test(source);
  });
}

function createPnpmChildEnv() {
  // Bugfix: WDIO 为加载 TypeScript config 会通过 NODE_OPTIONS 注入 tsx loader。
  // pnpm 11 继承该 loader 后会误尝试加载仓库根不存在的 .pnpmfile.mjs，
  // 导致 onPrepare 构建报错；子 pnpm 只负责执行 workspace script，不需要继承它。
  const { NODE_OPTIONS: _nodeOptions, ...env } = process.env;
  return {
    ...env,
    // Bugfix: WDIO 会把 HOME/USERPROFILE 改到 .e2e-home 隔离应用数据；
    // 但 onPrepare 的子 pnpm 需要真实用户目录里的 corepack/nvm 缓存，否则
    // CI 清理 .e2e-home 后会找不到 corepack 管理的 pnpm.mjs。
    ...(HOST_HOME_DIR ? { HOME: HOST_HOME_DIR } : {}),
    ...(HOST_USERPROFILE_DIR ? { USERPROFILE: HOST_USERPROFILE_DIR } : {}),
    // Bugfix: agent 构建脚本会进入 apps/zcode-cli 子 workspace；pnpm 11 的
    // verify-deps-before-run 会触发子 workspace install，但该 workspace 运行时
    // 依赖根仓库 @zcode/shared，自动 install 无法解析，必须在 E2E 构建链路关闭。
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
    // 修复原因：E2E 依赖 renderer 暴露 store bridge；只在 WDIO 构建链路显式注入，
    // 避免普通 production/test 产品构建意外暴露可变全局 store。
    VITE_ZCODE_E2E_STORE_BRIDGE: "1",
    ZCODE_DESKTOP_AGENT_BUILD_MODE: env.ZCODE_DESKTOP_AGENT_BUILD_MODE ?? "pnpm",
  };
}

export function prepareZCodeAgentServer() {
  if (E2E_PACKAGED_APP_BINARY_PATH) {
    // 真正的 Preview 包必须使用随包 Agent，禁止测试 runner 注入源码入口掩盖漏打包。
    configureZCodeAgentServerEnv();
    return;
  }
  if (process.env.ZCODE_E2E_SKIP_AGENT_BUILD === "1") {
    // 修复原因：Windows 全量 E2E 分片由父 runner 统一构建一次 agent；子 WDIO 若再次构建，
    // 会并发覆盖同一 dist 目录。跳过时仍校验入口，避免旧或缺失产物静默启动。
    console.log("[e2e] ZCODE_E2E_SKIP_AGENT_BUILD=1, skipping agent build");
    if (!existsSync(ZCODE_CLI_ENTRYPOINT)) {
      throw new Error(`ZCode CLI entrypoint not found: ${ZCODE_CLI_ENTRYPOINT}`);
    }
    configureZCodeAgentServerEnv();
    return;
  }

  // Bugfix: e2e 还在找仓库外的旧原生 zcode-agent binary，并调用已经删除的
  // `build:agent-exe`。当前桌面端统一通过 zcode-cli 的 app-server JS bundle
  // 暴露 ZCode Protocol，这里复用正式开发入口的构建脚本，之后由 bundled resolver
  // 选择已校验的 bundle，保留存储准备能力和正式桌面启动契约。
  execFileSync(process.execPath, [BUILD_DESKTOP_AGENT_SCRIPT], {
    cwd: REPO_ROOT,
    env: createPnpmChildEnv(),
    stdio: "inherit",
  });

  if (!existsSync(ZCODE_CLI_ENTRYPOINT)) {
    throw new Error(`ZCode CLI entrypoint not found: ${ZCODE_CLI_ENTRYPOINT}`);
  }

  configureZCodeAgentServerEnv();
}

export function configureZCodeAgentServerEnv() {
  // 数据库准备只信任 bundled resolver 确认的入口。E2E 即使把本轮 bundle 填进自定义
  // command，也会按 unsupported_runtime 拒绝；清除继承的覆盖，复用正式桌面解析链。
  delete process.env.ZCODE_AGENT_SERVER_COMMAND;
  delete process.env.ZCODE_AGENT_SERVER_ARGS_JSON;
  delete process.env.ZCODE_AGENT_SERVER_CWD;
}
