import { resolveToolSearchMode } from "../../tool/search/exposure.js";
import type {
  CollaborationMode,
  ExecutionShellSelection,
  Model,
  ModelSelection,
  ModelToolContract,
  PermissionBrokerRequest,
  ProjectId,
  SessionEvent,
  SessionEventSink,
  SessionEventStorePort,
  SessionId,
  SessionProjection,
  TraceContext,
  ToolExecutor,
  ToolRegistry,
  ContextBuilder,
} from "../deps.js";
import { isInspectablePermissionBroker, projectIdFromDirectory } from "../helpers/index.js";
import {
  deriveChildClientPorts,
  type ChildClientPortsContext,
  type ClientFacingPorts,
} from "../helpers/child-client-ports.js";
import type { AgentRuntimeConfig, ActiveTurnInfo } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { cloneModelSelection } from "../model-selection.js";
import { applyRuntimeExecutionState } from "../execution-state.js";

import { mirrorSubagentInteractionEvent } from "../../subagent/tool-event-mirror.js";
import { orderProviderVisibleToolContracts } from "../../tool/provider-visible-order.js";
import { projectToolModelContract } from "../../tool/model-contract.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import { filterEmbeddedSearchRuntimeVisibleTools } from "./embedded-search-branch.js";
import {
  getSessionShellSelection as readSessionShellSelection,
  initializeSessionShellEnvironmentIfNeeded as initializeSessionShellEnvironment,
  type SessionShellEnvironmentCandidate,
} from "./session-shell-environment.js";

export async function setExecutionState(
  this: AgentRuntimeInternal,
  input: { mode?: string; planEnabled?: boolean },
  traceContext?: TraceContext,
): Promise<void> {
  await applyRuntimeExecutionState(this, input, { source: "command", traceContext });
}

export function updateConfig(
  this: AgentRuntimeInternal,
  patch: Pick<AgentRuntimeConfig, "mode" | "planEnabled" | "language" | "outputStyle">,
): void {
  if (patch.mode !== undefined || patch.planEnabled !== undefined) {
    const previous = resolveExecutionState(this.config);
    const next = resolveExecutionState(patch, previous);
    Object.assign(this.config, next);
    if (previous.planEnabled !== next.planEnabled)
      this.needsPlanModeExitReminder = !next.planEnabled;
  }
  if (patch.language !== undefined) {
    this.config.language = patch.language;
    if (!this.activeTurn) {
      rebuildContextPrefix(this);
    }
  }
  if ("outputStyle" in patch) {
    this.config.outputStyle = patch.outputStyle;
    if (!this.activeTurn) {
      rebuildContextPrefix(this);
    }
  }
}

export function initializeSessionShellEnvironmentIfNeeded(
  this: AgentRuntimeInternal,
  selection: SessionShellEnvironmentCandidate,
): boolean {
  return initializeSessionShellEnvironment(this, selection);
}

export function getSessionShellSelection(
  this: AgentRuntimeInternal,
): ExecutionShellSelection | undefined {
  return readSessionShellSelection(this);
}

export function getMode(this: AgentRuntimeInternal): CollaborationMode {
  return this.config.mode ?? "build";
}

export function getPlanEnabled(this: AgentRuntimeInternal): boolean {
  return resolveExecutionState(this.config).planEnabled;
}

export function getSessionModelSelection(this: AgentRuntimeInternal): ModelSelection | undefined {
  return this.sessionModelSelection && cloneModelSelection(this.sessionModelSelection);
}

export function setSessionModelSelection(
  this: AgentRuntimeInternal,
  selection: ModelSelection | undefined,
  options?: { reasoningLevelExplicit?: boolean },
): void {
  const previous = this.sessionModelSelection;
  // 恢复/配置刷新可以清除失效选择；未绑定不应借用默认模型，也不影响正在执行的 Active Model。
  this.sessionModelSelection = selection && cloneModelSelection(selection);
  // Явность — отдельное состояние, иначе persisted default `max` навсегда выключает auto.
  // Internal callers (submission admission, off-peak, resume) передают флаг явно; внешние
  // setter-вызовы bootstrap — это `/effort`/`/model`, где level уже выбран пользователем.
  if (options?.reasoningLevelExplicit !== undefined) {
    this.reasoningLevelExplicit = options.reasoningLevelExplicit;
    return;
  }
  if (!selection) {
    this.reasoningLevelExplicit = false;
    return;
  }
  const modelChanged =
    !previous ||
    previous.providerId !== selection.providerId ||
    previous.modelId !== selection.modelId;
  // Смена модели приносит default/resolved level новой модели — это не пользовательский пин.
  this.reasoningLevelExplicit = !modelChanged && selection.options?.reasoningLevel !== undefined;
}

export function getProjectId(this: AgentRuntimeInternal): ProjectId {
  // Bash cd 会改变执行 cwd，但 project identity 不能随工具内 cwd 漂移。
  return projectIdFromDirectory(this.workspaceRoot);
}

