import type {
  IZCodeAgentService,
  ZCodeAgentConnectionFlowParams,
  ZCodeAgentConversationResyncParams,
  ZCodeAgentConversationSubscribeParams,
  ZCodeAgentConversationUnsubscribeParams,
  ZCodeAgentRespondProviderRuntimeHeadersParams,
  ZCodeAgentRespondSessionRuntimePreferencesParams,
  ZCodeAgentServiceEvent,
  ZCodeAgentSessionSubscribeParams,
  ZCodeAgentSessionTarget,
  ZCodeAgentSetModeParams,
  ZCodeAgentSetModelParams,
  ZCodeAgentSetThoughtLevelParams,
  ZCodeAgentWorkspaceTarget,
} from "./zcodeAgent.js";
import type { AccountRequestAuthMaterial } from "#src/model-provider/accountRequestAuthService.js";
import type { ZCodeAgentServiceRuntime } from "./zcodeAgentServiceRuntime.js";
import {
  SESSION_SUBSCRIBE_MAX_ATTEMPTS,
  SESSION_SUBSCRIBE_RETRY_BASE_DELAY_MS,
  SESSION_SUBSCRIBE_RETRY_MAX_DELAY_MS,
  buildWorkspaceRef,
  logger,
} from "./zcodeAgentServiceSupport.js";
import {
  V4_METHODS,
  V4_WIRE_PROTOCOL_VERSION,
  clientHelloSchema,
  conversationTopic,
  v4ConnectionFlowResultSchema,
  v4ConversationSubscribeResultSchema,
} from "@zcode/shared/zcode-protocol-v4";
import {
  allowRequestVerificationHeaders,
  formatLogPrefix,
  isAuxiliarySessionKind,
  resolveWorkspaceKey,
  type ZCodeProviderRuntimeHeadersCancelled,
  type ZCodeSessionRuntimePreferencesResult,
  zcodeProtocolMethods,
  zcodeSessionListResultSchema,
  zcodeSessionRuntimePreferencesResultSchema,
  zcodeSessionStateSnapshotSchema,
  zcodeSessionSubscribeResultSchema,
  zcodeUncensoredGetConfigParamsSchema,
  zcodeUncensoredGetConfigResultSchema,
  type ZCodeProtocolRequest,
} from "@zcode/shared";
import { createBackgroundSessionEventCoalescer } from "#src/zcode-agent/zcodeSessionEventCoalescer.js";
import {
  formatModelSelectionForLog,
  providerRuntimeHeadersRequestKey,
  rememberBoundedEventId,
  sessionEventKey,
  type CreateZCodeAgentServiceOptions,
} from "./zcodeAgentServiceParams.js";
import type { ZCodeProtocolClient } from "./zcodeProtocolClient.js";
import { Emitter } from "@zcode/rpc";
import { readTrustedZCodeAgentV4Connection } from "./zcodeAgentConnectionScope.js";
import { supportsHistoryFirst } from "./independentPlanSupport.js";

export function createSessionMethods(
  ctx: ZCodeAgentServiceRuntime,
): Pick<
  IZCodeAgentService,
  | "setModel"
  | "setThoughtLevel"
  | "setMode"
  | "respondSessionRuntimePreferences"
  | "onDynamicWorkspaceProviderRuntimeHeadersCancelled"
  | "onDynamicSessionRuntimePreferencesRequest"
  | "respondProviderRuntimeHeaders"
  | "onDynamicProviderRuntimeHeadersRequest"
  | "onDynamicWorkspaceProviderRuntimeHeadersRequest"
  | "onDynamicSessionEvent"
  | "helloConversationV4"
  | "initializeConversationV4"
  | "setConnectionFlowStateV4"
  | "subscribeConversationV4"
  | "unsubscribeConversationV4"
  | "resyncConversationV4"
