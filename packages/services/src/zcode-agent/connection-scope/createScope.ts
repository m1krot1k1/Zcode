// V4 connection-scoped service facade：每个 RPC attachment 独立持有 subscription
// ownership；base service 仍只转发 CLI 事实，不在 host/main/relay 复制业务状态。
import { Event as RpcEvent } from "@zcode/rpc";
import {
  clientHelloSchema,
  clientSupportsWorkflowRunDeltas,
  conversationTopic,
  sessionsIndexTopic,
  workspaceConfigTopic,
  type ConversationTopicWireCandidate,
  type SessionsIndexTopicWireCandidate,
  type V4ConnectionFlowState,
  type WorkspaceConfigTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  IZCodeAgentService,
  ZCodeAgentConversationResyncParams,
  ZCodeAgentConversationUnsubscribeParams,
  ZCodeAgentRuntimePolicy,
} from "../zcodeAgent.js";
import { createFlowControlRegistry, flowRouteKey } from "./flowControl.js";
import { createOwnershipRegistry } from "./ownership.js";
import {
  assertConnectionId,
  createHello,
  namespaceRelayConnectionId,
  readTrustedZCodeAgentV4Connection,
  readTrustedZCodeAgentV4UnsubscribeRoute,
  withTrustedConnection,
  withTrustedUnsubscribeRoute,
  workspaceKey,
  workspaceTarget,
} from "./trustedConnection.js";
import type {
  OwnedSubscription,
  PendingOwnership,
  ZCodeAgentV4ConnectionContext,
} from "./types.js";

export interface ZCodeAgentConnectionScope {
  readonly service: IZCodeAgentService;
  /** MessagePort/transport sideband only；不是 UI-facing RPC。 */
  setTransportFlowState(state: V4ConnectionFlowState): Promise<void>;
  dispose(): Promise<void>;
}