export function setWorkingDirectory(this: AgentRuntimeInternal, cwd: string): void {
  // Bash cwd 持久化只应影响当前 runtime 会话，不能改变工作区身份。
  this.workingDirectory = cwd;
}

export async function ensureSessionPersistedForExternalActivity(
  this: AgentRuntimeInternal,
  input: string,
  options?: { traceContext?: TraceContext },
): Promise<void> {
  await this.ensureSessionPersisted(input, options?.traceContext ?? this.rootTraceContext);
}

export function getActiveTurnInfo(this: AgentRuntimeInternal): ActiveTurnInfo | undefined {
  const activeTurn = this.activeTurn;
  if (!activeTurn) return undefined;
  return {
    kind: activeTurn.kind,
    ...(activeTurn.inputId === undefined ? {} : { inputId: activeTurn.inputId }),
    queueLength: activeTurn.pendingInputs.length,
    steerable: activeTurn.steerable,
    turnId: activeTurn.turnId,
  };
}

export function getTools(this: AgentRuntimeInternal, model?: Model): ModelToolContract[] {
  if (this.cachedTools === null) {
    this.cachedTools = filterRuntimeVisibleTools.call(this, this.registry.toContracts());
  }
  return this.cachedTools
    .filter(
      (tool) =>
        (tool.name !== "ToolSearch" && tool.name !== "DeferredToolCall") ||
        !model ||
        resolveToolSearchMode(model, this.config.toolSearch?.mode) !== "off",
    )
    .filter(
      (tool) =>
        tool.name !== "WebSearch" ||
        // 无 Model 只枚举完整注册表（供 registry inventory / 能力清单使用）；能力事实必须由
        // 调用方传入 Active Model。展示/持久化元数据请走 getMetadataTools。
        model === undefined ||
        modelSupportsNativeWebSearch(model),
    )
    .map((tool) =>
      projectToolModelContract(tool, this.registry.get(tool.name), {
        model,
      }),
    );
}

/**
 * 非 provider-visible 的工具元数据枚举（持久化 tools 映射、swarm planner、UI / 子代理能力清单）。
 *
 * 与 {@link getTools} 共用同一份缓存注册表和模型投影，唯一差别是条件工具 WebSearch：
 * 没有 Active Model 时无法证明模型支持原生检索，元数据必须按「不可用」处理，不能把完整
 * 注册表当成能力事实。持有本轮/子会话 Model 的调用方必须传入，过滤结果与 provider-visible
 * 路径保持一致（supportsNativeWebSearch === true 才出现）。
 */
export function getMetadataTools(
  this: AgentRuntimeInternal,
  model?: Model,
): ModelToolContract[] {
  // 走 runtime 的公开 getTools 方法而不是直接调用实现：局部 runtime 桩/子类覆盖仍是唯一入口，
  // 元数据与 provider-visible 不会各自维护一套 registry 过滤。
  return this.getTools(model).filter(
    (tool) => tool.name !== "WebSearch" || modelSupportsNativeWebSearch(model),
  );
}

/**
 * WebSearch 的唯一能力判据：只有明确的 supportsNativeWebSearch === true 才算可用。
 * 缺席 Model 代表「未知」，绝不能推断为可用。
 */
export function modelSupportsNativeWebSearch(model: Model | undefined): boolean {
  return model?.properties.supportsNativeWebSearch === true;
}

export function invalidateToolCache(this: AgentRuntimeInternal): void {
  this.cachedTools = null;
}

export function getToolRegistry(this: AgentRuntimeInternal): ToolRegistry {
  return this.registry;
}

export function getToolExecutor(this: AgentRuntimeInternal): ToolExecutor {
  return this.executor;
}

export function subscribeEvents(this: AgentRuntimeInternal, sink: SessionEventSink): () => void {
  this.eventSinks.add(sink);
  return () => {
    this.eventSinks.delete(sink);
  };
}

/**
 * 外部子 runtime 的接缝（一）：交出本 runtime 的会话事件 store。
 *
 * 在 class 外构造的子 runtime（bootstrap 的 dwf actor / legacy script workflow）必须与父
 * runtime 共享同一个 store，否则子会话事件只落在一个谁都读不到的私有 store 里，v4 的
 * `loadPersistedEvents(childSessionId)` 恒为空——transcript 永久空白。子事件仍按子自己的
 * sessionId 落库，两条会话在同一个 store 里互不覆盖（`subagent.ts:280` 的
 * `eventStore: this.eventStore` 是同一条约定）。
 */
export function getSessionEventStore(this: AgentRuntimeInternal): SessionEventStorePort {
  return this.eventStore;
}

