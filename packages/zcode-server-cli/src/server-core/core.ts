import { hostname } from "node:os";
import {
  createServerHostServices,
  disposeServiceResourcesAndWait,
  materializeZCodeBuiltinProviderConfig,
  getAppConfigDir,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  createTopicResourcePeers,
} from "@zcode/services/node";
import { IZCodeAgentService } from "@zcode/services";
import { ZCODE_VERSION } from "@zcode/shared";
import { createCoreHttpServer } from "./http.js";
import { createIngressToken } from "./ingressToken.js";
import { installParentDisconnectHandler, installStdinCloseHandler } from "./parentDisconnect.js";

import { resolveCoreServerId } from "./serverIdentity.js";
import { createTaskActivityTracker } from "./taskActivityTracker.js";
import { resolveServerCoreAgentNetwork } from "./remoteAgentNetwork.js";
import { resolveServerLayout } from "../runtime/paths.js";

declare const __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: string | undefined;

export async function runServerCore(generation: number): Promise<void> {
  let shutdown: ((reason: string) => Promise<void>) | undefined;
  let parentDisconnected = false;
  let stdinClosed = false;
  let disposeParentDisconnectHandler = (): void => undefined;
  disposeParentDisconnectHandler = installParentDisconnectHandler(() => {
    if (shutdown) void shutdown("parent-disconnected");
    else parentDisconnected = true;
  });
  // Удалённый клиент запускает Core напрямую, без IPC-родителя: уход клиента
  // виден только как EOF на stdin, иначе Core остаётся сиротой после закрытия канала.
  const disposeStdinCloseHandler = installStdinCloseHandler(
    () => {
      if (shutdown) void shutdown("stdin-closed");
      else stdinClosed = true;
    },
    { hasParentChannel: typeof process.send === "function" },
  );
  const layout = resolveServerLayout(process.env.ZCODE_SERVER_ROOT?.trim());
  const topicResourcePeers = createTopicResourcePeers();
  const explicitZCodeBuiltinProviderConfigFilePath =
    process.env[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  // Built-in Config 物化到所属 Environment 配置根（~/.zcode/v2）而不是 release 自带的 runtime 目录：
  // release 目录是不可变的，同一 releaseId 重装时 assertExistingReleaseMatches 会重算整棵树的
  // 内容哈希，多出的物化文件会让校验失败。
  const zcodeBuiltinProviderConfigFilePath = explicitZCodeBuiltinProviderConfigFilePath
    ? explicitZCodeBuiltinProviderConfigFilePath
    : typeof __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__ === "string"
      ? await materializeZCodeBuiltinProviderConfig({
          environmentConfigRoot: getAppConfigDir(),
          content: __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__,
        })
      : undefined;
  if (!zcodeBuiltinProviderConfigFilePath) {
    throw new Error(
      `当前构建未嵌入 ZCode Built-in Provider Config，且未设置 ${ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV}`,
    );
  }
  const sourceServerId = (await resolveCoreServerId()) ?? hostname() ?? "zcode-server";
  // 隔离远端靠 Host 下发的回退中继才能访问模型。这个值不是从配置里“猜”的，而是 Host 一次
  // 性下发的；没有就是没有，Core 不得自己合成一个代理。
  const agentNetwork = await resolveServerCoreAgentNetwork(layout);
  if (agentNetwork.network) {
    // eslint-disable-next-line no-console -- the supervisor forks this entry with stdio
    // ignored, so a service logger would be invisible to a core started by hand.
    console.log(
      `[server-core] agent network handoff applied from ${agentNetwork.source} (fallbackOnly=${agentNetwork.network.fallbackOnly === true})`,
    );
  } else if (agentNetwork.handoffProblem) {
    console.warn(`[server-core] agent network handoff unusable: ${agentNetwork.handoffProblem}`);
  }
  const { services, workspaceIdentityMapper, migrationFailedPathCount } =
    await createServerHostServices({
      sourceServerId,
      zcodeBuiltinProviderConfigFilePath,
      providerProvisioningTargetEnabled: true,
      remoteAgentNetwork: agentNetwork.network,
      topicResourceRelayChannel: (request) => topicResourcePeers.getChannel(request),
    });
  const taskActivityTracker = createTaskActivityTracker(services.getOptional(IZCodeAgentService));
  const ingressToken = await createIngressToken(layout);
  const http = await createCoreHttpServer(services, {
    serverId: sourceServerId,
    ingressToken,
    migrationFailedPathCount,
    workspaceIdentityMapper,
    topicResourcePeers,
  });
  const send = (message: unknown): Promise<void> => {
    if (typeof process.send !== "function" || process.connected === false) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        process.send?.(message, () => resolve());
      } catch {
        // 父进程断连后的最后一条生命周期消息不应阻塞资源释放。
        resolve();
      }
    });
  };
  // ready.version 的语义是 Core 版本；不能误发 Node runtime 版本常量
  // （22.16.0），否则消费方读取会拿到错误值。
  await send({
    type: "ready",
    host: http.host,
    port: http.port,
    version: ZCODE_VERSION,
    ...(process.env.ZCODE_SERVER_RELEASE_ID?.trim()
      ? { releaseId: process.env.ZCODE_SERVER_RELEASE_ID.trim() }
      : {}),
    generation,
  });
  let shutdownStarted = false;
  let lastRunningTaskCount = taskActivityTracker.readRunningTaskCount();
  const activitySubscription = taskActivityTracker.onDidChangeRunningTaskCount(
    (runningTaskCount) => {
      lastRunningTaskCount = runningTaskCount;
      void send({
        type: "task-activity",
        runningTasks: taskActivityTracker.readRunningTasks(),
        runningTaskCount,
      });
    },
  );
  let heartbeatInFlight: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = Promise.resolve(taskActivityTracker.readRunningTaskCount())
      .then((runningTaskCount) => {
        if (runningTaskCount !== lastRunningTaskCount) {
          lastRunningTaskCount = runningTaskCount;
          void send({
            type: "task-activity",
            runningTasks: taskActivityTracker.readRunningTasks(),
            runningTaskCount,
          });
        }
        void send({
          type: "heartbeat",
          runningTasks: taskActivityTracker.readRunningTasks(),
          at: Date.now(),
          runningTaskCount,
        });
      })
      .catch(() => {
        void send({
          type: "heartbeat",
          runningTasks: taskActivityTracker.readRunningTasks(),
          at: Date.now(),
          runningTaskCount: lastRunningTaskCount,
        });
      })
      .finally(() => {
        heartbeatInFlight = undefined;
      });
  }, 10_000);
  shutdown = async (reason: string): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    disposeParentDisconnectHandler();
    disposeStdinCloseHandler();
    clearInterval(heartbeat);
    activitySubscription.dispose();
    taskActivityTracker.dispose();
    await http.close().catch(() => undefined);
    await disposeServiceResourcesAndWait(services).catch(() => undefined);
    await send({ type: "shutdown-ack" });
    await send({ type: "exit", reason });
    try {
      process.disconnect?.();
    } catch {
      // 父进程已断连时 disconnect 可能报告 IPC_CHANNEL_CLOSED；不影响资源已释放后的退出。
    }
    // 仅设置 exitCode 无法关闭 Agent/SQLite 等仍持有的事件循环；Supervisor 的有界停止
    // 会因此等待到超时。资源释放完成后显式退出，确保 stop/restart/uninstall 真正收口。
    process.exit(0);
  };
  if (parentDisconnected) void shutdown("parent-disconnected");
  if (stdinClosed) void shutdown("stdin-closed");
  process.on("message", (message: unknown) => {
    if (
      typeof message === "object" &&
      message !== null &&
      "command" in message &&
      message.command === "shutdown"
    ) {
      void shutdown("requested");
    }
  });
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
