import type {
  IZCodeAgentService,
  ZCodeAgentAppRuntimePreferences,
  ZCodeAgentAppUsageParams,
  ZCodeAgentCreateSessionParams,
  ZCodeAgentGrantWorkspaceHookTrustParams,
  ZCodeAgentInitializeResult,
  ZCodeAgentListSessionSubagentsParams,
  ZCodeAgentListSessionsParams,
  ZCodeAgentReadSessionEventsParams,
  ZCodeAgentReadSessionMessagesParams,
  ZCodeAgentReadSessionParams,
  ZCodeAgentReadWorkspacePresentationParams,
  ZCodeAgentResumeSessionParams,
  ZCodeAgentTaskTokenUsageParams,
  ZCodeAgentWorkspaceTarget,
} from "./zcodeAgent.js";
import type { ZCodeAgentServiceRuntime } from "./zcodeAgentServiceRuntime.js";
import {
  V4_METHODS,
  v4ConversationUsageResultSchema,
  v4UsageStatsResultSchema,
} from "@zcode/shared/zcode-protocol-v4";
import {
  ZCODE_AGENT_PROVIDER_NOT_READY_REASON,
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
  normalizeDynamicWorkflowMode,
  resolveWorkspaceKey,
  sessionDebugSnapshotSchema,
  type DynamicWorkflowMode,
  type TraceId,
  type ZCodeWorkspacePresentation,
  zcodeProtocolMethods,
  zcodeSessionEventsResultSchema,
  zcodeSessionListResultSchema,
  zcodeSessionMessagesResultSchema,
  zcodeSessionStateSnapshotSchema,
  zcodeSessionSubagentsResultSchema,
  zcodeWorkspaceHookTrustGrantResultSchema,
  zcodeWorkspacePresentationSchema,
} from "@zcode/shared";
import {
  buildSessionCreateParams,
  buildSessionResumeParams,
  formatModelSelectionForLog,
  sessionEventKey,
} from "./zcodeAgentServiceParams.js";
import {
  buildWorkspaceRef,
  getMcpServerCount,
  getMcpServerNames,
  getSessionCreateCompatFields,
  getSessionResumeCompatFields,
  isClosedStdioTransportError,
  logger,
} from "./zcodeAgentServiceSupport.js";
import { randomUUID } from "node:crypto";

export function createWorkspaceMethods(
  ctx: ZCodeAgentServiceRuntime,
): Pick<
  IZCodeAgentService,
  | "prepareStorage"
  | "getStorageStartupState"
  | "onDynamicStorageStartupState"
  | "hasActiveCuaOperationTurn"
  | "initialize"
  | "syncDynamicWorkflowUserMode"
  | "syncAppRuntimePreferences"
  | "getWorkspaceRuntimeIdentity"
  | "createSession"
  | "resumeSession"
  | "listSessions"
  | "listSessionSubagents"
  | "getAppUsageStats"
  | "getTaskTokenUsage"
  | "readSession"
  | "readSessionMessages"
  | "readSessionDebug"
  | "readSessionEvents"
  | "readWorkspacePresentation"
  | "grantWorkspaceHookTrust"
