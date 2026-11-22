import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeExecutionAdapter } from "@zcode/adapters/exec";
// PTY-порт должен создавать хост: без него инструмент PtySession не регистрируется вовсе,
// и модель физически не может запустить интерактивную сессию (REPL, визард, dev-сервер).
import { createAgentPtySessionPortWithManager } from "@zcode/adapters/exec/pty";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createNodeWebFetchHttpClientAdapter } from "@zcode/adapters/http";
import { createJimpImageProcessorAdapter } from "@zcode/adapters/image";
import { createNodeSessionMailboxAdapter } from "@zcode/adapters/mailbox";
import { createMcpAdapter } from "@zcode/adapters/mcp";
import { createPopplerPdfDocumentAdapter } from "@zcode/adapters/pdf";
import { createNodeToolArtifactStore } from "@zcode/adapters/storage";
import { PermissionService } from "@zcode/core";
import { createSessionEvent } from "@zcode/contracts";
import { resolvePath } from "@zcode/adapters/config";

import { isMessageEnabled } from "./app-config-options.js";
import { asInputHistoryStore } from "./session-store.js";
import type { AppEnvironment } from "./create-app-env.js";
import type { CreateAppDeps, SessionBoundary } from "./create-app-contracts.js";
import { createWorkspaceHookRuntimeSecurity } from "./workspace-hook-trust.js";
import {
  debugRuntimeConfigResolved,
  markMcpAdapterInitialized,
  markStorageAdaptersInitialized,
} from "./startup-marks.js";
import type { ZCodeAppOptions } from "./types.js";

/** Порты и сервисы исполнения: адаптеры, MCP, права и workspace hook security. */
export interface AppPorts {
  workspaceHookRuntimeSecurity: ReturnType<typeof createWorkspaceHookRuntimeSecurity>;
  permissionService: PermissionService;
  inputHistoryStore: ReturnType<typeof asInputHistoryStore>;
  artifactStore: NonNullable<ZCodeAppOptions["artifactStore"]>;
  imageProcessorPort: NonNullable<ZCodeAppOptions["imageProcessorPort"]>;
  sessionMailboxPort: ZCodeAppOptions["sessionMailboxPort"];
  mcpPort: ZCodeAppOptions["mcpPort"];
  ownsMcpPort: boolean;
  executionPort: NonNullable<ZCodeAppOptions["executionPort"]>;
  ownsExecutionPort: boolean;
  pdfDocumentPort: NonNullable<ZCodeAppOptions["pdfDocumentPort"]>;
  fileSystemPort: NonNullable<ZCodeAppOptions["fileSystemPort"]>;
  httpClientPort: NonNullable<ZCodeAppOptions["httpClientPort"]>;
  providerEndpointRoutingPort: ZCodeAppOptions["providerEndpointRoutingPort"];
  /** Порт интерактивных PTY-сессий; присутствие включает инструмент PtySession. */
  ptySessionPort: NonNullable<ZCodeAppOptions["ptySessionPort"]>;
  /** Освобождение PTY-сессий, которыми владеет именно этот app. */
  closePtySessions?: () => Promise<void>;
}

