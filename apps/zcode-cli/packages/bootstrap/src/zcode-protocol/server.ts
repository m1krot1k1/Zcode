import { createNodeNetworkCapture } from "@zcode/shared/node";
import { zcodeProtocolNotifications } from "@zcode/shared";
import type { BrowserControlPort } from "@zcode/contracts";
import type {
  McpElicitationRequest,
  McpElicitationResult,
  McpServerNotification,
} from "@zcode/contracts";
import { createInMemorySessionEventStore } from "@zcode/contracts";
import { requestMcpElicitation } from "./interaction-broker.js";
import { InMemoryWorkspaceHookPolicyProvider } from "@zcode/core";
import { parseConversationTopic } from "@zcode/shared/zcode-protocol-v4";
import type {
  ZCodeProtocolError,
  ZCodeProtocolMessage,
  ZCodeProtocolMethod,
  ZCodeProtocolRequest,
  ZCodeProtocolRequestId,
  ZCodeProtocolResponse,
} from "@zcode/shared";
import { ProtocolRuntimeResources } from "./runtime-resources.js";
import { routeMcpServerNotification } from "./mcp-ui/index.js";
import {
  V4InteractionRegistry,
  resolveV4InteractionRegistryOptionsFromEnv,
} from "../zcode-protocol-v4/interaction-registry.js";
import { createConversationV4Gateway } from "./v4-bridge.js";
import { createSessionResidentPoolHost } from "./session-residency.js";
import {
  DEFAULT_SESSION_RESIDENT_HIGH_WATER_COUNT,
  SessionResidentPool,
} from "./session-resident-pool.js";
import { createProtocolBrowserControlBroker } from "./browser-control-broker.js";
import {
  createProtocolLogger,
  PROTOCOL_CLIENT_REQUEST_ERROR_CODES,
  ProtocolRequestError,
  type ParamsSchema,
  toProtocolError,
  type PendingClientRequest,
  type ZCodeProtocolAgentDependencies,
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolClientRequestOptions,
  type ZCodeProtocolOutboundMessage,
  type ZCodeProtocolPostResponseBatch,
  type ZCodeProtocolSessionRecord,
} from "./server-types.js";
import { dispatchProtocolRequest, type ProtocolDispatchHost } from "./server-dispatch.js";
import {
  collectProtocolMemoryDiagnostics,
  disconnectProtocolClient,
  disposeProtocolProjections,
  handleProtocolMessage,
  pruneProtocolDetachedChildPublishers,
  pruneProtocolSessionEventStores,
  type ProtocolMessageHost,
} from "./server-lifecycle.js";
import {
  abortRemainingOperations,
  createPluginOperationRegistries,
  type PluginOperationRegistries,
} from "./server-plugin-ops.js";

export { notifyWorkspaceHookTrustGrantSessions } from "./workspace-hook-trust.js";

const MAX_CLIENT_REQUEST_REANNOUNCE_INTERVAL_MS = 10_000;

function collectResidencySessionIds(params: unknown): string[] {
  if (!params || typeof params !== "object") return [];
  const candidate = params as {
    commands?: unknown;
    sessionId?: unknown;
    topic?: unknown;
  };
  const sessionIds = new Set<string>();
  if (typeof candidate.sessionId === "string" && candidate.sessionId.length > 0) {
    sessionIds.add(candidate.sessionId);
  }
  if (typeof candidate.topic === "string") {
    const topicSessionId = parseConversationTopic(candidate.topic);
    if (topicSessionId) sessionIds.add(topicSessionId);
  }
  if (Array.isArray(candidate.commands)) {
    for (const command of candidate.commands) {
      if (!command || typeof command !== "object") continue;
      const sessionId = (command as { sessionId?: unknown }).sessionId;
      if (typeof sessionId === "string" && sessionId.length > 0) {
        sessionIds.add(sessionId);
      }
    }
  }
  return [...sessionIds];
}

