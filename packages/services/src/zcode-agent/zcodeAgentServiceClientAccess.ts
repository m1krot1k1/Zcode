import type {
  ZCodeAgentAppRuntimePreferences,
  ZCodeAgentConversationCommandParams,
  ZCodeAgentConversationResyncParams,
  ZCodeAgentConversationUnsubscribeParams,
  ZCodeAgentSavedWorkflowTarget,
  ZCodeAgentSessionTarget,
  ZCodeAgentWorkspaceTarget,
} from "./zcodeAgent.js";
import type { ZCodeAgentServiceAccountHelpers } from "./zcodeAgentServiceAccountHelpers.js";
import type { ZCodeAgentServiceRequestHandlersA } from "./zcodeAgentServiceRequestHandlersA.js";
import type { ZCodeAgentServiceRequestHandlersB } from "./zcodeAgentServiceRequestHandlersB.js";
import type { ZCodeAgentServiceRequestHandlersC } from "./zcodeAgentServiceRequestHandlersC.js";
import type { ZCodeAgentServiceSessionHelpers } from "./zcodeAgentServiceSessionHelpers.js";
import type { ZCodeAgentServiceState } from "./zcodeAgentServiceState.js";
import type { ZCodeAgentServiceWireHelpers } from "./zcodeAgentServiceWireClient.js";
import type { ZCodeProtocolClient } from "./zcodeProtocolClient.js";
import {
  DEFAULT_DYNAMIC_WORKFLOW_MODE,
  ZCODE_AGENT_PROVIDER_NOT_READY_CODE,
  ZCODE_AGENT_PROVIDER_NOT_READY_REASON,
  applyDynamicWorkflowUserMode,
  createDynamicWorkflowClientConfig,
  isDynamicWorkflowModeEnabled,
  isRemoteWorkspaceIdentity,
  normalizeDynamicWorkflowMode,
  resolveWorkspaceKey,
  type DynamicWorkflowClientConfig,
  type DynamicWorkflowMode,
  type TraceId,
  type ZCodeSessionStateSnapshot,
  type ZCodeWorkspaceRef,
  zcodeProtocolEmptyResultSchema,
  zcodeProtocolMethods,
  zcodeWorkspaceUpdateDynamicWorkflowPolicyResultSchema,
  zcodeWorkspaceUpdateOffPeakToolPolicyResultSchema,
} from "@zcode/shared";
import {
  V4_METHODS,
  commandPayloadSchemas,
  type CommandEnvelope,
  v4ConversationResyncResultSchema,
} from "@zcode/shared/zcode-protocol-v4";
import {
  buildWorkspaceRef,
  ensurePluginManagementWorkspacePath,
  isProtocolMethodNotFoundError,
  logger,
  savedWorkflowTargetHasWorkspace,
} from "./zcodeAgentServiceSupport.js";
import {
  createProviderReadinessSnapshotFromSelectionView,
  createRuntimeUnavailableError,
  sessionEventKey,
  type ActiveWorkspaceClient,
  type WaitingWorkspaceStartup,
  type ZCodeAgentProviderReadinessSnapshot,
} from "./zcodeAgentServiceParams.js";
import {
  mergeAutomationMutationToolDenylist,
  mergeOffPeakMutationToolDenylist,
} from "#src/zcode-agent/automationToolPolicy.js";
import { createHash } from "node:crypto";