export function prepareAppPorts(
  deps: CreateAppDeps,
  env: AppEnvironment,
  boundary: SessionBoundary,
): AppPorts {
  const { options, logger, startupTimer, configResult, traceContext, sessionId, appVersion } = deps;
  const { storageRoot, cliStorageRoot, runtimeConfig, configuredMcpServers } = env;
  const workspaceHookRuntimeSecurity = createWorkspaceHookRuntimeSecurity({
    appVersion,
    logger,
    projectConfigPath: options.projectConfigPath,
    policy: options.workspaceHookPolicy,
    policyProvider: options.workspaceHookPolicyProvider,
    reviewHost: options.workspaceHookReviewHost,
    workspaceHookTrustEnabled: options.workspaceHookTrustEnabled,
    runtimeRoot: configResult.sources.project.workspaceHookRuntimeRoot ?? {
      // Fallback 只在 config-factory 未导出时生效（理论上不会发生）。
      // 此处原本无条件按单层 runtimeConfig.hooks 重建 runtimeRoot，与
      // config-factory 遍历 default/user/project/env/cli 全部层的推导不一致，
      // 导致 review 快照与 toggle 重建的 bundleDigest 不同，
      // 「审核中 toggle」被误报为 workspace_hooks_snapshot_mismatch。
      enabled: runtimeConfig.hooks?.enabled === true,
      timeoutMs: runtimeConfig.hooks?.timeoutMs ?? 60_000,
      maxOutputBytes: runtimeConfig.hooks?.maxOutputBytes ?? 32_768,
    },
    sessionId,
    snapshot: configResult.sources.project.workspaceHookSnapshot,
    userConfigPath: configResult.sources.user.path,
    workingDirectory: deps.workingDirectory,
    ...(options.workspaceHookReviewHost
      ? {
          emitReviewEvent: async (event) => {
            const runtime = boundary.getRuntime();
            await runtime.appendEvent(
              createSessionEvent(event.type, sessionId, event.payload, {
                traceId: traceContext.traceId,
              }),
              traceContext,
            );
          },
          emitAdmissionEvent: async (event) => {
            const runtime = boundary.getRuntime();
            await runtime.appendEvent(
              createSessionEvent(event.type, sessionId, event.payload, {
                traceId: traceContext.traceId,
              }),
              traceContext,
            );
          },
        }
      : {}),
  });
  const permissionService = new PermissionService({
    allowedTools: new Set(configResult.config.permission.allowedTools),
    autoApproveHighRisk: configResult.config.permission.autoApproveHighRisk,
    disallowedTools: new Set(configResult.config.permission.disallowedTools),
    allowMediumRiskInAutoMode: configResult.config.permission.allowMediumRiskInAuto,
  });
  const inputHistoryStore = options.inputHistoryStore ?? asInputHistoryStore(env.sessionStore);
  const artifactStore =
    options.artifactStore ??
    createNodeToolArtifactStore({
      imageCacheRootDir: join(storageRoot, "cli", "image-cache"),
      pdfCacheRootDir: join(storageRoot, "cli", "pdf-cache"),
      rootDir: join(storageRoot, "cli", "artifacts"),
      videoCacheRootDir: join(storageRoot, "cli", "video-cache"),
    });
  const imageProcessorPort = options.imageProcessorPort ?? createJimpImageProcessorAdapter();
  const messageEnabled = isMessageEnabled(options.env ?? process.env);
  const sessionMailboxPort =
    options.sessionMailboxPort ??
    (messageEnabled
      ? createNodeSessionMailboxAdapter({
          rootDir: resolvePath(
            (options.env ?? process.env).ZCODE_MAILBOX_ROOT ?? "~/.zcode/mailbox",
          ),
        })
      : undefined);
  markStorageAdaptersInitialized({
    cliStorageRoot,
    hasInjectedArtifactStore: options.artifactStore !== undefined,
    hasInjectedSessionStore: options.sessionStore !== undefined,
    startupTimer,
    storageRoot,
  });
  const mcpPort =
    options.mcpPort ??
    (runtimeConfig.mcp?.enabled === false
      ? undefined
      : (options.mcpPortFactory?.({ workingDirectory: deps.workingDirectory }) ??
        createMcpAdapter({
          clientVersion: appVersion,
          env: options.env,
          logger,
          network: {
            httpProxy: configResult.config.network.httpProxy,
            noProxy: configResult.config.network.noProxy,
            caCertFile: configResult.config.network.caCertFile,
          },
          workingDirectory: deps.workingDirectory,
        })));
  const ownsMcpPort = options.mcpPort === undefined && mcpPort !== undefined;
  const executionPort =
    options.executionPort ??
    createNodeExecutionAdapter({
      onToolExecResource: options.onToolExecResource,
      network: {
        httpProxy: configResult.config.network.httpProxy,
        noProxy: configResult.config.network.noProxy,
        caCertFile: configResult.config.network.caCertFile,
      },
      outputRootDir: join(storageRoot, "cli", "exec"),
      bashOutputTempDir: tmpdir(),
      processEnv: options.env ?? process.env,
    });
  const ownsExecutionPort = options.executionPort === undefined;
  const pdfDocumentPort =
    options.pdfDocumentPort ?? createPopplerPdfDocumentAdapter({ executionPort });
  // browser-use 控制端口：仅当宿主（desktop）注入时可用，无本地 fallback（纯 CLI 无浏览器底座）。
  const fileSystemPort = options.fileSystemPort ?? createNodeFileSystemAdapter();
  const httpClientPort =
    options.httpClientPort ??
    createNodeWebFetchHttpClientAdapter({
      env: options.env ?? process.env,
      timeoutMs: configResult.config.network.timeout,
      proxyUrl: configResult.config.network.httpProxy,
      noProxy: configResult.config.network.noProxy,
      caCertFile: configResult.config.network.caCertFile,
    });
  const providerEndpointRoutingPort = options.providerEndpointRoutingPort;
  // Причина дефекта: PtySession был реализован в core/adapters, но ни один хост не передавал
  // порт, поэтому инструмент никогда не регистрировался и был недоступен модели в рантайме.
  // Инжектированный хостом порт имеет приоритет; иначе CLI сам владеет менеджером сессий.
  const injectedPtySessionPort = options.ptySessionPort;
  const ownedPtySession = injectedPtySessionPort
    ? undefined
    : createAgentPtySessionPortWithManager();
  const ptySessionPort: NonNullable<ZCodeAppOptions["ptySessionPort"]> =
    injectedPtySessionPort ?? ownedPtySession!.port;
  markMcpAdapterInitialized({
    configuredMcpServers,
    hasInjectedMcpPort: options.mcpPort !== undefined,
    mcpEnabled: runtimeConfig.mcp?.enabled !== false,
    startupTimer,
    trustedMcpServerCount: Object.keys(runtimeConfig.mcp?.servers ?? {}).length,
  });
  debugRuntimeConfigResolved({
    configResult,
    logger,
    runtimeConfig,
  });
  return {
    workspaceHookRuntimeSecurity,
    permissionService,
    inputHistoryStore,
    artifactStore,
    imageProcessorPort,
    sessionMailboxPort,
    mcpPort,
    ownsMcpPort,
    executionPort,
    ownsExecutionPort,
    pdfDocumentPort,
    fileSystemPort,
    httpClientPort,
    providerEndpointRoutingPort,
    ptySessionPort,
    ...(ownedPtySession ? { closePtySessions: ownedPtySession.dispose } : {}),
  };
}