export class ZCodeProtocolAgentServer {
  private readonly networkCapture = createNodeNetworkCapture("cli", (batch) => {
    this.messageSink?.({
      method: zcodeProtocolNotifications.processNetworkRequests,
      params: batch,
    });
  });
  private readonly runtimeResources: ProtocolRuntimeResources;
  private shutdownPromise?: Promise<void>;
  readonly browserControlPort: BrowserControlPort;
  /**
   * 官方 MCP 身份头端口所需的最小上下文。
   * MCP 连接池的构造早于 server，需要在 server 就绪后回填闭包持有的引用——
   * 与 v4Gateway 同样的构造顺序收口方式。只暴露 requestClient，不外泄整个 context。
   */
  /** MCP server 发起的 elicitation/create → 用户提问。 */
  requestMcpElicitation(
    request: McpElicitationRequest,
    options?: { signal?: AbortSignal },
  ): Promise<McpElicitationResult> {
    return requestMcpElicitation(this.context, request, options);
  }

  /** MCP server 通知 → 会话 live 事件 / agent 日志。 */
  handleMcpNotification(notification: McpServerNotification): void {
    routeMcpServerNotification(this.context, notification);
  }

  get officialMcpAuthRequestContext(): Pick<ZCodeProtocolAgentServerContext, "requestClient"> {
    return this.context;
  }

  private messageSink?: (message: ZCodeProtocolOutboundMessage) => void;
  private clientDisconnectError?: Error;
  private readonly context: ZCodeProtocolAgentServerContext;
  private readonly logger;
  /** 插件操作与 workspace/generateText 的取消注册表；取消命令按 operationId 精确命中。 */
  private readonly operations: PluginOperationRegistries = createPluginOperationRegistries();
  private readonly pendingClientRequests = new Map<string, PendingClientRequest<unknown>>();
  /**
   * subscribe initial frame 按 JSON-RPC request id 隔离。connection 必须先 take，
   * 再写 response line，最后按数组顺序写 notification，不能靠 microtask 猜时序。
   */
  private readonly postResponseOutbox = new Map<
    ZCodeProtocolRequestId,
    ZCodeProtocolPostResponseBatch
  >();
  private readonly dispatchHost: ProtocolDispatchHost;
  private readonly messageHost: ProtocolMessageHost;
  private nextClientRequestId = 1;