/**
 * 外部子 runtime 的接缝（二）：把子会话的原始事件扇出给本 runtime 的外部 sink 集。
 *
 * 语义与 `subagent.ts:338` 的 `notifyEventSinks(event, {...trace, sessionId: childSessionId})`
 * 完全一致：保留子 sessionId（协议层按它路由到 detached live session），只通知、不 append。
 *
 * 子 runtime 必须在**构造期**把这个调用装成自己的 `deps.eventSink`：
 * `ensureSessionPersistedForExternalActivity` 把 SessionTitleUpdated 写成 sequenceNumber 1，
 * 而 v4 网关只排水连续 seq——构造之后才挂的订阅从 seq 2 起，会永远等一个再也不会来的 seq 1。
 */
export async function notifyExternalChildSessionEvent(
  this: AgentRuntimeInternal,
  input: {
    childSessionId: SessionId;
    event: SessionEvent;
    traceContext?: TraceContext;
    interactionOrigin?: ChildClientPortsContext;
  },
): Promise<void> {
  const traceContext = input.traceContext ?? this.rootTraceContext;
  // 只通知、绝不 append：子 runtime 已经按自己的 sessionId 把这条事件落库了，
  // 再走父 runtime 的 append 链路会造成同一事件在共享 store 里出现两份。
  await this.notifyEventSinks(input.event, { ...traceContext, sessionId: input.childSessionId });
  if (input.interactionOrigin === undefined) return;
  // Bug 根因（2026-09-23 实机）：guarded dwf actor 的权限请求经父 broker 到了桌面，但 V4 的
  // 确认窗只从**父会话**实时投影的 PermissionRequested 生成；这条事件只在子会话里，窗不出现，
  // actor 永久等待。与 core subagent 同款镜像（只镜像交互，父 timeline 不收工具活动），同样只通知不 append。
  const mirrored = mirrorSubagentInteractionEvent(input.event, {
    ...input.interactionOrigin,
    parentSessionId: this.sessionId,
  });
  if (mirrored === undefined) return;
  await this.notifyEventSinks(mirrored, { ...traceContext, sessionId: this.sessionId });
}

/**
 * 外部子 runtime 的接缝（三）：铸造子 runtime 的**对外交互**端口。
 *
 * 子 runtime 的账本身份（子 sessionId）不是协议客户端能应答的身份。dwf actor 与 legacy
 * workflow child 过去直接从 `appOptions` 取 `providerRuntimeHeadersPort` / `permissionBroker`，
 * 于是带着 `sess_dwf-…`去问桌面；桌面回包路径上的 `requireSession` 抛错、response 永不发出，
 * 子代理在首个模型请求前永久挂起（8 个子代理、80 分钟无任何事件）。core 内建 subagent 当时靠
 * 两个私有 wrapper 绕开，三处装配两错一对——说明规则散落在调用点就一定会漂。
 *
 * 修法：派生收敛到 `deriveChildClientPorts`，且只能由**父 runtime** 调用——`parentSessionId`
 * 由父自己填，调用方给不了错的值。任何在 class 外构造子 runtime 的装配（dwf actor、legacy
 * workflow child）必须经这里取端口。
 */
export function createChildClientPorts(
  this: AgentRuntimeInternal,
  context: ChildClientPortsContext,
): ClientFacingPorts {
  return deriveChildClientPorts(
    {
      ...(this.permissionBroker === undefined ? {} : { permissionBroker: this.permissionBroker }),
      ...(this.providerRuntimeHeadersPort === undefined
        ? {}
        : { providerRuntimeHeadersPort: this.providerRuntimeHeadersPort }),
    },
    { ...context, parentSessionId: this.sessionId },
  );
}

export function getContextBuilder(this: AgentRuntimeInternal): ContextBuilder {
  if (!this.contextBuilder) {
    this.contextBuilder = this.createContextBuilderFromSnapshot(
      this.createConfigOnlyContextSnapshot(this.workingDirectory),
      undefined,
      { persistEnvInfo: false },
    );
  }
  // 这个 getter 只能提供同步预览 builder，不能初始化 messageHistory。
  // 否则首轮 executeTurn 会跳过异步 context source 解析，导致真实 workspace context 丢失。
  return this.contextBuilder;
}

export function getPendingPermissionRequests(
  this: AgentRuntimeInternal,
): PermissionBrokerRequest[] {
  if (!isInspectablePermissionBroker(this.permissionBroker)) return [];
  return this.permissionBroker.listPendingRequests();
}

export async function getProjection(this: AgentRuntimeInternal): Promise<SessionProjection> {
  return this.rebuildProjection();
}

export function getSessionId(this: AgentRuntimeInternal): SessionId {
  return this.sessionId;
}

function filterRuntimeVisibleTools(
  this: AgentRuntimeInternal,
  tools: ModelToolContract[],
): ModelToolContract[] {
  const visibleTools = filterEmbeddedSearchRuntimeVisibleTools(this, tools);
  // provider-visible 工具顺序属于最终输出边界；toolset 只决定可见工具集合。
  return orderProviderVisibleToolContracts(visibleTools);
}

import { resolveExecutionState } from "@zcode/shared";