/** 为单个 host/server RPC attachment 建立可信 V4 facade。 */
export function createZCodeAgentConnectionScope(
  base: IZCodeAgentService,
  context: ZCodeAgentV4ConnectionContext,
): ZCodeAgentConnectionScope {
  assertConnectionId(context.connectionId);
  const role = context.role ?? "terminal-client";
  const ownership = createOwnershipRegistry();
  let disposed = false;
  // trusted relay 已在外层 transport（stdio / Node-only WS role header）完成身份
  // 选择；终端 UI 仍必须走 hello → clientHello。
  let handshakeComplete = role === "trusted-host-relay";
  let helloIssued = role === "trusted-host-relay";
  let boundClientId: string | null = null;
  /** clientHello 里的增量声明；trusted relay 没有自己的 clientHello，只搬运下游的。 */
  let clientWorkflowRunDeltas = false;
  let clientHistoryFirst = false;
  let commandQueryWorkspaceKey: string | null = null;
  const flow = createFlowControlRegistry(base, ownership, () => disposed);

  const forwardedConnection = (params: unknown): ZCodeAgentV4ConnectionContext => {
    const downstream = readTrustedZCodeAgentV4Connection(params);
    if (role === "trusted-host-relay" && downstream) {
      assertConnectionId(downstream.connectionId);
      return {
        connectionId: namespaceRelayConnectionId(context.connectionId, downstream.connectionId),
        clientMode: downstream.clientMode,
        // 增量位属于**下游那一端**：relay 自己不消费帧，只把下游 clientHello 的声明带上去。
        ...(downstream.workflowRunDeltas === true ? { workflowRunDeltas: true } : {}),
        ...(downstream.historyFirst === true ? { historyFirst: true } : {}),
      };
    }
    return {
      connectionId: context.connectionId,
      clientMode: context.clientMode,
      ...(clientWorkflowRunDeltas ? { workflowRunDeltas: true } : {}),
      ...(clientHistoryFirst ? { historyFirst: true } : {}),
    };
  };

  const assertOpen = () => {
    if (disposed) throw new Error("fault.connection.closed");
  };
  const assertReady = () => {
    assertOpen();
    if (!handshakeComplete) throw new Error("fault.connection.handshakeRequired");
  };
  const forwardedUnsubscribeRoute = (
    params: unknown,
  ): ReturnType<typeof readTrustedZCodeAgentV4UnsubscribeRoute> => {
    if (role !== "trusted-host-relay") return null;
    const downstream = readTrustedZCodeAgentV4UnsubscribeRoute(params);
    if (!downstream) return null;
    assertConnectionId(downstream.connectionId);
    return {
      topic: downstream.topic,
      connectionId: namespaceRelayConnectionId(context.connectionId, downstream.connectionId),
    };
  };
  const unsubscribeBase = (
    entry: OwnedSubscription,
    runtimePolicy?: ZCodeAgentRuntimePolicy,
  ): Promise<void> => {
    const params: ZCodeAgentConversationUnsubscribeParams = {
      ...entry.target,
      subscriptionId: entry.subscriptionId,
      ...(runtimePolicy ? { runtimePolicy } : {}),
    };
    const forwarded = withTrustedUnsubscribeRoute(params, {
      topic: entry.topic,
      connectionId: entry.connectionId,
    });
    switch (entry.kind) {
      case "conversation":
        return base.unsubscribeConversationV4(forwarded);
      case "sessions-index":
        return base.unsubscribeSessionsIndexV4(forwarded);
      case "workspace-config":
        return base.unsubscribeWorkspaceConfigV4(forwarded);
    }
  };
  const unsubscribeOwnedEntry = async (
    entry: OwnedSubscription,
    runtimePolicy?: ZCodeAgentRuntimePolicy,
  ): Promise<void> => {
    ownership.forget(entry);
    try {
      // trusted relay 以 owned route 校验 flow control。最后一个 subscription
      // 必须先 closed 再 unsubscribe；反序会让上游先忘 owner，closed 被拒绝后留下 paused connection。
      await flow.closeUnusedFlowRoute(entry);
    } finally {
      await unsubscribeBase(entry, runtimePolicy);
    }
  };
  const resyncBase = (entry: OwnedSubscription, params: ZCodeAgentConversationResyncParams) => {
    const forwarded = withTrustedUnsubscribeRoute(params, {
      topic: entry.topic,
      connectionId: entry.connectionId,
    });
    switch (entry.kind) {
      case "conversation":
        return base.resyncConversationV4(forwarded);
      case "sessions-index":
        return base.resyncSessionsIndexV4(forwarded);
      case "workspace-config":
        return base.resyncWorkspaceConfigV4(forwarded);
    }
  };
  const resyncOwned = (
    kind: OwnedSubscription["kind"],
    params: ZCodeAgentConversationResyncParams,
  ) => {
    assertReady();
    const entry = ownership.findBySubscription(
      kind,
      params,
      params.subscriptionId,
      forwardedUnsubscribeRoute(params),
    );
    if (!entry) return Promise.reject(new Error("fault.subscription.notOwned"));
    return resyncBase(entry, params);
  };
  const rememberAfterSubscribe = async (
    subscriptionId: string,
    entry: Omit<OwnedSubscription, "subscriptionId">,
    pending: PendingOwnership,
  ): Promise<void> => {
    ownership.removePendingOwnership(pending);
    const complete = { ...entry, subscriptionId };
    if (
      pending.invalidatedByRuntimeRestart ||
      pending.runtimeGeneration !== ownership.currentRuntimeGeneration(workspaceKey(entry.target))
    ) {
      // 旧 runtime 的迟到 ACK 可能与新 runtime 复用同一 subId。
      // 这里只丢本地 owner，绝不能向新 runtime 反向 unsubscribe 同名 subscription。
      ownership.discardPendingOwnership(pending);
      throw new Error("fault.subscription.runtimeRestarted");
    }
    if (disposed) {
      // port close 与 subscribe ACK 可并发；迟到 ACK 不能在已关闭 facade
      // 重新登记 owner，必须立即反向 unsubscribe。
      ownership.discardPendingOwnership(pending);
      await unsubscribeBase(complete).catch(() => {});
      throw new Error("fault.connection.closed");
    }
    if (pending.overflowReason) {
      const reason = pending.overflowReason;
      ownership.discardPendingOwnership(pending);
      await unsubscribeBase(complete).catch(() => {});
      throw new Error(reason);
    }
    ownership.remember(subscriptionId, complete);
    try {
      // 当前 transport 已 saturated 时，订阅 ACK 才让 trusted downstream route 成为事实；
      // 必须在此补发一次 SAT，不能等待下一个 high-water edge。
      await flow.syncCurrentFlowForEntry(complete);
    } catch (error) {
      ownership.forget(complete);
      await unsubscribeBase(complete).catch(() => {});
      throw error;
    }
    ownership.flushPendingFrames(complete, subscriptionId, pending);
  };

  const invalidateWorkspaceRuntime = (invalidatedWorkspaceKey: string, generation: number) => {
    ownership.invalidateWorkspaceRuntime(invalidatedWorkspaceKey, generation);
    flow.dropRoutesForWorkspace(invalidatedWorkspaceKey);
  };

  const hasRuntimeLifecycle = Boolean(base.onAgentRuntimeLifecycle);
  const runtimeLifecycleDisposable = base.onAgentRuntimeLifecycle?.((event) => {
    if (event.state === "available") {
      // 首次冷启动的 subscribe 会先登记 pending，再由同一次启动发布
      // available(gen1)，最后才收到 ACK。available 不是旧 ownership 的失效边界；
      // 若在这里推进 generation，会把当前 runtime 的合法 ACK 误判成 restart。
      // 真正的换代一定先发布 unavailable，由下方分支清理旧 owner/pending。
      return;
    }
    // attachment facade 若只监听 restart，runtime 退出但未重启时就会保留旧 owner，
    // 后续 UI cleanup 会重建 unsubscribe 参数并误走启动型 client；因此 unavailable 直接失效本地 owner。
    invalidateWorkspaceRuntime(event.workspaceKey, event.runtimeIdentity.generation);
  });
  const runtimeRestartDisposable = hasRuntimeLifecycle
    ? undefined
    : base.onAgentRuntimeRestarted?.(({ workspaceKey: restarted }) => {
        const nextGeneration = ownership.currentRuntimeGeneration(restarted) + 1;
        invalidateWorkspaceRuntime(restarted, nextGeneration);
      });

  const overrides: Partial<IZCodeAgentService> = {
    async helloConversationV4() {
      assertOpen();
      helloIssued = true;
      return createHello(context);
    },
    async initializeConversationV4(clientHello) {
      assertOpen();
      if (!helloIssued) throw new Error("fault.connection.helloRequired");
      const parsed = clientHelloSchema.parse(clientHello);
      if (boundClientId !== null && boundClientId !== parsed.clientId) {
        throw new Error("fault.connection.clientChanged");
      }
      boundClientId = parsed.clientId;
      clientWorkflowRunDeltas = clientSupportsWorkflowRunDeltas(parsed);
      clientHistoryFirst = parsed.capabilities?.historyFirst === true;
      handshakeComplete = true;
    },
    async setConnectionFlowStateV4(params) {
      assertOpen();
      if (role !== "trusted-host-relay") {
        throw new Error("fault.connection.flowControlForbidden");
      }
      const downstream = readTrustedZCodeAgentV4Connection(params);
      if (!downstream) throw new Error("fault.connection.flowControlUntrusted");
      const forwarded = forwardedConnection(params);
      if (!flow.ownsRoute(params, forwarded.connectionId)) {
        throw new Error("fault.subscription.notOwned");
      }
      await base.setConnectionFlowStateV4(withTrustedConnection(params, forwarded));
    },
    async sendConversationCommandV4(params) {
      assertOpen();
      if (role === "terminal-client") {
        assertReady();
        if (params.envelope.clientId !== boundClientId) {
          // 旧 facade 未覆盖 command 入口，未握手调用与伪造 clientId 都会
          // 直达 CLI；静默覆盖又会破坏 command 幂等归属，因此明确拒绝不一致。
          throw new Error("fault.command.clientMismatch");
        }
      }
      // command 过去只校验 envelope.clientId，却没有像订阅、附件一样注入
      // host 真值，导致 mobile 可伪造顶层 clientMode，且 relay 下游身份在 command 链路丢失。
      // envelope 仍原样透传；可信连接上下文只通过 host 内部 carrier 传给 base service。
      return base.sendConversationCommandV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async queryConversationCommandsV4(params) {
      assertReady();
      // 纯时钟探测不查询任何 command，不能抢占/改变业务查询的 workspace 绑定。
      if (params.clock)
        return base.queryConversationCommandsV4(
          withTrustedConnection(params, forwardedConnection(params)),
        );
      const requestedWorkspaceKey = workspaceKey(params);
      if (commandQueryWorkspaceKey !== null && commandQueryWorkspaceKey !== requestedWorkspaceKey) {
        throw new Error("fault.command.queryForeignWorkspace");
      }
      commandQueryWorkspaceKey = requestedWorkspaceKey;
      return base.queryConversationCommandsV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async backgroundBashOutputV4(params) {
      assertReady();
      return base.backgroundBashOutputV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async conversationRowsRangeV4(params) {
      assertReady();
      return base.conversationRowsRangeV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async attachmentBeginV4(params) {
      assertReady();
      const forwarded = forwardedConnection(params);
      const result = await base.attachmentBeginV4(withTrustedConnection(params, forwarded));
      if (result.state === "staging") {
        if (disposed || flow.isClosed()) {
          // begin ACK 可能晚于 port close。若此时再登记 route，closed 已经错过它，
          // CLI 会留下只能等 TTL 的半上传；先用同 trusted identity abort，再拒绝迟到结果。
          await base.attachmentAbortV4(withTrustedConnection(params, forwarded)).catch(() => {});
          throw new Error("fault.connection.closed");
        }
        const route = {
          key: flowRouteKey(params, forwarded.connectionId),
          target: workspaceTarget(params),
          connection: forwarded,
        };
        flow.registerAttachmentRoute(route);
        if (flow.currentState() === "saturated") {
          try {
            await flow.forwardRoute(route, "saturated");
          } catch (error) {
            flow.dropAttachmentRoute(route.key);
            await base.attachmentAbortV4(withTrustedConnection(params, forwarded)).catch(() => {});
            throw error;
          }
        }
      }
      return result;
    },
    async attachmentReadV4(params) {
      assertReady();
      return base.attachmentReadV4(withTrustedConnection(params, forwardedConnection(params)));
    },
    async conversationAttachmentReadV4(params) {
      assertReady();
      return base.conversationAttachmentReadV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async conversationAttachmentStatV4(params) {
      assertReady();
      return base.conversationAttachmentStatV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async attachmentPreviewSourceV4(params) {
      assertReady();
      return base.attachmentPreviewSourceV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async attachmentChunkV4(params) {
      assertReady();
      return base.attachmentChunkV4(withTrustedConnection(params, forwardedConnection(params)));
    },
    async attachmentCommitV4(params) {
      assertReady();
      const forwarded = forwardedConnection(params);
      return base.attachmentCommitV4(withTrustedConnection(params, forwarded));
    },
    async attachmentAbortV4(params) {
      assertReady();
      const forwarded = forwardedConnection(params);
      await base.attachmentAbortV4(withTrustedConnection(params, forwarded));
    },
    async subscribeConversationV4(params) {
      assertReady();
      const forwarded = forwardedConnection(params);
      const topic = conversationTopic(params.sessionId);
      const pending = ownership.beginPendingOwnership("conversation", params, topic);
      try {
        const result = await base.subscribeConversationV4(withTrustedConnection(params, forwarded));
        await rememberAfterSubscribe(
          result.ack.subscriptionId,
          {
            kind: "conversation",
            ownershipKey: `conversation\0${workspaceKey(params)}\0${topic}\0${forwarded.connectionId}`,
            topic,
            connectionId: forwarded.connectionId,
            clientMode: forwarded.clientMode,
            target: workspaceTarget(params),
          },
          pending,
        );
        return result;
      } catch (error) {
        ownership.discardPendingOwnership(pending);
        throw error;
      }
    },
    async unsubscribeConversationV4(params) {
      const entry = ownership.findBySubscription(
        "conversation",
        params,
        params.subscriptionId,
        forwardedUnsubscribeRoute(params),
      );
      if (!entry) return;
      await unsubscribeOwnedEntry(entry, params.runtimePolicy);
    },
    async resyncConversationV4(params) {
      return resyncOwned("conversation", params);
    },
    onDynamicConversationFrame(params) {
      return ownership.routedEvent<ConversationTopicWireCandidate>(
        "conversation",
        params,
        base.onDynamicConversationFrame(params),
      );
    },
    onDynamicLocalTtftFacts(params) {
      assertOpen();
      if (
        role !== "terminal-client" ||
        context.clientMode !== "desktop-continuous" ||
        params.workspaceIdentity?.trim() ||
        params.remoteSessionId
      )
        return RpcEvent.None;
      return base.onDynamicLocalTtftFacts(workspaceTarget(params));
    },
    onDynamicConversationTelemetryFact(params) {
      assertOpen();
      // 可信 clientMode 来自 host attachment；Web/mobile/relay 即使能读权威对话态，
      // 也不能借共享 workspace emitter 安装生产 telemetry reporter。
      const downstream = readTrustedZCodeAgentV4Connection(params);
      const relayDesktopDownstream =
        role === "trusted-host-relay" && downstream?.clientMode === "desktop-continuous";
      if (
        context.clientMode !== "desktop-continuous" ||
        (role !== "terminal-client" && !relayDesktopDownstream)
      ) {
        return RpcEvent.None;
      }
      // renderer 的 workspace supervisor 会先于 V4 hello/initialize 挂载。
      // telemetry emitter 本身不发起协议请求，允许可信 desktop 提前监听，避免动态
      // Event 在 handshake 前抛错并让 host channel 退出；live fact 仍只会在 ingest 后产生。
      // 远程 workspace 还会经过 trusted host relay；这里沿用已有 trusted carrier 传递
      // 下游 clientMode/namespace connectionId，relay 自身没有可信下游时仍保持拒绝。
      return base.onDynamicConversationTelemetryFact(
        withTrustedConnection(workspaceTarget(params), forwardedConnection(params)),
      );
    },
    onDynamicPluginUiToolResult() {
      assertOpen();
      // 页面创建只属于本地桌面；手机回放和 relay 不拥有原生 guest。
      if (role !== "terminal-client" || context.clientMode !== "desktop-continuous")
        return RpcEvent.None;
      return base.onDynamicPluginUiToolResult();
    },
    onDynamicCuaPermissionObservation() {
      assertOpen();
      // 权限弹窗是本地桌面副作用；手机 replay attachment 只能消费可恢复对话事实。
      if (role !== "terminal-client" || context.clientMode !== "desktop-continuous") {
        return RpcEvent.None;
      }
      return base.onDynamicCuaPermissionObservation();
    },
    onDynamicProcessResourceSample() {
      assertOpen();
      // CLI 资源样本只供远端 Desktop Host relay 回传 main；renderer/mobile attachment
      // 不消费该事件，也不能把它引入 continuous/replayable 消息面。
      if (role !== "trusted-host-relay") {
        return RpcEvent.None;
      }
      return base.onDynamicProcessResourceSample();
    },
    onDynamicToolExecResource() {
      // 完成事实与会话交付无关，禁止进入 continuous/replayable attachment。
      if (disposed || role !== "trusted-host-relay") return RpcEvent.None;
      return base.onDynamicToolExecResource();
    },
    onDynamicMcpResourceSamples() {
      // 资源事实不属于会话流，桌面 continuous 与手机 replayable attachment 均不能订阅。
      if (disposed || role !== "trusted-host-relay") return RpcEvent.None;
      return base.onDynamicMcpResourceSamples();
    },
    onDynamicMcpTelemetry() {
      assertOpen();
      // MCP 遥测与 CLI 资源样本共用可信 Host relay 边界，不进入 renderer/mobile 会话链路。
      if (role !== "trusted-host-relay") {
        return RpcEvent.None;
      }
      return base.onDynamicMcpTelemetry();
    },
    async subscribeSessionsIndexV4(params) {
      assertReady();
      const forwarded = forwardedConnection(params);
      const topic = sessionsIndexTopic(workspaceKey(params));
      const pending = ownership.beginPendingOwnership("sessions-index", params, topic);
      try {
        const result = await base.subscribeSessionsIndexV4(
          withTrustedConnection(params, forwarded),
        );
        await rememberAfterSubscribe(
          result.ack.subscriptionId,
          {
            kind: "sessions-index",
            ownershipKey: `sessions-index\0${topic}\0${forwarded.connectionId}`,
            topic,
            connectionId: forwarded.connectionId,
            clientMode: forwarded.clientMode,
            target: workspaceTarget(params),
          },
          pending,
        );
        return result;
      } catch (error) {
        ownership.discardPendingOwnership(pending);
        throw error;
      }
    },
    async unsubscribeSessionsIndexV4(params) {
      const entry = ownership.findBySubscription(
        "sessions-index",
        params,
        params.subscriptionId,
        forwardedUnsubscribeRoute(params),
      );
      if (!entry) return;
      await unsubscribeOwnedEntry(entry, params.runtimePolicy);
    },
    async resyncSessionsIndexV4(params) {
      return resyncOwned("sessions-index", params);
    },
    onDynamicSessionsIndexFrame(params) {
      return ownership.routedEvent<SessionsIndexTopicWireCandidate>(
        "sessions-index",
        params,
        base.onDynamicSessionsIndexFrame(params),
      );
    },
    async subscribeWorkspaceConfigV4(params) {
      assertReady();
      const forwarded = forwardedConnection(params);
      const topic = workspaceConfigTopic(workspaceKey(params));
      const pending = ownership.beginPendingOwnership("workspace-config", params, topic);
      try {
        const result = await base.subscribeWorkspaceConfigV4(
          withTrustedConnection(params, forwarded),
        );
        await rememberAfterSubscribe(
          result.ack.subscriptionId,
          {
            kind: "workspace-config",
            ownershipKey: `workspace-config\0${topic}\0${forwarded.connectionId}`,
            topic,
            connectionId: forwarded.connectionId,
            clientMode: forwarded.clientMode,
            target: workspaceTarget(params),
          },
          pending,
        );
        return result;
      } catch (error) {
        ownership.discardPendingOwnership(pending);
        throw error;
      }
    },
    async unsubscribeWorkspaceConfigV4(params) {
      const entry = ownership.findBySubscription(
        "workspace-config",
        params,
        params.subscriptionId,
        forwardedUnsubscribeRoute(params),
      );
      if (!entry) return;
      await unsubscribeOwnedEntry(entry, params.runtimePolicy);
    },
    async resyncWorkspaceConfigV4(params) {
      return resyncOwned("workspace-config", params);
    },
    onDynamicWorkspaceConfigFrame(params) {
      return ownership.routedEvent<WorkspaceConfigTopicWireCandidate>(
        "workspace-config",
        params,
        base.onDynamicWorkspaceConfigFrame(params),
      );
    },
  };

  const service = new Proxy(base, {
    get(target, property, receiver) {
      const override = Reflect.get(overrides, property, receiver);
      if (override !== undefined) return override;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return {
    service,
    setTransportFlowState(state) {
      return flow.enqueue(state);
    },
    async dispose() {
      if (disposed) return;
      // close 必须排在已入队 SAT/DRN 之后；即使控制 RPC 失败也继续 owned cleanup。
      await flow.enqueue("closed").catch(() => {});
      if (disposed) return;
      disposed = true;
      handshakeComplete = false;
      helloIssued = false;
      boundClientId = null;
      clientWorkflowRunDeltas = false;
      const entries = ownership.takeEntries();
      ownership.clearPending();
      ownership.disposeRoutedEvents();
      runtimeLifecycleDisposable?.dispose();
      runtimeRestartDisposable?.dispose();
      ownership.clearRuntimeGenerations();
      flow.clear();
      await Promise.allSettled(entries.map((entry) => unsubscribeBase(entry)));
    },
  };
}