  constructor(deps: ZCodeProtocolAgentDependencies) {
    this.runtimeResources = new ProtocolRuntimeResources(deps.createZCodeApp);
    const resolvedDeps = {
      ...deps,
      createZCodeApp: this.runtimeResources.create,
      // 默认 turn 窗口保留策略。
      createSessionEventStore:
        deps.createSessionEventStore ?? (() => createInMemorySessionEventStore()),
      workspaceHookPolicyProvider:
        deps.workspaceHookPolicyProvider ?? new InMemoryWorkspaceHookPolicyProvider(),
    };
    this.logger = createProtocolLogger(resolvedDeps);
    this.context = {
      assertServing: () => this.runtimeResources.assertServing(),
      deps: resolvedDeps,
      logger: this.logger,
      appRuntimePreferences: {
        askUserQuestionAutoResolutionEnabled: true,
        modelIoFullRetentionEnabled: false,
        offPeakToolEnabled: false,
        // 动态工作流灰度门 fail-closed：Host 必须显式 workspace/updateDynamicWorkflowPolicy
        // 才开启。
        dynamicWorkflowEnabled: false,
      },
      notify: (notification) => this.messageSink?.(notification),
      requestClient: (method, params, resultSchema, options) =>
        this.requestClient(method, params, resultSchema, options),
      sessions: new Map<string, ZCodeProtocolSessionRecord>(),
      // 交互应答登记表（broker 反向请求 × v4 resolveInteraction 命令的汇合点）。
      v4Interactions: new V4InteractionRegistry(
        resolveV4InteractionRegistryOptionsFromEnv(deps.env ?? process.env),
      ),
    };
    // v4 通道：gateway 闭包持有 context 做帧出口与命令副作用，构造完立即挂回。
    this.context.v4Gateway = createConversationV4Gateway(this.context);
    this.browserControlPort = createProtocolBrowserControlBroker(this.context);
    const sessionResidentTargetCount =
      deps.sessionResidentPoolOptions?.targetCount ?? deps.sessionResidentTargetCount;
    const sessionResidentHighWaterCount =
      deps.sessionResidentPoolOptions?.highWaterCount ??
      (sessionResidentTargetCount === undefined
        ? undefined
        : Math.max(DEFAULT_SESSION_RESIDENT_HIGH_WATER_COUNT, sessionResidentTargetCount));
    // 单 CLI resident session 池：协议 request release 主动收敛，资源 sampler 只作兜底。
    this.context.sessionResidentPool = new SessionResidentPool(
      createSessionResidentPoolHost(this.context),
      {
        ...deps.sessionResidentPoolOptions,
        // legacy target 曾同时覆盖 high/low，导致迟滞窗口塌为 0；只覆盖 low。
        // 仅配置 target 且超过默认 high 时抬升隐式 high，显式非法组合仍由 pool 拒绝。
        highWaterCount: sessionResidentHighWaterCount,
        targetCount: sessionResidentTargetCount,
      },
    );
    this.dispatchHost = {
      context: this.context,
      operations: this.operations,
      postResponseOutbox: this.postResponseOutbox,
      requireV4Gateway: () => this.requireV4Gateway(),
    };
    this.messageHost = {
      assertServing: () => this.runtimeResources.assertServing(),
      context: this.context,
      logger: this.logger,
      networkCapture: this.networkCapture,
      handleRequest: (request) => this.handleRequest(request),
      rejectClientRequest: (id, error) => this.rejectClientRequest(id, error),
      resolveClientRequest: (id, result) => this.resolveClientRequest(id, result),
    };
  }

  /** 低频 sampler 兜底入口；正常收敛由每个协议 request 的 operation lease 释放触发。 */
  rebalanceResidentSessions(): void {
    this.context.sessionResidentPool?.rebalance();
  }

  /**
   * 借同一 60s 节拍做 event store 的时间兜底淘汰：
   * subagent 子 session 只有一个 turn，等不到下一个 turn_started，只能按时间清。返回淘汰条数。
   */
  pruneSessionEventStores(nowMs: number = Date.now()): number {
    return pruneProtocolSessionEventStores(this.context, nowMs);
  }

  /** 同一 60s 节拍：释放已终态、无订阅者、无 record 的 detached subagent child publisher。 */
  pruneDetachedChildPublishers(nowMs: number = Date.now()): number {
    return pruneProtocolDetachedChildPublishers(this.context, nowMs);
  }

  /**
   * 内存诊断计数器，随 60s 资源采样写本地日志。
   * 只读 Map.size / 数组长度，不触碰 session 状态；持久化 event store 不提供 getStats 时计 0。
   */
  collectMemoryDiagnostics(): Record<string, number> {
    return collectProtocolMemoryDiagnostics(this.context);
  }

  setNotificationSink(sink: (message: ZCodeProtocolOutboundMessage) => void): void {
    this.runtimeResources.assertServing();
    this.clientDisconnectError = undefined;
    this.messageSink = sink;
  }

  disconnectClient(error: Error): void {
    this.clientDisconnectError = error;
    disconnectProtocolClient(
      {
        context: this.context,
        logger: this.logger,
        networkCapture: this.networkCapture,
        pendingClientRequests: this.pendingClientRequests,
        operations: this.operations,
        cleanupClientRequest: (pending) => this.cleanupClientRequest(pending),
      },
      error,
    );
  }