export function createClientAccessHelpers(
  ctx: ZCodeAgentServiceState &
    ZCodeAgentServiceSessionHelpers &
    ZCodeAgentServiceAccountHelpers &
    ZCodeAgentServiceRequestHandlersA &
    ZCodeAgentServiceRequestHandlersB &
    ZCodeAgentServiceRequestHandlersC &
    ZCodeAgentServiceWireHelpers,
) {
  const {
    activeClientsByWorkspaceKey,
    cancelAllWaitingWorkspaceStartups,
    clearV4SubscriptionRoutes,
    conversationFrameEmitters,
    conversationTelemetryFactEmitters,
    cuaOperationTurnTracker,
    cuaPermissionObservationEmitter,
    dynamicWorkflowPolicySyncByWorkspaceKey,
    enqueueInteractionPreferenceSync,
    ensureAccountProviderConfigSynced,
    forgetV4SubscriptionRoute,
    interactionPreferenceSyncByWorkspaceKey,
    isCurrentV4SubscriptionRoute,
    localTtftFactsEmitter,
    mcpResourceSamplesEmitter,
    mcpStatusProcessManager,
    mcpTelemetryEmitter,
    memoryDiagnostics,
    modelSelectionReadinessSource,
    mutable,
    offPeakLifecycleEmitters,
    options,
    pendingPermissions,
    pendingProviderRuntimeHeaders,
    pendingSessionRuntimePreferences,
    pendingUserInputs,
    pluginOperationProgressEmitters,
    pluginProcessManager,
    pluginUiToolResultEmitter,
    processManager,
    processResourceSampleEmitter,
    providerRuntimeHeadersCancelledEmitters,
    providerRuntimeHeadersWorkspaceEmitters,
    resolveV4UnsubscribeRoute,
    sessionEmitters,
    sessionEventSequenceStates,
    sessionRuntimePreferencesRequestEmitter,
    sessionTraceIdBySessionKey,
    sessionsIndexFrameEmitters,
    toolExecResourceEmitter,
    waitingWorkspaceStartups,
    wireClient,
    workspaceConfigFrameEmitters,
  } = ctx;
  async function handleProviderReadinessChanged(event: {
    reason: string;
    snapshot: ZCodeAgentProviderReadinessSnapshot;
  }): Promise<void> {
    if (event.snapshot.readiness.ready) {
      await Promise.allSettled(
        Array.from(waitingWorkspaceStartups.entries()).map(async ([workspaceKey, waiting]) => {
          // ready 事件可能赶在旧 readiness 读取返回前到达。先收口旧尝试，再读取新状态，
          // 避免事件复用一个即将以 provider-not-ready 失败的 Promise 而丢失唯一的 ready 通知。
          try {
            await waiting.starting;
          } catch (error) {
            if (!isProviderNotReadyError(error)) throw error;
          }
          // Bug 根因：provider-ready 事件会先快照 waiting 列表再异步启动；workspace 在
          // await 期间被移除后，旧快照仍会把已释放的 Agent 重新拉起。只允许当前
          // waiting identity 对应的 generation 继续，删除或换代后的回调必须失效。
          if (waiting.cancelled || waitingWorkspaceStartups.get(workspaceKey) !== waiting) {
            return;
          }
          const { workspace } = waiting;
          const client = await getClient(workspace);
          await ensureAccountProviderConfigSynced({
            client,
            reason: `startup_ready:${event.reason}`,
            workspace,
            refreshRegistry: true,
          });
          logger.info(undefined, "provider/model 就绪后已启动等待中的 ZCode agent", {
            providerCount: event.snapshot.providerCount,
            reason: event.reason,
            revision: event.snapshot.revision,
            workspaceKey: resolveWorkspaceKey(workspace),
            workspacePath: workspace.workspacePath,
          });
        }),
      );
    }
  }

  async function unsubscribeV4Route(
    params: ZCodeAgentConversationUnsubscribeParams,
    topicPrefix: string,
  ): Promise<void> {
    const route = resolveV4UnsubscribeRoute(params, topicPrefix);
    if (!route) return;
    const client = await getReadOnlyClient(params, params.runtimePolicy);
    // getReadOnlyClient 可能在 await 中拉起新 runtime；restart listener 已清旧 route，且新
    // runtime 可能复用相同 key/subId。必须以对象身份复核，不能拿局部旧 route 发给新 CLI。
    if (!isCurrentV4SubscriptionRoute(route)) return;
    await client.request(
      V4_METHODS.conversationUnsubscribe,
      {
        topic: route.topic,
        subscriptionId: route.subscriptionId,
        connectionId: route.connectionId,
      },
      zcodeProtocolEmptyResultSchema,
    );
    // request 在途时 runtime restart/重订阅可用相同 route key 建立新对象；
    // 迟到旧 response 只能清理它自己的 generation，不能按复合 key 删除新 route。
    if (isCurrentV4SubscriptionRoute(route)) forgetV4SubscriptionRoute(route);
  }

  async function resyncV4Route(params: ZCodeAgentConversationResyncParams, topicPrefix: string) {
    const route = resolveV4UnsubscribeRoute(params, topicPrefix);
    if (!route) throw new Error("fault.subscription.notOwned");
    const client = await getReadOnlyClient(params, params.runtimePolicy);
    if (!isCurrentV4SubscriptionRoute(route)) {
      throw new Error("fault.subscription.notOwned");
    }
    const result = await client.request(
      V4_METHODS.conversationResync,
      {
        topic: route.topic,
        connectionId: route.connectionId,
        subscriptionId: route.subscriptionId,
        base: params.base,
        ...(params.forceSnapshot !== undefined ? { forceSnapshot: params.forceSnapshot } : {}),
      },
      v4ConversationResyncResultSchema,
    );
    // resync ACK 只对发起时的 route generation 有效。若 await 期间已 restart/重订阅，
    // 返回 stale success 会让 consumer 把旧 recovery 当作新 subscription 的恢复结果。
    if (!isCurrentV4SubscriptionRoute(route)) {
      throw new Error("fault.subscription.notOwned");
    }
    return result;
  }

  function rememberSessionTrace(
    target: ZCodeAgentSessionTarget,
    snapshot: ZCodeSessionStateSnapshot,
  ): TraceId | undefined {
    const traceId = snapshot.session.traceId as TraceId | undefined;
    if (traceId) {
      sessionTraceIdBySessionKey.set(sessionEventKey(target), traceId);
    }
    return traceId;
  }

  function getSessionTraceId(target: ZCodeAgentSessionTarget): TraceId | undefined {
    return sessionTraceIdBySessionKey.get(sessionEventKey(target));
  }

  function createProviderNotReadyError(params: {
    snapshot?: ZCodeAgentProviderReadinessSnapshot;
    workspace: ZCodeAgentWorkspaceTarget;
  }): Error & {
    code: typeof ZCODE_AGENT_PROVIDER_NOT_READY_CODE;
    data: {
      providerCount: number;
      reason: typeof ZCODE_AGENT_PROVIDER_NOT_READY_REASON;
      revision: string | null;
      workspaceKey: string;
      workspacePath: string;
    };
  } {
    const workspaceKey = resolveWorkspaceKey(params.workspace);
    const error = new Error("当前没有可用的模型供应商和模型，请先登录或配置 API Key。") as Error & {
      code: typeof ZCODE_AGENT_PROVIDER_NOT_READY_CODE;
      data: {
        providerCount: number;
        reason: typeof ZCODE_AGENT_PROVIDER_NOT_READY_REASON;
        revision: string | null;
        workspaceKey: string;
        workspacePath: string;
      };
    };
    error.code = ZCODE_AGENT_PROVIDER_NOT_READY_CODE;
    error.data = {
      providerCount: params.snapshot?.providerCount ?? 0,
      reason: ZCODE_AGENT_PROVIDER_NOT_READY_REASON,
      revision: params.snapshot?.revision ?? null,
      workspaceKey,
      workspacePath: params.workspace.workspacePath,
    };
    return error;
  }

  function isProviderNotReadyError(
    error: unknown,
  ): error is Error & { code: typeof ZCODE_AGENT_PROVIDER_NOT_READY_CODE } {
    return (
      error instanceof Error &&
      (error as { code?: unknown }).code === ZCODE_AGENT_PROVIDER_NOT_READY_CODE
    );
  }

  async function resolveStartupReadiness(): Promise<
    ZCodeAgentProviderReadinessSnapshot | undefined
  > {
    if (modelSelectionReadinessSource) {
      return createProviderReadinessSnapshotFromSelectionView(
        await modelSelectionReadinessSource.getView(),
      );
    }
    return undefined;
  }

  /**
   * stop/取消 RPC 超时或 watchdog 会回收 client/进程，但进程异步退出，
   * client.onClose 尚未触发时 activeClientsByWorkspaceKey 仍指向已 disposed 的 client。
   * 所有复用 active entry 的路径必须先经过本检查；disposed 时清理 stale entry 并返回 false，
   * 让调用方重新拉起进程（start-if-needed）或按“无运行时”处理（existing-only）。
   */
  function isReusableActiveClientEntry(
    params: ZCodeAgentWorkspaceTarget,
    active: ActiveWorkspaceClient | undefined,
  ): boolean {
    if (!active) {
      return false;
    }
    if (!active.client.isDisposed) {
      return true;
    }
    const workspaceKey = resolveWorkspaceKey(params);
    activeClientsByWorkspaceKey.delete(workspaceKey);
    interactionPreferenceSyncByWorkspaceKey.delete(workspaceKey);
    logger.warn(undefined, "复用的 ZCode Protocol client 已 disposed，清理 stale entry", {
      workspaceKey,
      workspacePath: params.workspacePath,
    });
    return false;
  }

  async function getOrStartReadOnlyClient(
    params: ZCodeAgentWorkspaceTarget,
  ): Promise<ActiveWorkspaceClient> {
    const workspaceKey = resolveWorkspaceKey(params);
    const active = activeClientsByWorkspaceKey.get(workspaceKey);
    if (active && isReusableActiveClientEntry(params, active)) {
      active.workspace = params;
      await active.interactionPreferencesReady;
      return active;
    }

    const client = await processManager.getClient(params);
    wireClient(client, params, "chat");

    // processManager 会按 workspaceKey 对并发启动 single-flight。await 期间若另一条
    // read/write 路径已登记同一 client，必须复用现有 entry，不能把已提升的写能力降回 false。
    const concurrent = activeClientsByWorkspaceKey.get(workspaceKey);
    if (concurrent && isReusableActiveClientEntry(params, concurrent)) {
      concurrent.workspace = params;
      await concurrent.interactionPreferencesReady;
      return concurrent;
    }

    const entry: ActiveWorkspaceClient = {
      client,
      modelExecutionEnabled: false,
      workspace: params,
      dynamicWorkflowPolicyMode: "disabled",
    };
    activeClientsByWorkspaceKey.set(workspaceKey, entry);
    const interactionPreferencesReady = (async () => {
      let appliedSnapshot: ZCodeAgentAppRuntimePreferences | undefined;
      while (
        mutable.latestAppRuntimePreferences &&
        mutable.latestAppRuntimePreferences !== appliedSnapshot
      ) {
        const snapshot = mutable.latestAppRuntimePreferences;
        await enqueueInteractionPreferenceSync({
          client,
          preferences: { ...snapshot },
          workspace: params,
        });
        appliedSnapshot = snapshot;
      }
    })();
    // Off-Peak 本地支持能力是 workspace 级事实，在允许任何 session 工作前同步到 CLI，
    // 让 v4 冷恢复（没有 per-request flag 通道）也能拿到工具面。旧 CLI method-not-found 降级忽略。
    // CLI 缺省即 false，且每个 agent 进程只服务一个 workspace，门禁关闭时不发请求（对未实现该
    // 方法的旧 CLI/测试假客户端零打扰）。
    const offPeakToolPolicyReady = (async () => {
      if (!isOffPeakToolSupported(params)) return;
      try {
        await client.request(
          zcodeProtocolMethods.workspaceUpdateOffPeakToolPolicy,
          { workspace: buildWorkspaceRef(params), enabled: true },
          zcodeWorkspaceUpdateOffPeakToolPolicyResultSchema,
        );
      } catch (error) {
        // 策略同步是尽力而为的能力分发，失败方向是 fail-closed（CLI 缺省不注册工具），
        // 超时/暂时性 IPC 错误不得阻断客户端就绪；-32601 是旧 CLI 的正常降级。
        if (!isProtocolMethodNotFoundError(error)) {
          logger.warn(undefined, "Off-Peak 工具策略同步失败，CLI 维持缺省关闭", {
            workspaceKey,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    // 动态工作流灰度门禁：与 Off-Peak 同一
    // 模式的 workspace 级事实，在允许任何 session 工作前同步给 CLI，v4 冷恢复也才拿得到工具面。
    // 生效模式为关闭时不发请求（CLI 缺省即关闭，对旧 CLI/测试假客户端零打扰）；之后用户改选择时
    // 经同一条 workspace 串行链重发（launch.md「The user's choice」）。
    const dynamicWorkflowPolicyReady = enqueueDynamicWorkflowPolicySync(entry);
    entry.interactionPreferencesReady = Promise.all([
      interactionPreferencesReady,
      offPeakToolPolicyReady,
      dynamicWorkflowPolicyReady,
    ]).then(() => undefined);
    try {
      // 新建或重启 runtime 在允许任何 session 工作前追平缓存；同步期间的新开关
      // 会因 entry 已登记而进入同一 workspace 串行队列，不会丢失提交顺序。
      await entry.interactionPreferencesReady;
    } catch (error) {
      if (activeClientsByWorkspaceKey.get(workspaceKey) === entry) {
        activeClientsByWorkspaceKey.delete(workspaceKey);
      }
      throw error;
    } finally {
      delete entry.interactionPreferencesReady;
    }
    logger.info(undefined, "为只读会话控制面启动 ZCode agent", {
      workspaceKey,
      workspacePath: params.workspacePath,
    });
    return entry;
  }

  async function getClient(params: ZCodeAgentWorkspaceTarget) {
    const workspaceKey = resolveWorkspaceKey(params);
    const active = activeClientsByWorkspaceKey.get(workspaceKey);
    if (active?.modelExecutionEnabled && isReusableActiveClientEntry(params, active)) {
      active.workspace = params;
      return active.client;
    }

    const waiting: WaitingWorkspaceStartup = waitingWorkspaceStartups.get(workspaceKey) ?? {
      cancelled: false,
      workspace: params,
    };
    waiting.workspace = params;
    waitingWorkspaceStartups.set(workspaceKey, waiting);

    // Bug 根因：并发调用各自 await readiness，先成功的一条会删除等待记录，迟到调用
    // 因而把成功误判成 workspace 已释放。共享整个启动 Promise，取消仍由 waiting identity 控制。
    const starting = (waiting.starting ??= startModelExecutionClient(params, waiting));
    try {
      return await starting;
    } finally {
      if (waiting.starting === starting) delete waiting.starting;
    }
  }

  async function startModelExecutionClient(
    params: ZCodeAgentWorkspaceTarget,
    waiting: WaitingWorkspaceStartup,
  ): Promise<ZCodeProtocolClient> {
    const workspaceKey = resolveWorkspaceKey(params);
    const active = activeClientsByWorkspaceKey.get(workspaceKey);

    const readinessSnapshot = await resolveStartupReadiness();
    // readiness 读取可能与 workspace release 交错；release 删除 waiting identity 后，
    // 旧 continuation 不能创建新进程。未来重新打开同一路径会获得新的 identity，互不误伤。
    if (waiting.cancelled || waitingWorkspaceStartups.get(workspaceKey) !== waiting) {
      throw createRuntimeUnavailableError(params);
    }
    const readiness = readinessSnapshot?.readiness;
    if (!readinessSnapshot || !readiness?.ready) {
      const revision = readinessSnapshot?.revision ?? "missing";
      if (waiting.lastLoggedRevision !== revision) {
        waiting.lastLoggedRevision = revision;
        logger.info(
          undefined,
          active
            ? "provider/model 尚未就绪，ZCode agent 保持只读"
            : "provider/model 尚未就绪，ZCode agent 保持未启动",
          {
            providerCount: readinessSnapshot?.providerCount ?? 0,
            revision: readinessSnapshot?.revision ?? null,
            workspaceKey,
            workspacePath: params.workspacePath,
          },
        );
      }
      throw createProviderNotReadyError({
        snapshot: readinessSnapshot,
        workspace: params,
      });
    }

    const entry = await getOrStartReadOnlyClient(params);
    if (waiting.cancelled) {
      throw createRuntimeUnavailableError(params);
    }
    entry.modelExecutionEnabled = true;
    processManager.markReady(params, entry.client);
    entry.workspace = params;
    waitingWorkspaceStartups.delete(workspaceKey);
    logger.info(undefined, "provider/model 就绪，允许 ZCode agent 模型执行", {
      modelId: readiness.modelId,
      providerId: readiness.providerId,
      revision: readinessSnapshot.revision,
      workspaceKey,
      workspacePath: params.workspacePath,
    });
    return entry.client;
  }

  async function getReadOnlyClient(
    params: ZCodeAgentWorkspaceTarget,
    runtimePolicy: "start-if-needed" | "existing-only" = "start-if-needed",
  ) {
    if (runtimePolicy === "existing-only") {
      const workspaceKey = resolveWorkspaceKey(params);
      const active = activeClientsByWorkspaceKey.get(workspaceKey);
      // 观察者路径同样要拒绝 disposed 的 stale entry；清理后按“无运行时”处理，
      // 绝不为观察者拉起新进程（保持 existing-only 语义）。
      if (active && isReusableActiveClientEntry(params, active)) {
        active.workspace = params;
        return active.client;
      }
      // runtime available 可能先于原启动调用的 await continuation 到达。这里允许把
      // process manager 已登记的 client 提升为 service active entry，但绝不创建新进程。
      const existingClient = processManager.getExistingClient(params);
      if (!existingClient) {
        throw createRuntimeUnavailableError(params);
      }
      wireClient(existingClient, params, "chat");
      activeClientsByWorkspaceKey.set(workspaceKey, {
        client: existingClient,
        modelExecutionEnabled: false,
        workspace: params,
        // 只提升已有 client，不重放就绪阶段的策略同步；按 CLI 缺省记为关闭，用户改选择时再补发。
        dynamicWorkflowPolicyMode: "disabled",
      });
      return existingClient;
    }
    return (await getOrStartReadOnlyClient(params)).client;
  }

  async function getPluginManagementClient(): Promise<ZCodeProtocolClient> {
    const workspace = { workspacePath: ensurePluginManagementWorkspacePath() };
    const client = await pluginProcessManager.getClient(workspace);
    wireClient(client, workspace, "plugin");
    return client;
  }

  // 全局工作流的载体运行时选择：
  // 调用方只给 `{ scope: "global" }` 不带 workspace 时，先复用任一已活跃的**本地** runtime
  // （existing-only 语义：只看 activeClientsByWorkspaceKey，绝不为此拉起新进程），否则回落到
  // 管理面 workspace——照 getPluginManagementClient 先例用专用 pluginProcessManager 拉一个控制面
  // runtime。选它而非 getOrStartReadOnlyClient 的理由：workflows/* 是无会话、不依赖 provider/model
  // 就绪的 workspace 级方法，管理面进程正是为这种「不寄居真实项目」的控制面能力准备的，且不会因
  // 真实 workspace 生命周期被 watchdog 回收；getOrStartReadOnlyClient 反而会把这个合成 workspace
  // 塞进 activeClientsByWorkspaceKey 并跑一遍交互偏好同步，污染会话 client map。两条路径都在本机，
  // homedir() 即用户家目录，全局根 `~/.zcode/workflows/` 因此解析到真实目录。
  // 远程 runtime（SSH/WSL identity 或带 remoteSessionId）的 home 不是本机，绝不选它当载体。
  function isLocalActiveWorkspaceClient(workspace: ZCodeAgentWorkspaceTarget): boolean {
    return (
      !workspace.remoteSessionId &&
      !(workspace.workspaceIdentity && isRemoteWorkspaceIdentity(workspace.workspaceIdentity))
    );
  }

  async function resolveGlobalSavedWorkflowCarrier(): Promise<{
    client: ZCodeProtocolClient;
    workspace: ZCodeWorkspaceRef;
  }> {
    for (const active of activeClientsByWorkspaceKey.values()) {
      if (!isLocalActiveWorkspaceClient(active.workspace)) {
        continue;
      }
      // disposed / stale entry 的清理语义与 getReadOnlyClient(existing-only) 一致：
      // isReusableActiveClientEntry 会顺手清掉已回收的 entry，然后我们跳过它继续找。
      if (!isReusableActiveClientEntry(active.workspace, active)) {
        continue;
      }
      return {
        client: active.client,
        workspace: buildWorkspaceRef(active.workspace),
      };
    }
    const managementWorkspace = {
      workspacePath: ensurePluginManagementWorkspacePath(),
    };
    const client = await getPluginManagementClient();
    return { client, workspace: buildWorkspaceRef(managementWorkspace) };
  }

  // 五个 workflows/* 方法的载体：带 workspace 就直通（项目档，或 GUI 项目组里明说 scope 的动作），
  // 只给 `scope:"global"` 时交给 services 自选本机载体。
  async function resolveSavedWorkflowCarrier(
    params: ZCodeAgentSavedWorkflowTarget,
  ): Promise<{ client: ZCodeProtocolClient; workspace: ZCodeWorkspaceRef }> {
    if (savedWorkflowTargetHasWorkspace(params)) {
      return {
        client: await getReadOnlyClient(params),
        workspace: buildWorkspaceRef(params),
      };
    }
    return resolveGlobalSavedWorkflowCarrier();
  }

  // mcp/list 专用：与插件管理命令隔离进程，见 mcpStatusProcessManager 处的说明。
  async function getMcpStatusClient(): Promise<ZCodeProtocolClient> {
    const workspace = { workspacePath: ensurePluginManagementWorkspacePath() };
    const client = await mcpStatusProcessManager.getClient(workspace);
    wireClient(client, workspace, "mcp-status");
    return client;
  }

  function disposeLocalState(): void {
    mutable.accountProviderConfigUnsubscribe?.();
    mutable.accountProviderConfigUnsubscribe = undefined;
    mutable.runtimeProviderCatalogUnsubscribe?.();
    mutable.runtimeProviderCatalogUnsubscribe = undefined;
    mutable.modelSelectionSubscription?.dispose();
    mutable.modelSelectionSubscription = undefined;
    memoryDiagnostics.dispose();
    for (const emitter of sessionEmitters.values()) {
      emitter.dispose();
    }
    sessionEmitters.clear();
    for (const emitter of providerRuntimeHeadersWorkspaceEmitters.values()) {
      emitter.dispose();
    }
    providerRuntimeHeadersWorkspaceEmitters.clear();
    for (const emitter of providerRuntimeHeadersCancelledEmitters.values()) emitter.dispose();
    providerRuntimeHeadersCancelledEmitters.clear();
    sessionRuntimePreferencesRequestEmitter.dispose();
    processResourceSampleEmitter.dispose();
    mcpTelemetryEmitter.dispose();
    toolExecResourceEmitter.dispose();
    mcpResourceSamplesEmitter.dispose();
    for (const emitter of pluginOperationProgressEmitters.values()) {
      emitter.dispose();
    }
    pluginOperationProgressEmitters.clear();
    for (const emitter of conversationFrameEmitters.values()) {
      emitter.dispose();
    }
    conversationFrameEmitters.clear();
    for (const emitter of conversationTelemetryFactEmitters.values()) {
      emitter.dispose();
    }
    conversationTelemetryFactEmitters.clear();
    for (const emitter of offPeakLifecycleEmitters.values()) emitter.dispose();
    offPeakLifecycleEmitters.clear();
    localTtftFactsEmitter.dispose();
    cuaPermissionObservationEmitter.dispose();
    pluginUiToolResultEmitter.dispose();
    for (const emitter of workspaceConfigFrameEmitters.values()) {
      emitter.dispose();
    }
    workspaceConfigFrameEmitters.clear();
    for (const emitter of sessionsIndexFrameEmitters.values()) {
      emitter.dispose();
    }
    sessionsIndexFrameEmitters.clear();
    sessionEventSequenceStates.clear();
    sessionTraceIdBySessionKey.clear();
    pendingPermissions.clear();
    pendingUserInputs.clear();
    pendingProviderRuntimeHeaders.clear();
    for (const pending of pendingSessionRuntimePreferences.values()) {
      clearTimeout(pending.timeout);
    }
    pendingSessionRuntimePreferences.clear();
    activeClientsByWorkspaceKey.clear();
    cancelAllWaitingWorkspaceStartups();
    interactionPreferenceSyncByWorkspaceKey.clear();
    cuaOperationTurnTracker?.clearAll();
    clearV4SubscriptionRoutes();
    mutable.v4RouteRuntimeRestartDisposable?.dispose();
    mutable.runtimeLifecycleDisposable?.dispose();
  }

  // 3.12.2：远端灰度读取不能放进客户端就绪与创建命令：失败时串行重试会阻塞普通聊天。
  // 注册只判断本地支持能力；灰度、套餐与模型准入仍由 offPeak/create handler 在取号前校验。
  function isOffPeakToolSupported(params: {
    workspaceIdentity?: string;
    remoteSessionId?: string;
  }): boolean {
    if (!options?.resolveOffPeakClientConfig || !options.resolveOffPeakTaskService) return false;
    if (params.remoteSessionId) return false;
    return !params.workspaceIdentity || !isRemoteWorkspaceIdentity(params.workspaceIdentity);
  }

  /**
   * 服务端「提供」（docs/dynamic-workflow/launch.md「Gray release」）：Host 读取一次并在本进程内固定。
   * 三点理由：
   *   1. 判定落在 client 就绪路径上，不能每次建会话都等远端——3.12.2 已因此回归过一次；
   *   2. 读取失败 fail-closed 且不再重试，避免离线时每条 create 都赔上一次请求超时；
   *   3. 服务端翻转灰度按设计在下一个 Host 进程生效（provider 侧另有 1h 快照与 forceRefresh）。
   * 与 Off-Peak 不同：远程 workspace 同样可用，所以这里不看 workspaceIdentity / remoteSessionId。
   */
  function resolveDynamicWorkflowOffer(): Promise<DynamicWorkflowClientConfig | undefined> {
    const resolve = options?.resolveDynamicWorkflowClientConfig;
    if (!resolve) return Promise.resolve(undefined);
    mutable.dynamicWorkflowOffer ??= (async () => {
      try {
        return await resolve();
      } catch (error) {
        logger.warn(undefined, "动态工作流灰度读取失败，按关闭处理", {
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    })();
    return mutable.dynamicWorkflowOffer;
  }

  /** 用户选择（launch.md「The user's choice」）：本机设置权威每次现读；否则用 desktop 推来的值。 */
  async function resolveDynamicWorkflowUserMode(): Promise<DynamicWorkflowMode | undefined> {
    const read = options?.resolveDynamicWorkflowUserMode;
    if (!read) return mutable.pushedDynamicWorkflowUserMode;
    try {
      return normalizeDynamicWorkflowMode(await read());
    } catch (error) {
      // 设置读失败不能把功能关掉，也不能阻断建会话：按「跟随服务端」处理。
      logger.warn(undefined, "动态工作流用户选择读取失败，按跟随服务端处理", {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * 生效模式 = 闩住的「提供」+ 此刻的用户选择。策略同步与三条创建路径同源调用，所以不会出现
   * "策略说开、create 说关"的裂口；选择不闩，改设置后下一次建会话立刻拿到新值。
   * `onDemand` 原样送到 CLI：它决定十个工具是首请求就注册还是等首次 `/workflow`。
   *
   * 用户选择永远生效（launch.md「The user's choice」）：提供读取失败或拿不到值时按默认 disabled
   * 处理，再套用户选择——过去这里直接返回 disabled，离线启动的 Host 会连用户明确打开的功能一起关掉。
   * 没装配 resolver 的 Host 不接这个功能，选择不生效。
   */
  async function resolveDynamicWorkflowGate(): Promise<DynamicWorkflowMode> {
    if (!options?.resolveDynamicWorkflowClientConfig) return "disabled";
    const offer =
      (await resolveDynamicWorkflowOffer()) ??
      createDynamicWorkflowClientConfig(DEFAULT_DYNAMIC_WORKFLOW_MODE, "default");
    return applyDynamicWorkflowUserMode(offer, await resolveDynamicWorkflowUserMode()).mode;
  }

  /**
   * 把生效模式同步给一个 workspace 的 CLI（launch.md「The user's choice」）。同一 workspace 串行：
   * 每一步在执行时才读生效模式，后入队的步骤必然读到更新的选择，慢请求不会在新结论之后落地。
   * 与 CLI 已持有的策略相同就不发；关闭时发 enabled:false，让在线 CLI 的斜杠目录去掉 workflow。
   */
  function enqueueDynamicWorkflowPolicySync(entry: ActiveWorkspaceClient): Promise<void> {
    const workspaceKey = resolveWorkspaceKey(entry.workspace);
    const previous = dynamicWorkflowPolicySyncByWorkspaceKey.get(workspaceKey) ?? Promise.resolve();
    const current = previous.then(async () => {
      const mode = await resolveDynamicWorkflowGate();
      if (mode === entry.dynamicWorkflowPolicyMode) return;
      const enabled = isDynamicWorkflowModeEnabled(mode);
      try {
        await entry.client.request(
          zcodeProtocolMethods.workspaceUpdateDynamicWorkflowPolicy,
          // mode 与布尔同行（launch.md「On demand: activation」）；只认布尔的旧 CLI 的 strict
          // schema 会拒绝 mode，走下面的 warn 分支保持缺省关闭——与其它非 -32601 错误同判。
          {
            workspace: buildWorkspaceRef(entry.workspace),
            enabled,
            ...(enabled ? { mode } : {}),
          },
          zcodeWorkspaceUpdateDynamicWorkflowPolicyResultSchema,
        );
        entry.dynamicWorkflowPolicyMode = mode;
      } catch (error) {
        // 与 Off-Peak 同判据：-32601 是旧 CLI 的正常降级（其 z.object 也会丢掉 session flag，
        // 整体退回 disabled）；其它错误只记 warn，不阻断客户端就绪。
        if (!isProtocolMethodNotFoundError(error)) {
          logger.warn(undefined, "动态工作流策略同步失败，CLI 维持原策略", {
            workspaceKey,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });
    dynamicWorkflowPolicySyncByWorkspaceKey.set(workspaceKey, current);
    return current;
  }

  /** 三条创建路径共用：布尔 + mode 的下发对（关闭时两者都缺席）。 */
  async function resolveDynamicWorkflowSessionFlags(): Promise<{
    dynamicWorkflowEnabled: boolean;
    dynamicWorkflowMode?: DynamicWorkflowMode;
  }> {
    const mode = await resolveDynamicWorkflowGate();
    return isDynamicWorkflowModeEnabled(mode)
      ? { dynamicWorkflowEnabled: true, dynamicWorkflowMode: mode }
      : { dynamicWorkflowEnabled: false };
  }

  async function buildConversationCommandEnvelope(
    params: ZCodeAgentConversationCommandParams,
  ): Promise<CommandEnvelope> {
    const envelope = params.envelope;
    if (envelope.type === "createSession") {
      const { dynamicWorkflowEnabled, dynamicWorkflowMode } =
        await resolveDynamicWorkflowSessionFlags();
      const payload = commandPayloadSchemas.createSession.parse(envelope.payload);
      const sessionId =
        params.projectId !== undefined || options?.prepareSessionCreation
          ? `session_${createHash("sha256")
              .update(
                JSON.stringify([
                  resolveWorkspaceKey(params),
                  envelope.clientId,
                  envelope.commandId,
                ]),
              )
              .digest("hex")
              .slice(0, 32)}`
          : payload.sessionId;
      const additionalDirectories =
        params.projectId !== undefined || options?.prepareSessionCreation
          ? await options?.prepareSessionCreation?.({
              ...params,
              sessionId: sessionId!,
              projectId: params.projectId ?? null,
              additionalDirectories: payload.additionalDirectories,
            })
          : payload.additionalDirectories;
      if (params.projectId !== undefined && !options?.prepareSessionCreation)
        throw new Error("project.creation-unavailable");
      const offPeakToolEnabled = isOffPeakToolSupported(params);
      return {
        ...envelope,
        payload: {
          ...payload,
          ...(dynamicWorkflowEnabled ? { dynamicWorkflowEnabled: true, dynamicWorkflowMode } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(additionalDirectories !== undefined ? { additionalDirectories } : {}),
          ...(offPeakToolEnabled ? { offPeakToolEnabled: true } : {}),
        },
      };
    }
    if (envelope.type !== "sendText") return envelope;

    const payload = commandPayloadSchemas.sendText.parse(envelope.payload);
    // 读取持久化 cronAutomationId 后不能把整个绑定会话永久视为 automation
    // 执行上下文。用户后续主动输入也因此丢失 CronUpdate/CronDelete。这里只认本轮 payload；
    // automation runId 漏传 payload 的兼容识别由 CLI 的 resolveTurnAutomationId 兜底。
    if (payload.automationId) {
      // desktop continuous 的 automation 派发不一定经过 task adapter；在协议信封处合并本轮
      // denylist，且不覆盖调用方已有策略。
      return {
        ...envelope,
        payload: {
          ...payload,
          toolDisallowlist: mergeAutomationMutationToolDenylist(payload.toolDisallowlist ?? []),
        },
      };
    }
    if (payload.offPeakTaskId) {
      // 闲时派发轮同型纵深——只 deny OffPeakCreate（OffPeakList 只读保留）。
      return {
        ...envelope,
        payload: {
          ...payload,
          toolDisallowlist: mergeOffPeakMutationToolDenylist(payload.toolDisallowlist ?? []),
        },
      };
    }
    return envelope;
  }

  return {
    handleProviderReadinessChanged,
    unsubscribeV4Route,
    resyncV4Route,
    rememberSessionTrace,
    getSessionTraceId,
    createProviderNotReadyError,
    isProviderNotReadyError,
    resolveStartupReadiness,
    isReusableActiveClientEntry,
    getOrStartReadOnlyClient,
    getClient,
    startModelExecutionClient,
    getReadOnlyClient,
    getPluginManagementClient,
    isLocalActiveWorkspaceClient,
    resolveGlobalSavedWorkflowCarrier,
    resolveSavedWorkflowCarrier,
    getMcpStatusClient,
    disposeLocalState,
    isOffPeakToolSupported,
    resolveDynamicWorkflowOffer,
    resolveDynamicWorkflowUserMode,
    resolveDynamicWorkflowGate,
    enqueueDynamicWorkflowPolicySync,
    resolveDynamicWorkflowSessionFlags,
    buildConversationCommandEnvelope,
  };
}

export type ZCodeAgentServiceClientAccessHelpers = ReturnType<typeof createClientAccessHelpers>;
