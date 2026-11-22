/**
 * process-manager/commandResolver.ts: Резолвинг команды запуска агента (env → monorepo →
 * Electron runtime → deployed binary), preflight cwd/command и dev stdio-tap proxy.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { ZCODE_AGENT_RUNTIME } from "@zcode/shared";
import { resolveZCodeAgentSpawnCwd } from "#src/zcode-agent/zcodeAgentSpawnCwd.js";
import { readZCodeStdioTapDevState } from "#src/zcode-agent/zcodeStdioTapDevConfig.js";
import { debugLog } from "./logging.js";
import type {
  ZCodeAgentCommand,
  ZCodeAgentCommandResolverContext,
  ZCodeAgentSpawnPreflight,
} from "./types.js";
import {
  findZCodeAgentRuntimeBinary,
  findZCodeAgentRuntimeNodeBundle,
} from "#src/runtime-tools/providerRuntimeResolver.js";

function parseArgsJson(raw: string | undefined): string[] | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("ZCODE_AGENT_SERVER_ARGS_JSON must be a JSON string array");
  }
  return parsed;
}

function findUpward(relativePath: string): string | null {
  let current = process.cwd();
  while (true) {
    const candidate = join(current, relativePath);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export async function buildZCodeAgentSpawnPreflight(
  command: ZCodeAgentCommand,
  workspacePath: string,
  spawnFallbackCwd?: string,
): Promise<ZCodeAgentSpawnPreflight> {
  const commandPathKind = isAbsolute(command.command) ? "absolute" : "path-search";
  const requestedCwd = command.cwd ?? workspacePath;
  const {
    cwd,
    usedFallback: shouldUseWorkspaceFallback,
    cwdExists,
  } = await resolveZCodeAgentSpawnCwd({ requestedCwd, workspacePath, spawnFallbackCwd });
  return {
    command: command.command,
    args: command.args ?? [],
    requestedCwd,
    cwd,
    cwdSource: shouldUseWorkspaceFallback
      ? "workspace-fallback"
      : command.cwd === undefined
        ? "workspace"
        : "command",
    commandPathKind,
    // Node spawn 的 ENOENT 既可能来自 command 缺失，也可能来自 cwd 缺失。
    // 生产日志在 spawn 前同时记录两者可见性，避免把工作区路径丢失误判成自动更新丢 binary。
    commandExists: commandPathKind === "absolute" ? existsSync(command.command) : null,
    cwdExists,
  };
}

function resolveBundledWorkspaceZCodeAgentCommand(
  context: ZCodeAgentCommandResolverContext,
): ZCodeAgentCommand | null {
  const distEntrypoint = findUpward("apps/zcode-cli/packages/cli/dist/zcode.cjs");
  if (distEntrypoint) {
    const useBytecode =
      process.versions.electron && process.env.ZCODE_DESKTOP_AGENT_BYTECODE === "1";
    const entrypoint = useBytecode
      ? join(dirname(distEntrypoint), "zcode.bytecode.cjs")
      : distEntrypoint;
    // 此同步 command resolver 沿用既有 existsSync 契约；显式试验不能静默回退成 JS。
    if (useBytecode && !existsSync(entrypoint)) {
      throw new Error("桌面 Agent 字节码入口缺失，请运行 pnpm build:desktop-agent:bytecode");
    }
    return {
      command: process.execPath,
      args: [entrypoint, "app-server", "--stdio"],
      // Worker 与 Electron Node 子进程的 V8 snapshot 可不同；临时存储准备继续用 JS。
      storagePreparationEntry: distEntrypoint,
      cwd: context.workspacePath,
      // 桌面端 host 运行在 Electron utility process 中，process.execPath 指向 Electron Helper。
      // 这里显式启用 Node 运行模式，避免内置 zcode-agent 被当成 Electron/Chromium 子进程启动并卡在 GPU 初始化。
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }

  const sourceEntrypoint = findUpward("apps/zcode-cli/packages/cli/src/main.ts");
  const tsxEntrypoint = findUpward("node_modules/.bin/tsx");
  if (!sourceEntrypoint || !tsxEntrypoint) {
    return null;
  }
  return {
    command: tsxEntrypoint,
    args: [sourceEntrypoint, "app-server", "--stdio"],
    cwd: context.workspacePath,
  };
}

function resolveDeployedZCodeAgentBinaryCommand(
  context: ZCodeAgentCommandResolverContext,
): ZCodeAgentCommand | null {
  // 旧 resolver 只识别 ZCODE_AGENT_SERVER_COMMAND env 和 monorepo 源码树。
  // SSH 远端把 zcode-server.cjs 单文件部署到 ~/.zcode/server/，宿主进程的 cwd 不在仓库内、
  // env 也不会被 ssh exec 继承，即使 zcode-agent 已经部署到 ~/.zcode/server/agents/glm/，
  // resolver 也找不到，第一次 getClient 就抛 "ZCode agent server command is not configured"。
  // 这里复用 findZCodeAgentRuntimeBinary 的候选链（含 GLM_BINARY_PATH env、
  // packagedResourcesPath、~/.zcode/server/agents/glm、bundled-agents 等），
  // 把已部署的原生 binary 当成最终兜底，远端/桌面打包形态都能命中。
  const binaryPath = findZCodeAgentRuntimeBinary();
  if (!binaryPath) {
    return null;
  }
  return {
    command: binaryPath,
    args: ZCODE_AGENT_RUNTIME.spawnArgs,
    cwd: context.workspacePath,
  };
}

function resolveElectronRuntimeZCodeAgentCommand(
  context: ZCodeAgentCommandResolverContext,
): ZCodeAgentCommand | null {
  // 桌面打包态：host 跑在 Electron utility process 里，process.execPath 指向 Electron Helper，
  // 它内置的 Node runtime 与 zcode-cli 目标版本一致（Electron 41 = Node 24.x）。
  // 这里直接用 app 自带的 Electron Node 执行打进 resources/glm 的 zcode.cjs，
  // 不再随包内置一份独立 Node 二进制（体积从 ~180MB 降到 ~16MB，且跨平台同一份 JS）。
  // 用 process.versions.electron 作为闸门：远端 SSH/WSL host 由系统 Node 运行、没有 electron，
  // 会跳过这里继续走原生二进制兜底，桌面/远端两条链路互不影响。
  if (!process.versions.electron) {
    return null;
  }
  const bundlePath = findZCodeAgentRuntimeNodeBundle();
  if (!bundlePath) {
    return null;
  }
  return {
    command: process.execPath,
    args: [bundlePath, ...ZCODE_AGENT_RUNTIME.spawnArgs],
    storagePreparationEntry: bundlePath,
    cwd: context.workspacePath,
    // 关键：必须以纯 Node 模式启动，否则子进程会被当成 Electron/Chromium 子进程卡在 GPU 初始化。
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

export function resolveDefaultZCodeAgentCommand(
  context: ZCodeAgentCommandResolverContext,
): ZCodeAgentCommand | null {
  const command = process.env.ZCODE_AGENT_SERVER_COMMAND?.trim();
  if (command) {
    return applyPresentationSurfaceToCommand(
      {
        command,
        args: parseArgsJson(process.env.ZCODE_AGENT_SERVER_ARGS_JSON) ?? ["app-server", "--stdio"],
        cwd: process.env.ZCODE_AGENT_SERVER_CWD?.trim() || context.workspacePath,
      },
      context.presentationSurface,
    );
  }

  // 顺序：env 显式覆盖 → monorepo dev 源码/dist（dev 改源码立刻生效，不会被远端历史装的 native binary
  // 抢先匹配）→ 桌面打包态 Electron Node runtime 跑 zcode.cjs → 已部署 native binary（远端 SSH 兜底）。
  const bundled =
    resolveBundledWorkspaceZCodeAgentCommand(context) ??
    resolveElectronRuntimeZCodeAgentCommand(context);
  return applyPresentationSurfaceToCommand(
    bundled
      ? { ...bundled, supportsStorageStartup: true }
      : resolveDeployedZCodeAgentBinaryCommand(context),
    context.presentationSurface,
  );
}

function applyPresentationSurfaceToCommand(
  command: ZCodeAgentCommand | null,
  presentationSurface: ZCodeAgentCommandResolverContext["presentationSurface"],
): ZCodeAgentCommand | null {
  if (!command || presentationSurface !== "desktop") {
    return command;
  }

  const commandArgs = command.args ?? [];
  const args: string[] = [];
  for (let index = 0; index < commandArgs.length; index += 1) {
    const arg = commandArgs[index]!;
    if (arg === "--surface") {
      const nextArg = commandArgs[index + 1];
      // Bug 原因：旧逻辑无条件消费下一个 token，孤立的 --surface 会把后续
      // --stdio 等 option 一并吞掉，导致自定义 Agent 命令失去协议启动参数。
      // 只有明确的非 option value 才属于 --surface；其他 option 继续走原参数链路。
      if (nextArg !== undefined && !nextArg.startsWith("-")) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("--surface=")) {
      continue;
    }
    args.push(arg);
  }

  return {
    ...command,
    args: [...args, "--surface", "desktop"],
  };
}

export function wrapZCodeAgentCommandWithStdioTapDevProxy(
  command: ZCodeAgentCommand,
  workspaceKey: string,
): ZCodeAgentCommand {
  const tapState = readZCodeStdioTapDevState();
  if (!tapState.enabled) {
    return command;
  }

  const tapScript = findUpward("scripts/dev/zcode-stdio-tap.mjs");
  if (!tapScript) {
    debugLog("ZCode stdio tap proxy enabled but script not found");
    return command;
  }

  // 开发态 raw stdio 帧数据量和消息流同级，不能打进普通 info 日志。
  // 这里只在显式开关打开时用旁路 proxy 写盘，生产构建和默认开发路径都不受影响。
  return {
    supportsStorageStartup: command.supportsStorageStartup,
    command: process.execPath,
    args: [
      tapScript,
      "--workspace-key",
      workspaceKey,
      "--log-dir",
      tapState.logDir,
      "--",
      command.command,
      ...(command.args ?? []),
    ],
    cwd: command.cwd,
    env: {
      ...command.env,
      ELECTRON_RUN_AS_NODE: "1",
    },
  };
}