  /** 进程资源关闭，不使用会删除产品会话/发布 session.removed 的 session/close。 */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.runtimeResources.close();
    const error = new Error("ZCode Protocol runtime stopping");
    this.disconnectClient(error);
    this.messageSink = undefined;
    this.clearPostResponseMessages();
    abortRemainingOperations(this.operations, error);
    for (const record of this.context.sessions.values()) {
      record.activeAbortController?.abort(error);
      try {
        record.unsubscribe?.();
      } catch {
        this.logger?.warn("Session unsubscribe failed during protocol shutdown", {
          event: "zcode_protocol.session.unsubscribe.failed",
        });
      }
    }
    return this.shutdownPromise;
  }

  /** app drain 有界结束后释放投影；即使某个 app.close 挂起也必须执行。 */
  disposeProjections(): void {
    disposeProtocolProjections(this.context);
  }

  /** 一次性取走某 request 的 post-response messages；重复 take 返回空数组。 */
  takePostResponseMessages(requestId: ZCodeProtocolRequestId): ZCodeProtocolOutboundMessage[] {
    const batch = this.takePostResponseBatch(requestId);
    batch?.commit();
    return [...(batch?.messages ?? [])];
  }

  /** production NDJSON 取完整 batch；只有全部 write 成功后才调 commit。 */
  takePostResponseBatch(requestId: ZCodeProtocolRequestId): ZCodeProtocolPostResponseBatch | null {
    const batch = this.postResponseOutbox.get(requestId) ?? null;
    this.postResponseOutbox.delete(requestId);
    return batch;
  }

  /** connection close / server dispose 时释放尚未写出的 initial frame 引用。 */
  clearPostResponseMessages(): void {
    this.postResponseOutbox.clear();
  }

  async handleMessage(
    message: ZCodeProtocolMessage,
  ): Promise<ZCodeProtocolError | ZCodeProtocolResponse | undefined> {
    return await handleProtocolMessage(this.messageHost, message);
  }

  private requireV4Gateway() {
    if (!this.context.v4Gateway) {
      throw new ProtocolRequestError(-32603, "v4 gateway is not initialized");
    }
    return this.context.v4Gateway;
  }

  private async handleRequest(
    request: ZCodeProtocolRequest,
  ): Promise<ZCodeProtocolError | ZCodeProtocolResponse> {
    // request id 可在前一请求完成后复用；新请求不能继承未消费的旧 outbox。
    this.postResponseOutbox.delete(request.id);
    let releaseResidencyOperation: (() => void) | undefined;
    try {
      // subscribe hydration、workspace 配置与 resume 都可能跨 await。若只看
      // session 当前状态，sampler 会在 handler 持有旧 record 时把它关闭。进程级 lease
      // 覆盖整个 request；能识别的 sessionIds 额外用于冷恢复闸门与 LRU touch。
      releaseResidencyOperation = await this.context.sessionResidentPool?.acquireOperation(
        collectResidencySessionIds(request.params),
      );
      const result = await dispatchProtocolRequest(this.dispatchHost, request);
      return this.ok(request.id, result);
    } catch (error) {
      this.postResponseOutbox.delete(request.id);
      const protocolError = toProtocolError(error);
      return this.fail(request.id, protocolError.code, protocolError.message, protocolError.data);
    } finally {
      releaseResidencyOperation?.();
    }
  }

  private ok(id: ZCodeProtocolRequestId, result: unknown): ZCodeProtocolResponse {
    return { id, result };
  }

  private fail(
    id: ZCodeProtocolRequestId,
    code: number,
    message: string,
    data?: unknown,
  ): ZCodeProtocolError {
    return { error: { code, data, message }, id };
  }

  private requestClient<T>(
    method: ZCodeProtocolMethod,
    params: unknown,
    resultSchema: ParamsSchema<T>,
    options?: ZCodeProtocolClientRequestOptions,
  ): Promise<T> {
    if (this.clientDisconnectError) {
      throw this.clientDisconnectError;
    }
    if (!this.messageSink) {
      throw new ProtocolRequestError(
        PROTOCOL_CLIENT_REQUEST_ERROR_CODES.noClientAttached,
        `No ZCode Protocol client is attached for ${method}`,
      );
    }

    return new Promise<T>((resolve, reject) => {
      let active = true;
      const pending: PendingClientRequest<T> = {
        method,
        reject,
        resolve,
        resultSchema,
        requestKeys: new Set(),
        signal: options?.signal,
      };
      const cleanup = () => {
        active = false;
        this.cleanupClientRequest(pending);
      };
      pending.abortHandler = () => {
        cleanup();
        reject(
          new ProtocolRequestError(
            PROTOCOL_CLIENT_REQUEST_ERROR_CODES.cancelled,
            `Client request cancelled: ${method}`,
          ),
        );
      };
      if (options?.signal?.aborted) {
        pending.abortHandler();
        return;
      }
      if (options?.timeoutMs !== undefined) {
        pending.timeout = setTimeout(() => {
          cleanup();
          reject(
            new ProtocolRequestError(
              PROTOCOL_CLIENT_REQUEST_ERROR_CODES.timedOut,
              `Client request timed out: ${method}`,
              {
              timeoutMs: options.timeoutMs,
              },
            ),
          );
        }, options.timeoutMs);
      }
      options?.signal?.addEventListener("abort", pending.abortHandler, { once: true });
      const sendClientRequest = () => {
        if (!active) {
          return;
        }
        const id = `server-${this.nextClientRequestId++}`;
        const key = String(id);
        pending.requestKeys.add(key);
        this.pendingClientRequests.set(key, pending as PendingClientRequest<unknown>);
        this.messageSink?.({
          id,
          method,
          params,
          ...(options?.trace ? { trace: options.trace } : {}),
        });
      };
      sendClientRequest();
      const reannounceIntervalMs =
        options?.reannounceIntervalMs !== undefined &&
        Number.isFinite(options.reannounceIntervalMs) &&
        options.reannounceIntervalMs > 0
          ? Math.floor(options.reannounceIntervalMs)
          : undefined;
      if (reannounceIntervalMs !== undefined) {
        let nextReannounceIntervalMs = reannounceIntervalMs;
        const scheduleReannounce = () => {
          pending.reannounceTimer = setTimeout(() => {
            if (!active) {
              return;
            }
            sendClientRequest();
            nextReannounceIntervalMs = Math.min(
              nextReannounceIntervalMs * 2,
              MAX_CLIENT_REQUEST_REANNOUNCE_INTERVAL_MS,
            );
            scheduleReannounce();
          }, nextReannounceIntervalMs);
        };
        scheduleReannounce();
      }
    });
  }

  private resolveClientRequest(id: ZCodeProtocolRequestId, result: unknown): void {
    const key = String(id);
    const pending = this.pendingClientRequests.get(key);
    if (!pending) {
      return;
    }
    this.cleanupClientRequest(pending);
    try {
      pending.resolve(pending.resultSchema.parse(result));
    } catch (error) {
      pending.reject(
        error instanceof Error ? error : new Error(`Invalid response: ${pending.method}`),
      );
    }
  }

  private rejectClientRequest(id: ZCodeProtocolRequestId, error: Error): void {
    const key = String(id);
    const pending = this.pendingClientRequests.get(key);
    if (!pending) {
      return;
    }
    this.cleanupClientRequest(pending);
    pending.reject(error);
  }

  private cleanupClientRequest<T>(pending: PendingClientRequest<T>): void {
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    if (pending.reannounceTimer) {
      clearTimeout(pending.reannounceTimer);
    }
    if (pending.abortHandler) {
      pending.signal?.removeEventListener("abort", pending.abortHandler);
    }
    for (const requestKey of pending.requestKeys) {
      this.pendingClientRequests.delete(requestKey);
    }
    pending.requestKeys.clear();
  }
}