> {
  const {
    automationTaskIndexRepo,
    ensureAccountProviderConfigSynced,
    getClient,
    getProviderRuntimeHeadersWorkspaceEmitter,
    getReadOnlyClient,
    getSessionEmitter,
    normalizeSessionEventSeq,
    options,
    pendingProviderRuntimeHeaders,
    pendingSessionRuntimePreferences,
    processManager,
    providerRuntimeHeadersCancelledEmitters,
    rememberV4SubscriptionRoute,
    resolveAccountRequestAuth,
    resolveV4Connection,
    resyncV4Route,
    sessionRuntimePreferencesRequestEmitter,
    takePendingSessionRuntimePreferences,
    unsubscribeV4Route,
    v4ConnectionId,
  } = ctx;
  return {
    async setModel(params: ZCodeAgentSetModelParams) {
      const startedAt = Date.now();
      const client = await getClient(params);
      logger.info(undefined, "开始请求 ZCode Protocol session/setModel", {
        expectedRevision: params.expectedRevision ?? null,
        persistAsWorkspaceLastUsed: params.persistAsWorkspaceLastUsed ?? null,
        requestedModel: formatModelSelectionForLog(params.model),
        sessionId: params.sessionId,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        const snapshot = await client.request(
          zcodeProtocolMethods.sessionSetModel,
          {
            sessionId: params.sessionId,
            model: params.model,
            expectedRevision: params.expectedRevision,
            persistAsWorkspaceLastUsed: params.persistAsWorkspaceLastUsed,
          },
          zcodeSessionStateSnapshotSchema,
        );
        logger.info(undefined, "ZCode Protocol session/setModel 完成", {
          durationMs: Date.now() - startedAt,
          requestedModel: formatModelSelectionForLog(params.model),
          sessionId: params.sessionId,
          snapshotModel: formatModelSelectionForLog(snapshot.settings.model.current),
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return snapshot;
      } catch (error) {
        logger.warn(undefined, "ZCode Protocol session/setModel 失败", {
          durationMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
          requestedModel: formatModelSelectionForLog(params.model),
          sessionId: params.sessionId,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    async setThoughtLevel(params: ZCodeAgentSetThoughtLevelParams) {
      const client = await getClient(params);
      const snapshot = await client.request(
        zcodeProtocolMethods.sessionSetThoughtLevel,
        {
          sessionId: params.sessionId,
          thoughtLevel: params.thoughtLevel,
          expectedRevision: params.expectedRevision,
          persistAsWorkspaceLastUsed: params.persistAsWorkspaceLastUsed,
        },
        zcodeSessionStateSnapshotSchema,
      );
      return snapshot;
    },

    async setMode(params: ZCodeAgentSetModeParams) {
      const client = await getClient(params);
      return client.request(
        zcodeProtocolMethods.sessionSetMode,
        {
          sessionId: params.sessionId,
          mode: params.mode,
          expectedRevision: params.expectedRevision,
        },
        zcodeSessionStateSnapshotSchema,
      );
    },

    async respondSessionRuntimePreferences(
      params: ZCodeAgentRespondSessionRuntimePreferencesParams,
    ): Promise<void> {
      const pending = takePendingSessionRuntimePreferences(params.requestId);
      if (!pending) {
        logger.warn(undefined, "运行时偏好响应找不到 pending 请求", {
          event: "zcode_agent.runtime_preferences.response_without_pending",
          module: "services.zcode_agent",
          requestId: params.requestId,
        });
        throw new Error(`ZCode session runtime preferences request not found: ${params.requestId}`);
      }
      const responseContext = {
        event: "zcode_agent.runtime_preferences.host_response_received",
        module: "services.zcode_agent",
        requestId: params.requestId,
        scope: pending.request.scope,
        sessionId: pending.request.sessionId,
        workspaceKey: pending.workspaceKey,
      };
      if (params.resolution.status === "failed") {
        logger.warn(undefined, "Host 返回运行时偏好失败", {
          ...responseContext,
          error: params.resolution.message,
        });
        await pending.client.respondError(pending.protocolRequestId, {
          code: -32603,
          message: params.resolution.message,
        });
        return;
      }
      let preferences: ZCodeSessionRuntimePreferencesResult;
      try {
        preferences = zcodeSessionRuntimePreferencesResultSchema.parse(
          params.resolution.preferences,
        );
        // 远端组织态由远端 Host 读取；客户端设置回包不能覆盖本机目录事实。
        if (
          pending.request.scope === "runtime-materialization" &&
          options?.resolveSessionDirectories
        ) {
          preferences.additionalDirectories = await options.resolveSessionDirectories({
            ...pending.workspace,
            sessionId: pending.request.sessionId,
          });
        }
      } catch (error) {
        logger.warn(undefined, "Host 返回运行时偏好格式非法", {
          ...responseContext,
          error: error instanceof Error ? error.message : String(error),
        });
        await pending.client.respondError(pending.protocolRequestId, {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      // 发送失败表示 transport 已关闭，不能误判为偏好校验失败并发送第二个响应。
      await pending.client.respond(pending.protocolRequestId, preferences);
      logger.info(undefined, "运行时偏好响应已回传 Agent", responseContext);
    },

    onDynamicWorkspaceProviderRuntimeHeadersCancelled(params: ZCodeAgentWorkspaceTarget) {
      const key = resolveWorkspaceKey(params);
      let emitter = providerRuntimeHeadersCancelledEmitters.get(key);
      if (!emitter) {
        emitter = new Emitter<ZCodeProviderRuntimeHeadersCancelled>();
        providerRuntimeHeadersCancelledEmitters.set(key, emitter);
      }
      return emitter.event;
    },

    onDynamicSessionRuntimePreferencesRequest() {
      return (listener) => {
        const disposable = sessionRuntimePreferencesRequestEmitter.event(listener);
        for (const pending of pendingSessionRuntimePreferences.values()) {
          listener(pending.request);
        }
        return disposable;
      };
    },

    async respondProviderRuntimeHeaders(
      params: ZCodeAgentRespondProviderRuntimeHeadersParams,
    ): Promise<void> {
      const key = providerRuntimeHeadersRequestKey(params);
      const pending = pendingProviderRuntimeHeaders.get(key);
      if (!pending) {
        throw new Error(`ZCode provider runtime headers request not found: ${params.requestId}`);
      }
      if (pending.responding) {
        throw new Error(
          `ZCode provider runtime headers response already pending: ${params.requestId}`,
        );
      }
      // 不能在等待账号 IO 前删除 pending，否则新合入的取消通知找不到请求；
      // 保留身份直到解析完成，同时避免 workspace/session 两个消费者重复应答。
      pending.responding = true;
      if (!params.response.headersApplied) {
        pendingProviderRuntimeHeaders.delete(key);
        await pending.client.respond(pending.protocolRequestId, {
          headersApplied: false,
          ...(params.response.errorMessage ? { errorMessage: params.response.errorMessage } : {}),
        });
        return;
      }
      let accountRequestAuth: AccountRequestAuthMaterial | undefined;
      try {
        accountRequestAuth = await resolveAccountRequestAuth(pending.request);
      } catch (error) {
        if (pendingProviderRuntimeHeaders.get(key) !== pending) return;
        pendingProviderRuntimeHeaders.delete(key);
        logger.warn(undefined, "ZCode provider runtime headers 应用失败", {
          modelId: pending.request.modelSelection.modelId,
          providerId: pending.request.providerId,
          requestId: pending.request.requestId,
          sessionId: pending.request.sessionId,
          error: error instanceof Error ? error.message : String(error),
          workspaceKey: resolveWorkspaceKey(pending.request.workspace),
        });
        await pending.client.respond(pending.protocolRequestId, {
          headersApplied: false,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (pendingProviderRuntimeHeaders.get(key) !== pending) return;
      pendingProviderRuntimeHeaders.delete(key);
      const requestHeaders = {
        ...accountRequestAuth?.headers,
      };
      Object.assign(
        requestHeaders,
        allowRequestVerificationHeaders(params.response.runtimeProviderHeaders ?? {}),
      );
      const requestAuth =
        accountRequestAuth?.apiKey || Object.keys(requestHeaders).length > 0
          ? {
              ...(accountRequestAuth?.apiKey ? { apiKey: accountRequestAuth.apiKey } : {}),
              ...(accountRequestAuth?.apiKeyId ? { apiKeyId: accountRequestAuth.apiKeyId } : {}),
              ...(accountRequestAuth?.accountScope
                ? { accountScope: accountRequestAuth.accountScope }
                : {}),
              ...(Object.keys(requestHeaders).length > 0 ? { headers: requestHeaders } : {}),
            }
          : undefined;
      await pending.client.respond(
        pending.protocolRequestId,
        requestAuth
          ? { headersApplied: true, requestAuth }
          : {
              headersApplied: false,
              errorMessage: "Provider request auth is missing",
            },
      );
      const logContext = {
        modelId: pending.request.modelSelection.modelId,
        providerId: pending.request.providerId,
        requestId: pending.request.requestId,
        sessionId: pending.request.sessionId,
        ...(params.response.errorMessage ? { error: params.response.errorMessage } : {}),
        workspaceKey: resolveWorkspaceKey(pending.request.workspace),
      };
      if (requestAuth) {
        logger.info(undefined, "ZCode provider runtime headers 已应用", logContext);
      } else {
        logger.warn(undefined, "ZCode provider runtime headers 应用失败", logContext);
      }
    },

    onDynamicProviderRuntimeHeadersRequest(params: ZCodeAgentSessionTarget) {
      const emitter = getSessionEmitter(params);
      return (listener) => {
        const disposable = emitter.event((event) => {
          if (event.type !== "providerRuntimeHeaders.request") {
            return;
          }
          listener(event.request);
        });
        // Bug 原因：draft 首发会先启动 turn，再把新 sessionId 绑定到 React pane；
        // provider runtime headers 请求可能早于 pane 的 live 订阅，旧实现只 fire event，
        // 导致请求虽留在 pending map，请求校验消费者却永远收不到，真实模型请求无法发出。
        // 必须先注册 live listener，再补投递当前 session 的 pending 请求，封住前后两个窗口。
        const pendingSessionPrefix = `${sessionEventKey(params)}\u0000`;
        for (const [key, pending] of pendingProviderRuntimeHeaders) {
          if (key.startsWith(pendingSessionPrefix)) {
            listener(pending.request);
          }
        }
        return disposable;
      };
    },

    onDynamicWorkspaceProviderRuntimeHeadersRequest(params: ZCodeAgentWorkspaceTarget) {
      const emitter = getProviderRuntimeHeadersWorkspaceEmitter(params);
      return (listener) => {
        const disposable = emitter.event((request) => {
          listener(request);
        });
        // Bug 原因（2026-08-16 web 远控卡死）：session 级入口要求订阅方知道 sessionId，
        // 而 web 远控新建的会话在桌面没有任何 pane，桌面侧无人订阅，headers 请求
        // 永远滞留 pending。workspace 级订阅与 session 级同语义：先注册 live listener，
        // 再按 workspaceKey 前缀补投 pending，封住请求先于订阅到达的窗口；
        // 隔离按 workspaceKey（identity 优先），禁止把远程同路径 workspace 的请求互投。
        const pendingWorkspacePrefix = `${resolveWorkspaceKey(params)}\u0000`;
        for (const [key, pending] of pendingProviderRuntimeHeaders) {
          if (key.startsWith(pendingWorkspacePrefix)) {
            listener(pending.request);
          }
        }
        return disposable;
      };
    },

    onDynamicSessionEvent(params: ZCodeAgentSessionSubscribeParams) {
      const emitter = getSessionEmitter(params);
      return (listener) => {
        // cancelled / retryTimer 的作用域是单个订阅者：调用方 dispose 时取消自己的重试，
        // 不影响共享 emitter 上的其他订阅者。
        let cancelled = false;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        let subscriptionReady = false;
        const pendingLiveEvents: ZCodeAgentServiceEvent[] = [];
        const deliveredEventIds = new Set<string>();
        const deliveredEventIdOrder: string[] = [];
        const eventCoalescer =
          params.eventCoalescing?.mode === "background-summary"
            ? createBackgroundSessionEventCoalescer({
                emit: listener,
                flushDelayMs: params.eventCoalescing.intervalMs,
              })
            : null;

        const deliverToListener = (event: ZCodeAgentServiceEvent): void => {
          if (cancelled) {
            return;
          }
          if (event.type === "session.event") {
            const firstDelivery = rememberBoundedEventId(
              deliveredEventIds,
              deliveredEventIdOrder,
              event.event.eventId,
            );
            if (!firstDelivery) {
              return;
            }
          }
          // 性能优化：后台 task 只需要低频摘要，不能让不可见任务的 token/progress
          // 同频唤醒 renderer；active 订阅没有 eventCoalescing，仍保持实时 continuous。
          if (eventCoalescer) {
            eventCoalescer.accept(event);
            return;
          }
          listener(event);
        };

        const releaseBufferedLiveEvents = (): void => {
          if (subscriptionReady) {
            return;
          }
          subscriptionReady = true;
          const bufferedEvents = pendingLiveEvents.splice(0);
          for (const event of bufferedEvents) {
            deliverToListener(event);
          }
        };

        const subscription = emitter.event((event) => {
          if (cancelled) {
            return;
          }
          if (!subscriptionReady) {
            pendingLiveEvents.push(event);
            return;
          }
          deliverToListener(event);
        });

        const establishSubscription = async (attempt: number): Promise<void> => {
          if (cancelled) {
            return;
          }
          try {
            const client = await getReadOnlyClient(params);
            if (cancelled) {
              return;
            }
            const result = await client.request(
              zcodeProtocolMethods.sessionSubscribe,
              {
                sessionId: params.sessionId,
                deliveryKind: params.deliveryKind,
                afterSeq: params.afterSeq,
                includeSnapshot: params.includeSnapshot ?? false,
              },
              zcodeSessionSubscribeResultSchema,
            );
            if (cancelled) {
              return;
            }
            const replayEvents = result.events
              .map((event) => normalizeSessionEventSeq(params, event))
              .sort((left, right) => left.seq - right.seq || left.timestamp - right.timestamp);
            // session/subscribe 返回的是当前订阅者自己的 replay 缺口。
            // replay 不能 fire 到共享 emitter：会把历史事件重新广播给其他 live 订阅者，
            // 造成 UI 时间线里已完成工具被插回到当前模型输出之后。
            for (const event of replayEvents) {
              deliverToListener({ type: "session.event", event });
            }
            if (result.snapshot) {
              deliverToListener({
                type: "snapshot",
                snapshot: result.snapshot,
              });
            }
            releaseBufferedLiveEvents();
          } catch (error) {
            if (cancelled) {
              return;
            }
            if (attempt >= SESSION_SUBSCRIBE_MAX_ATTEMPTS - 1) {
              // 彻底失败时打 warn 让问题可观测，而不是无声失效。
              console.warn(
                formatLogPrefix("zcode-agent", process.pid),
                "session 订阅建立失败，已达最大重试次数，放弃",
                {
                  sessionId: params.sessionId,
                  workspaceKey: resolveWorkspaceKey(params),
                  attempts: attempt + 1,
                  message: error instanceof Error ? error.message : String(error),
                },
              );
              // 订阅失败后不再无限压住 live 事件；此时没有 replay 权威补洞，只能恢复 continuous 流。
              releaseBufferedLiveEvents();
              return;
            }
            const delay = Math.min(
              SESSION_SUBSCRIBE_RETRY_BASE_DELAY_MS * 2 ** attempt,
              SESSION_SUBSCRIBE_RETRY_MAX_DELAY_MS,
            );
            retryTimer = setTimeout(() => {
              retryTimer = undefined;
              void establishSubscription(attempt + 1);
            }, delay);
          }
        };

        void establishSubscription(0);

        return {
          dispose() {
            cancelled = true;
            if (retryTimer) {
              clearTimeout(retryTimer);
              retryTimer = undefined;
            }
            pendingLiveEvents.length = 0;
            eventCoalescer?.dispose();
            subscription.dispose();
          },
        };
      };
    },

    // ── v4 conversation 通道（竖切）：host 只做透传，不落任何业务状态 ──

    async helloConversationV4() {
      return {
        kind: "hello" as const,
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
        connectionId: v4ConnectionId,
        clientMode: "desktop-continuous" as const,
        deliveryProfile: "continuous" as const,
        serverTime: Date.now(),
        capabilities: {
          nativeDialogs: true,
          localTerminal: true,
          binaryFrames: false,
          compression: "none" as const,
          workspaceHookReview: true,
          independentPlanState: true,
          // 与 connection scope 的 hello 同一份能力集：直连 base service 的宿主内部消费者
          // 也能收到 `workflowRun.*` 增量（是否真收由它自己的 clientHello 决定）。
          workflowRunDeltas: true,
          historyFirst: true,
        },
        auth: {},
      };
    },

    async initializeConversationV4(rawClientHello) {
      clientHelloSchema.parse(rawClientHello);
    },

    async setConnectionFlowStateV4(params: ZCodeAgentConnectionFlowParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.connection.flowControlUntrusted");
      const client = await getReadOnlyClient(params);
      await client.request(
        V4_METHODS.connectionFlow,
        { connectionId: trusted.connectionId, state: params.state },
        v4ConnectionFlowResultSchema,
      );
    },

    async subscribeConversationV4(params: ZCodeAgentConversationSubscribeParams) {
      const subscribeStartedAt = performance.now();
      const existingClient = processManager.getExistingClient(params);
      const cliProcessState: "reused" | "spawned" =
        existingClient && !existingClient.isDisposed ? "reused" : "spawned";
      const cliBootstrapStartedAt = performance.now();
      // 历史 topic 是任务列表点击后的只读事实源。provider/model 未配置时若复用
      // 模型执行门禁，列表虽然能出现但点击后仍无法打开；订阅只启动 CLI，不提升写能力。
      const client = await getReadOnlyClient(params);
      const cliBootstrapMs =
        cliProcessState === "spawned"
          ? Math.max(0, Math.round(performance.now() - cliBootstrapStartedAt))
          : undefined;
      // conversation 冷订阅会在 CLI 内部直接恢复历史 Session 并立即发布首帧。
      // 若 Account Config 尚未到达，首帧会先按缺少 Account Overlay 的 Registry 解析；这里只建立
      // Account Config 顺序屏障，不提升模型执行权限。ZCode Built-in / Personal 仍由 Worker 维护。
      const providerRegistryStartedAt = performance.now();
      await ensureAccountProviderConfigSynced({
        client,
        reason: "conversation_subscribe",
        workspace: params,
        refreshRegistry: true,
      });
      const providerRegistrySyncMs = Math.max(
        0,
        Math.round(performance.now() - providerRegistryStartedAt),
      );
      const connection = resolveV4Connection(params);
      const historyFirst = connection.historyFirst === true && (await supportsHistoryFirst(client));
      const topic = conversationTopic(params.sessionId);
      const taskMetaStartedAt = performance.now();
      const resumeThoughtLevel = await automationTaskIndexRepo
        .getTaskMeta({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          taskId: params.sessionId,
        })
        .then((meta) => meta?.thoughtLevel?.trim() || undefined)
        .catch((error) => {
          // desktop-continuous 的 V4 冷订阅绕过 task adapter，旧 session 没有
          // Agent durable selection 时也就丢了 task-local thought。索引读取失败仍允许只读恢复。
          logger.warn(undefined, "读取 V4 cold resume thought hint 失败，继续无 hint 订阅", {
            error: error instanceof Error ? error.message : String(error),
            event: "v4.conversation.subscribe.resume_thought_hint_failed",
            sessionId: params.sessionId,
            workspaceIdentity: params.workspaceIdentity ?? null,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          return undefined;
        });
      let directorySessionId = params.sessionId;
      if (options?.resolveSessionDirectories) {
        // 子会话按设计不进主任务索引；直接查 child 的项目会被远端必选项目校验拒绝。
        // 旧 child 索引也不能证明主任务身份；只信 Agent 持久化父链，再执行原项目校验。
        const visited = new Set<string>();
        while (true) {
          if (visited.has(directorySessionId)) throw new Error("project.session-lineage-invalid");
          visited.add(directorySessionId);
          const { sessions } = await client.request(
            zcodeProtocolMethods.sessionList,
            {
              workspace: buildWorkspaceRef(params),
              sessionIds: [directorySessionId],
            },
            zcodeSessionListResultSchema,
          );
          const session = sessions.find((entry) => entry.sessionId === directorySessionId);
          if (!session) {
            if (directorySessionId !== params.sessionId)
              throw new Error("project.session-lineage-invalid");
            break;
          }
          if (
            resolveWorkspaceKey(session.workspace) !== resolveWorkspaceKey(params) ||
            session.workspace.workspacePath !== params.workspacePath
          )
            throw new Error("project.session-lineage-invalid");
          if (!isAuxiliarySessionKind(session.sessionKind)) break;
          if (!session.parentSessionId) throw new Error("project.session-lineage-invalid");
          directorySessionId = session.parentSessionId;
        }
      }
      const additionalDirectories = await options?.resolveSessionDirectories?.({
        ...params,
        sessionId: directorySessionId,
      });
      const taskMetaReadMs = Math.max(0, Math.round(performance.now() - taskMetaStartedAt));
      const cliRequestStartedAt = performance.now();
      const result = await client.request(
        V4_METHODS.conversationSubscribe,
        {
          topic,
          connectionId: connection.connectionId,
          clientMode: connection.clientMode,
          // 与 clientMode 同族的可信位（10 §3.1）：只由这里从连接的 clientHello 注入。
          // 缺席即 CLI 按旧消费者发整键 patch，并先裁到旧界——重订阅、recovery、手机
          // relay attachment 都走这一条 subscribe，所以这一处写全即可。
          ...(connection.workflowRunDeltas === true ? { workflowRunDeltas: true } : {}),
          ...(historyFirst
            ? {
                historyFirst: true,
                ...(params.retryInitialization
                  ? { retryInitialization: params.retryInitialization }
                  : {}),
              }
            : {}),
          // Bug 根因：冷订阅过去只传 sessionId，CLI 只能从历史 session.path 反推
          // workspace 身份；该路径已可能被 path.resolve 改写。当前 attachment 才是权威来源。
          workspace: buildWorkspaceRef(params),
          ...(resumeThoughtLevel ? { resumeThoughtLevel } : {}),
          ...(additionalDirectories !== undefined ? { additionalDirectories } : {}),
          ...(params.base ? { base: params.base } : {}),
          ...(params.visibility ? { visibility: params.visibility } : {}),
        },
        v4ConversationSubscribeResultSchema,
      );
      const cliRequestMs = Math.max(0, Math.round(performance.now() - cliRequestStartedAt));
      const hostPrepareMs = Math.max(0, Math.round(cliRequestStartedAt - subscribeStartedAt));
      const openTiming = {
        ...(result.ack.openTiming ? result.ack.openTiming : {}),
        version: 1 as const,
        hostPrepareMs,
        ...(cliBootstrapMs !== undefined ? { cliBootstrapMs } : {}),
        cliProcessState,
        providerRegistrySyncMs,
        taskMetaReadMs,
        cliRequestMs,
      };
      rememberV4SubscriptionRoute(
        params,
        topic,
        result.ack.subscriptionId,
        connection.connectionId,
      );
      return {
        ...result,
        ack: {
          ...result.ack,
          openTiming,
        },
      };
    },

    async unsubscribeConversationV4(params: ZCodeAgentConversationUnsubscribeParams) {
      await unsubscribeV4Route(params, "conversation/");
    },

    async resyncConversationV4(params: ZCodeAgentConversationResyncParams) {
      return resyncV4Route(params, "conversation/");
    },
  };
}

/**
 * Host-обработчик доверенного reverse RPC `uncensored/getConfig` (CLI → Host).
 * Параметры проверяются strict-схемой; секрет читает только store непосредственно
 * при сборке ответа. В логи попадают workspace key и факт наличия ключа, никогда
 * само значение.
 */
export function handleUncensoredGetConfigRequest(
  ctx: { options?: CreateZCodeAgentServiceOptions },
  client: ZCodeProtocolClient,
  workspace: ZCodeAgentWorkspaceTarget,
  request: ZCodeProtocolRequest,
): void {
  void (async () => {
    const parsed = zcodeUncensoredGetConfigParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      await client.respondError(request.id, {
        code: -32602,
        message: "Invalid uncensored/getConfig params",
      });
      return;
    }
    const store = ctx.options?.uncensoredSettingsStore;
    if (!store) {
      await client.respondError(request.id, {
        code: -32603,
        message: "Uncensored settings are unavailable on this Host",
      });
      return;
    }
    const workspaceKey = resolveWorkspaceKey(workspace);
    try {
      const result = zcodeUncensoredGetConfigResultSchema.parse(
        await store.readTakeoverConfig({
          workspacePath: workspace.workspacePath,
          ...(workspace.workspaceIdentity
            ? { workspaceIdentity: workspace.workspaceIdentity }
            : {}),
        }),
      );
      await client.respond(request.id, result);
      logger.info(undefined, "uncensored/getConfig served", {
        providerCount: result.providers.length,
        modelCount: result.providers.reduce(
          (total, provider) => total + provider.models.length,
          0,
        ),
        configuredKeyCount: result.providers.filter((provider) => provider.apiKey !== null).length,
        workspaceKey,
      });
    } catch (error) {
      logger.warn(undefined, "uncensored/getConfig failed", {
        reason: error instanceof Error ? error.message : String(error),
        workspaceKey,
      });
      await client.respondError(request.id, {
        code: -32603,
        message: "Uncensored settings are unavailable on this Host",
      });
    }
  })().catch(() => undefined);
}