> {
  const {
    activeClientsByWorkspaceKey,
    cuaOperationTurnTracker,
    enqueueDynamicWorkflowPolicySync,
    enqueueInteractionPreferenceSync,
    ensureAccountProviderConfigSynced,
    getClient,
    getReadOnlyClient,
    getSessionTraceId,
    invalidateWorkspaceClient,
    isOffPeakToolSupported,
    isProviderNotReadyError,
    mutable,
    options,
    processManager,
    rememberSessionTrace,
    resolveDynamicWorkflowSessionFlags,
    resolveDynamicWorkflowUserMode,
    sessionTraceIdBySessionKey,
    wireClient,
  } = ctx;
  return {
    async prepareStorage(params) {
      const client = await processManager.getClient(params);
      wireClient(client, params, "chat");
      await client.storageStartup.wait();
    },
    async getStorageStartupState(params) {
      return processManager.getStorageStartupState(params);
    },
    onDynamicStorageStartupState(params) {
      const workspaceKey = resolveWorkspaceKey(params);
      return (listener) =>
        processManager.onStorageStartupChanged((event) => {
          if (event.workspaceKey === workspaceKey) listener(event.snapshot);
        });
    },
    hasActiveCuaOperationTurn(): boolean {
      return cuaOperationTurnTracker?.hasActiveTurn() ?? false;
    },
    async initialize(params: ZCodeAgentWorkspaceTarget): Promise<ZCodeAgentInitializeResult> {
      const workspaceKey = resolveWorkspaceKey(params);
      const startedAt = Date.now();
      logger.info(undefined, "开始初始化 ZCode agent", {
        workspaceKey,
        workspacePath: params.workspacePath,
      });
      try {
        const client = await getClient(params);
        logger.info(undefined, "ZCode agent 初始化完成", {
          durationMs: Date.now() - startedAt,
          transportKind: client.transportKind === "websocket" ? "websocket" : "stdio",
          workspaceKey,
          workspacePath: params.workspacePath,
        });
        return {
          available: true,
          workspaceKey,
          protocolName: ZCODE_PROTOCOL_NAME,
          protocolVersion: ZCODE_PROTOCOL_VERSION,
          transportKind: client.transportKind === "websocket" ? "websocket" : "stdio",
        };
      } catch (error) {
        const providerNotReady = isProviderNotReadyError(error);
        logger[providerNotReady ? "info" : "warn"](
          undefined,
          providerNotReady ? "ZCode agent 等待 provider/model 就绪" : "ZCode agent 初始化失败",
          {
            durationMs: Date.now() - startedAt,
            message: error instanceof Error ? error.message : String(error),
            workspaceKey,
            workspacePath: params.workspacePath,
          },
        );
        // initialize 现在承担 host 启动预热职责，但首屏不能因为 agent 缺失直接崩溃。
        // 保留 available=false 结果，让 UI/调用方沿用既有的可恢复错误路径。
        return {
          available: false,
          workspaceKey,
          protocolName: ZCODE_PROTOCOL_NAME,
          protocolVersion: ZCODE_PROTOCOL_VERSION,
          reason: error instanceof Error ? error.message : String(error),
          ...(providerNotReady ? { reasonCode: ZCODE_AGENT_PROVIDER_NOT_READY_REASON } : {}),
        };
      }
    },

    async syncDynamicWorkflowUserMode(params: { mode?: DynamicWorkflowMode }): Promise<void> {
      // launch.md「The user's choice」：本机有设置权威时传入值只是变更信号，以设置文件为准；
      // desktop-attached remote Host 没有本机设置，推来的值就是选择。
      mutable.pushedDynamicWorkflowUserMode = normalizeDynamicWorkflowMode(params.mode);
      options?.forwardDynamicWorkflowUserMode?.(await resolveDynamicWorkflowUserMode());
      await Promise.all(
        [...activeClientsByWorkspaceKey.values()].map((entry) =>
          enqueueDynamicWorkflowPolicySync(entry),
        ),
      );
    },

    async syncAppRuntimePreferences(preferences: ZCodeAgentAppRuntimePreferences): Promise<void> {
      const normalizedPreferences: ZCodeAgentAppRuntimePreferences = {
        ...preferences,
        modelIoFullRetentionEnabled: preferences.modelIoFullRetentionEnabled === true,
      };
      mutable.latestAppRuntimePreferences = normalizedPreferences;
      const activeClients = [...activeClientsByWorkspaceKey.values()];
      await Promise.all(
        activeClients.map((entry) =>
          enqueueInteractionPreferenceSync({
            client: entry.client,
            preferences: { ...normalizedPreferences },
            workspace: entry.workspace,
          }),
        ),
      );
    },

    async getWorkspaceRuntimeIdentity(params: ZCodeAgentWorkspaceTarget) {
      // 查询 runtime identity 只能观察现有进程，不能把 dormant workspace 变成活动进程。
      await getReadOnlyClient(params, "existing-only");
      return await processManager.getRuntimeIdentity(params);
    },

    async createSession(params: ZCodeAgentCreateSessionParams) {
      if (options?.prepareSessionCreation) {
        const sessionId = params.sessionId ?? `session_${randomUUID()}`;
        const directories = await options.prepareSessionCreation({
          ...params,
          sessionId,
          projectId: params.projectId ?? null,
        });
        params = {
          ...params,
          sessionId,
          additionalDirectories: params.additionalDirectories ?? directories,
        };
      } else if (params.projectId !== undefined) {
        throw new Error("project.creation-unavailable");
      }
      const startedAt = Date.now();
      const client = await getClient(params);
      await ensureAccountProviderConfigSynced({
        client,
        reason: "session_create",
        workspace: params,
        refreshRegistry: true,
      });
      const sessionTraceId = params.sessionTraceId;
      logger.info(sessionTraceId, "开始请求 ZCode Protocol session/create", {
        hasInitialModel: params.model !== undefined,
        hasInitialThoughtLevel: params.thoughtLevel !== undefined,
        initialModel: formatModelSelectionForLog(params.model),
        mcpServerCount: getMcpServerCount(params),
        mcpServerNames: getMcpServerNames(params),
        persistence: params.persistence,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      const offPeakToolEnabled = isOffPeakToolSupported(params);
      // 灰度在 client 就绪时已判定，这里是进程内已解析 promise 的再次 await（不打远端）。
      const dynamicWorkflowFlags = await resolveDynamicWorkflowSessionFlags();
      try {
        const snapshot = await client.request(
          zcodeProtocolMethods.sessionCreate,
          buildSessionCreateParams({
            ...params,
            offPeakToolEnabled,
            ...dynamicWorkflowFlags,
          }),
          zcodeSessionStateSnapshotSchema,
          sessionTraceId ? { trace: { traceId: sessionTraceId } } : undefined,
        );
        rememberSessionTrace({ ...params, sessionId: snapshot.session.sessionId }, snapshot);
        logger.info(sessionTraceId, "ZCode Protocol session/create 完成", {
          durationMs: Date.now() - startedAt,
          messageCount: snapshot.messages.length,
          modelCurrent: formatModelSelectionForLog(snapshot.settings.model.current),
          mcpServerCount: getMcpServerCount(params),
          persistence: params.persistence,
          sessionId: snapshot.session.sessionId,
          snapshotTraceId: snapshot.session.traceId ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return snapshot;
      } catch (error) {
        const compatFields = getSessionCreateCompatFields(error);
        if (compatFields.length === 0) {
          logger.warn(sessionTraceId, "ZCode Protocol session/create 失败", {
            durationMs: Date.now() - startedAt,
            message: error instanceof Error ? error.message : String(error),
            persistence: params.persistence,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          throw error;
        }
        logger.warn(sessionTraceId, "ZCode Protocol session/create 命中新旧协议兼容重试", {
          compatFields,
          durationMs: Date.now() - startedAt,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        // host/UI 可能已经发送新版 session/create 可选字段，但本地打包、
        // 远端部署或仍存活的旧 app-server 还在使用旧 strict schema。只对已知
        // 可选字段降级重试，避免 thoughtLevel/persistence 版本差阻塞首发创建。
        const snapshot = await client.request(
          zcodeProtocolMethods.sessionCreate,
          buildSessionCreateParams(
            { ...params, offPeakToolEnabled, ...dynamicWorkflowFlags },
            new Set(compatFields),
          ),
          zcodeSessionStateSnapshotSchema,
          sessionTraceId ? { trace: { traceId: sessionTraceId } } : undefined,
        );
        rememberSessionTrace({ ...params, sessionId: snapshot.session.sessionId }, snapshot);
        if (!compatFields.includes("thoughtLevel") || !params.thoughtLevel) {
          logger.info(sessionTraceId, "ZCode Protocol session/create 兼容重试完成", {
            durationMs: Date.now() - startedAt,
            sessionId: snapshot.session.sessionId,
            snapshotTraceId: snapshot.session.traceId ?? null,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          return snapshot;
        }
        // 旧 create schema 不认识 thoughtLevel 时，创建后再走旧协议已有的
        // session/setThoughtLevel，保证首轮 prompt 仍使用用户在工具栏选择的推理强度。
        const snapshotWithThoughtLevel = await client.request(
          zcodeProtocolMethods.sessionSetThoughtLevel,
          {
            sessionId: snapshot.session.sessionId,
            thoughtLevel: params.thoughtLevel,
            persistAsWorkspaceLastUsed: true,
          },
          zcodeSessionStateSnapshotSchema,
          sessionTraceId ? { trace: { traceId: sessionTraceId } } : undefined,
        );
        rememberSessionTrace(
          { ...params, sessionId: snapshotWithThoughtLevel.session.sessionId },
          snapshotWithThoughtLevel,
        );
        logger.info(
          sessionTraceId,
          "ZCode Protocol session/create 兼容重试后设置 thoughtLevel 完成",
          {
            durationMs: Date.now() - startedAt,
            sessionId: snapshot.session.sessionId,
            snapshotTraceId: snapshotWithThoughtLevel.session.traceId ?? null,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          },
        );
        return snapshotWithThoughtLevel;
      }
    },

    async resumeSession(params: ZCodeAgentResumeSessionParams) {
      params = {
        ...params,
        additionalDirectories:
          params.additionalDirectories ?? (await options?.resolveSessionDirectories?.(params)),
      };
      const startedAt = Date.now();
      const client = await getClient(params);
      await ensureAccountProviderConfigSynced({
        client,
        reason: "session_resume",
        workspace: params,
        refreshRegistry: true,
      });
      const cachedTraceId = getSessionTraceId(params);
      const offPeakToolEnabled = isOffPeakToolSupported(params);
      // 冷恢复同样按 Host 的灰度判定下发，否则恢复出来的会话会丢掉工作流工具簇。
      const dynamicWorkflowFlags = await resolveDynamicWorkflowSessionFlags();
      logger.info(cachedTraceId, "开始请求 ZCode Protocol session/resume", {
        mcpServerCount: getMcpServerCount(params),
        mcpServerNames: getMcpServerNames(params),
        modelHint: params.model ?? null,
        sessionId: params.sessionId,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        const snapshot = await client.request(
          zcodeProtocolMethods.sessionResume,
          buildSessionResumeParams({
            ...params,
            offPeakToolEnabled,
            ...dynamicWorkflowFlags,
          }),
          zcodeSessionStateSnapshotSchema,
        );
        const sessionTraceId = rememberSessionTrace(params, snapshot) ?? cachedTraceId;
        logger.info(sessionTraceId, "ZCode Protocol session/resume 完成", {
          durationMs: Date.now() - startedAt,
          messageCount: snapshot.messages.length,
          modelCurrent: formatModelSelectionForLog(snapshot.settings.model.current),
          mcpServerCount: getMcpServerCount(params),
          sessionId: params.sessionId,
          snapshotTraceId: snapshot.session.traceId ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return snapshot;
      } catch (error) {
        const compatFields = getSessionResumeCompatFields(error);
        if (compatFields.length === 0) {
          logger.warn(cachedTraceId, "ZCode Protocol session/resume 失败", {
            durationMs: Date.now() - startedAt,
            message: error instanceof Error ? error.message : String(error),
            sessionId: params.sessionId,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          throw error;
        }
        logger.warn(cachedTraceId, "ZCode Protocol session/resume 命中新旧协议兼容重试", {
          compatFields,
          durationMs: Date.now() - startedAt,
          sessionId: params.sessionId,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        const snapshot = await client.request(
          zcodeProtocolMethods.sessionResume,
          buildSessionResumeParams(
            { ...params, offPeakToolEnabled, ...dynamicWorkflowFlags },
            new Set(compatFields),
          ),
          zcodeSessionStateSnapshotSchema,
        );
        const sessionTraceId = rememberSessionTrace(params, snapshot) ?? cachedTraceId;
        logger.info(sessionTraceId, "ZCode Protocol session/resume 兼容重试完成", {
          durationMs: Date.now() - startedAt,
          sessionId: params.sessionId,
          snapshotTraceId: snapshot.session.traceId ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return snapshot;
      }
    },

    async listSessions(params: ZCodeAgentListSessionsParams) {
      const client = await getReadOnlyClient(params, params.runtimePolicy);
      const result = await client.request(
        zcodeProtocolMethods.sessionList,
        {
          workspace: buildWorkspaceRef(params),
          limit: params.limit,
          ...(params.sessionIds ? { sessionIds: params.sessionIds } : {}),
        },
        zcodeSessionListResultSchema,
      );
      for (const session of result.sessions) {
        if (session.traceId) {
          sessionTraceIdBySessionKey.set(
            sessionEventKey({ ...params, sessionId: session.sessionId }),
            session.traceId as TraceId,
          );
        }
      }
      return result.sessions;
    },

    async listSessionSubagents(params: ZCodeAgentListSessionSubagentsParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.sessionSubagents,
        {
          sessionId: params.sessionId,
          endedCursor: params.endedCursor,
          endedLimit: params.endedLimit ?? 20,
        },
        zcodeSessionSubagentsResultSchema,
      );
    },

    async getAppUsageStats(params: ZCodeAgentAppUsageParams) {
      // usage 表位于全局 session 库；复用任意已连接的 workspace client 即可拿到全应用范围数据。
      const active = activeClientsByWorkspaceKey.values().next().value;
      if (!active) {
        throw new Error("no_active_workspace");
      }
      // usage/stats → v4/usage/stats（additive query，事实源在 CLI usage store，
      // 载荷同形；旧词消费清零，CLI 旧 case 留到旧词删除之时）。
      return active.client.request(
        V4_METHODS.usageStats,
        { range: params.range, timeZone: params.timeZone },
        v4UsageStatsResultSchema,
      );
    },

    async getTaskTokenUsage(params: ZCodeAgentTaskTokenUsageParams) {
      const client = await getReadOnlyClient(params);
      // session/usage → v4/conversation/usage（同上；task 是 UI 投影概念，
      // v4 名字空间落位 conversation）。
      return client.request(
        V4_METHODS.conversationUsage,
        { sessionId: params.sessionId },
        v4ConversationUsageResultSchema,
      );
    },

    async readSession(params: ZCodeAgentReadSessionParams) {
      const client = await getReadOnlyClient(params, params.runtimePolicy);
      // task-index 为补正文索引调用 readSession 时，默认策略会在 runtime
      // 已被回收后重新拉起 Agent；这条观察路径不应改变 session 生命周期。只有显式
      // 的普通读取才同步 provider registry，existing-only 读取必须保持纯观察语义。
      if (params.runtimePolicy !== "existing-only") {
        await ensureAccountProviderConfigSynced({
          client,
          reason: "session_read",
          workspace: params,
        });
      }
      const snapshot = await client.request(
        zcodeProtocolMethods.sessionRead,
        {
          sessionId: params.sessionId,
          deliveryKind: params.deliveryKind,
          messageLimit: params.messageLimit,
          afterSeq: params.afterSeq,
          contentProfile: params.contentProfile,
        },
        zcodeSessionStateSnapshotSchema,
      );
      rememberSessionTrace(params, snapshot);
      return snapshot;
    },

    async readSessionMessages(params: ZCodeAgentReadSessionMessagesParams) {
      const client = await getReadOnlyClient(params);
      const result = await client.request(
        zcodeProtocolMethods.sessionMessages,
        {
          sessionId: params.sessionId,
          afterMessageId: params.afterMessageId,
          limit: params.limit,
        },
        zcodeSessionMessagesResultSchema,
      );
      return result.messages;
    },

    async readSessionDebug(params) {
      const client = await getReadOnlyClient(params, "existing-only");
      return client.request(
        zcodeProtocolMethods.sessionDebug,
        { sessionId: params.sessionId },
        sessionDebugSnapshotSchema,
      );
    },

    async readSessionEvents(params: ZCodeAgentReadSessionEventsParams) {
      const client = await getReadOnlyClient(params);
      const result = await client.request(
        zcodeProtocolMethods.sessionEvents,
        {
          sessionId: params.sessionId,
          afterSeq: params.afterSeq,
          limit: params.limit,
        },
        zcodeSessionEventsResultSchema,
      );
      return result.events;
    },

    async readWorkspacePresentation(params: ZCodeAgentReadWorkspacePresentationParams) {
      const startedAt = Date.now();
      logger.info(undefined, "开始请求 ZCode Protocol workspace/readPresentation", {
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        let presentation: ZCodeWorkspacePresentation | undefined;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const client = await getReadOnlyClient(params);
          try {
            await ensureAccountProviderConfigSynced({
              client,
              reason: "workspace_read_presentation",
              workspace: params,
            });
            presentation = await client.request(
              zcodeProtocolMethods.workspaceReadPresentation,
              { workspace: buildWorkspaceRef(params) },
              zcodeWorkspacePresentationSchema,
            );
            break;
          } catch (error) {
            if (attempt > 0 || !isClosedStdioTransportError(error)) {
              throw error;
            }
            // 读取 workspace 状态时，配置更新可能正好重启该 workspace Agent。
            // 旧 client 已取得但尚未发送请求，stdio transport 就被关闭；只读请求重新获取
            // 当前 client 并重试一次，避免把生命周期竞态直接暴露给用户。
            logger.warn(
              undefined,
              "workspace/readPresentation 命中已关闭 transport，重新获取 Agent",
              {
                workspaceKey: resolveWorkspaceKey(params),
                workspacePath: params.workspacePath,
              },
            );
            const workspaceKey = resolveWorkspaceKey(params);
            if (activeClientsByWorkspaceKey.get(workspaceKey)?.client === client) {
              // transport.send 可能先观察到关闭，而 onClose 清理尚未执行；统一走 identity-
              // guarded invalidation，避免只删 active entry 却遗留 preference/model sync 状态。
              invalidateWorkspaceClient(workspaceKey, client);
            }
          }
        }
        if (!presentation) {
          throw new Error("ZCode Protocol workspace/readPresentation did not return a result");
        }
        logger.info(undefined, "ZCode Protocol workspace/readPresentation 完成", {
          durationMs: Date.now() - startedAt,
          slashCommandCount: presentation.slashCommands.length,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return presentation;
      } catch (error) {
        logger.warn(undefined, "ZCode Protocol workspace/readPresentation 失败", {
          durationMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    async grantWorkspaceHookTrust(params: ZCodeAgentGrantWorkspaceHookTrustParams) {
      // 没有 task 时仍允许显式预信任，但只启动 read-only Agent 控制面；不能为了
      // Settings 操作伪造 session，也不能要求 provider/model 已就绪。
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.workspaceHookTrustGrant,
        {
          workspace: buildWorkspaceRef(params),
          bundleDigest: params.bundleDigest,
          hookDeclarationDigest: params.hookDeclarationDigest,
        },
        zcodeWorkspaceHookTrustGrantResultSchema,
      );
    },
  };
}
