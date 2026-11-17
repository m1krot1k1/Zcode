import {
  configureOffPeakRuntime,
  controlOffPeakRuntime,
} from "./off-peak/runtime.js";
import {
  createTurnAgentDefinitions,
  createAgentDefinitionsReader,
  type GetAgentDefinitions,
} from "../subagent/definitions.js";
import { WORKER_SUBAGENT_TOOL_NAMES } from "../subagent/profile.js";
import {
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  resolveExecutionState,
} from "@zcode/shared";

import type { McpServerConfig, PluginReferenceCatalog } from "@zcode/contracts";
import {
  createDenyPermissionBroker,
  createRootTraceContext,
  createToolRegistry,
  defaultPermissionConfig,
  EventReducer,
  MessageHistoryImpl,
  PermissionService,
  ToolScheduler,
  traceContextToLogContext,
} from "./deps.js";
import type { Logger, MessageId, ModelSelection, ModelToolContract, PermissionBrokerPort, SessionEventSink, SessionEventStorePort, SessionId, SessionStorePort, ContextSourcePort, ExecutionPort, FileSystemPort, CodeIntelligencePort, ImageProcessorPort, PdfDocumentPort, McpConnectionSnapshot, SkillLoadOutcome, SkillPort, CapabilityInstallPort, McpPort, DynamicWorkflowRunPort, ModelCatalogPort, SubagentPort, ToolArtifactStorePort, TraceContext, MessageHistory, ReadFileStateMap, ToolExecutor, ToolRegistry, ContextBuilder, ContextBuildResult, ContextSourceSnapshot, HookRunner, TurnId } from "./deps.js";
import { installAgentRuntimeMethods } from "./methods/index.js";

import { createRuntimeCommandQueue } from "./command-queue.js";
import type { RuntimeCommandQueue } from "./command-queue.js";

import { initializeRuntimeTooling } from "./helpers/runtime-tools.js";
import {
  createFileLockRegistry,
  createFileTransactionTaskRegistry,
  type IFileLockRegistry,
  type IFileTransactionTaskRegistry,
} from "../tool/file-transaction/index.js";
import {
  resolveInitialDynamicWorkflowToolsActivated,
  type DynamicWorkflowActivationSource,
} from "./methods/dynamic-workflow-activation.js";
import type { ActiveForegroundExecutionState, ActiveTurnStartReservation, ActiveTurnSteeringState, AgentRuntimeConfig, AgentRuntimeDeps, ForegroundPromotionLeaseState, PendingModelChangeTimeline, MainTurnCacheHitAggregate, RuntimeTurnFileChangeMap } from "./types.js";
import type { AgentRuntimeInternal } from "./internal.js";
import {
  InMemoryRuntimeTaskRegistry,
  type RuntimeTaskRegistry,
} from "../runtime-task/registry.js";
import type { WorkflowBlockedReminderClock } from "../runtime-task/workflow-blocked-reminder.js";
import { createWorkflowBlockedReminder } from "./methods/dynamic-workflow-blocked-reminder.js";
import { createMemoryRecallState } from "../memory/recall/index.js";
import type { MemoryRecallState } from "../memory/recall/index.js";

import type { ProjectMemoryRecallPrefetch } from "./helpers/project-memory-recall.js";
import type { ProjectMemoryExtractionScheduler } from "./helpers/project-memory-extraction.js";
import type { ProjectMemoryUpdate } from "./helpers/project-memory-dream.js";
import { projectPersistentAgentMemoryTools } from "../subagent/persistent-memory.js";
import { RuntimeTelemetryFacade } from "../telemetry/runtime-telemetry.js";
import type { WorkspaceHookRuntimeAdmissionPort } from "../hooks/workspace-hook-runtime-admission.js";
import { disposeNodeReplSession } from "../tool/handlers/node-repl.js";
import { cloneModelSelection } from "./model-selection.js";
import type { AgentRuntimeSurface } from "./agent-runtime-surface.js";

// oxlint-disable typescript-eslint/no-unsafe-declaration-merging
export class AgentRuntime {
  getCapabilityInstallPort(): CapabilityInstallPort | undefined {
    return this.capabilityInstallPort;
  }

  /** Перечитать agent profiles после factory/plugin refresh, не дожидаясь нового turn. */
  async reloadAgentDefinitions(input: {
    signal: AbortSignal;
    traceContext: TraceContext;
  }): Promise<void> {
    await this.reloadDefinitions(input);
  }

  /**
   * Применить live plugin data-plane: подключить новые MCP server, отключить
   * удалённые plugin-owned server и обновить plugin catalog. Hooks/commands/UI
   * сюда не входят.
   */
  async applyPluginRuntime(input: {
    mcpServers: Record<string, McpServerConfig>;
    /** Только новые/изменённые server; существующие failed servers не переподключаем. */
    connectMcpServers?: Record<string, McpServerConfig>;
    previousPluginMcpServerNames?: readonly string[];
    preservedMcpServerNames?: readonly string[];
    pluginReferenceCatalog?: PluginReferenceCatalog;
    reloadAgentDefinitions?: boolean;
    signal: AbortSignal;
    traceContext: TraceContext;
  }): Promise<{
    connected: string[];
    disconnected: string[];
    failed: Array<{ name: string; error: string }>;
  }> {
    const previous = new Set(input.previousPluginMcpServerNames ?? []);
    const preserved = new Set(input.preservedMcpServerNames ?? []);
    const currentServers = this.config.mcp?.servers ?? {};
    const nextNames = new Set(Object.keys(input.mcpServers));
    const removed = [...previous].filter(
      (name) => !nextNames.has(name) && !preserved.has(name),
    );
    const toConnect = input.connectMcpServers ?? input.mcpServers;
    const connected: string[] = [];
    const disconnected: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];

    if (this.mcpPort) {
      const statuses = await this.mcpPort.status();
      for (const [name, pluginConfig] of Object.entries(toConnect)) {
        if (preserved.has(name) || statuses[name]?.status === "connected") continue;
        const config = currentServers[name] ?? pluginConfig;
        try {
          const status = await this.mcpPort.connectServer(name, config, {
            signal: input.signal,
            trace: input.traceContext,
            workingDirectory: this.workingDirectory,
            ...(this.config.workspaceIdentity
              ? { workspaceIdentity: this.config.workspaceIdentity.toString() }
              : {}),
          });
          if (status.status === "connected") {
            connected.push(name);
          } else {
            failed.push({
              name,
              error: status.error ?? `status=${status.status}`,
            });
          }
        } catch (error) {
          failed.push({
            name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      for (const name of removed) {
        try {
          await this.mcpPort.disconnectServer(name);
          disconnected.push(name);
        } catch (error) {
          failed.push({
            name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const merged = { ...input.mcpServers, ...currentServers };
    for (const name of removed) delete merged[name];
    this.config.mcp = { ...this.config.mcp, enabled: true, servers: merged };
    if (input.pluginReferenceCatalog) {
      this.config.pluginReferenceCatalog = input.pluginReferenceCatalog;
    }
    if (connected.length > 0 || disconnected.length > 0) {
      this.invalidateToolCache();
    }
    if (input.reloadAgentDefinitions) {
      await this.prepareAgentDefinitions({
        signal: input.signal,
        traceContext: input.traceContext,
      });
    }
    return { connected, disconnected, failed };
  }

  controlOffPeakExecution(
    input: import("@zcode/shared").OffPeakControlParams,
  ): Promise<import("@zcode/shared").OffPeakControlResult> {
    return controlOffPeakRuntime(
      this as unknown as import("./internal.js").AgentRuntimeInternal,
      input,
    );
  }
  private sessionId: SessionId;
  private turnNumber: number;
  private config: AgentRuntimeConfig;
  private appVersion: string;
  private permissionService: PermissionService;
  private permissionBroker: PermissionBrokerPort;
  private toolScheduler: ToolScheduler;
  private eventReducer: EventReducer;
  private eventStore: SessionEventStorePort;
  private rootTraceContext: TraceContext;
  private logger?: Logger;
  private eventSinks = new Set<SessionEventSink>();
  private now: () => Date;
  private isRemoteWorkspace: () => boolean;
  private registry: ToolRegistry;
  private executor: ToolExecutor;
  private hookRunner?: HookRunner;
  private workspaceHookAdmission?: WorkspaceHookRuntimeAdmissionPort;
  private modelFactory: AgentRuntimeDeps["modelFactory"];
  private modelIoDir?: string;
  private providerRuntimeHeadersPort?: AgentRuntimeDeps["providerRuntimeHeadersPort"];
  private browserControlPort?: AgentRuntimeDeps["browserControlPort"];
  /** 模型请求准入端口；随每次模型请求进调用上下文。 */
  private modelRequestAdmission?: AgentRuntimeDeps["modelRequestAdmission"];
  private sessionModelSelection: ModelSelection | undefined;
  private reasoningLevelExplicit = false;
  private messageHistory: MessageHistory;
  private readFileState: ReadFileStateMap;
  private cachedTools: ModelToolContract[] | null = null;
  /** launch.md「On demand: activation」：onDemand 会话出生为 false，`activateDynamicWorkflowTools` 翻为 true。 */
  private dynamicWorkflowToolsActivated: boolean;
  private dynamicWorkflowActivationSource?: DynamicWorkflowActivationSource;
  private contextBuilder: ContextBuilder | null = null;
  private contextInitialized = false;
  private contextSourceSnapshot?: ContextSourceSnapshot;
  private latestContextBuildResult?: ContextBuildResult;
  private memoryRoot?: string;
  private memoryIndexContent?: string;
  private memoryRecallState: MemoryRecallState;
  private memoryRecallPrefetch?: ProjectMemoryRecallPrefetch;
  private memoryExtractionScheduler?: ProjectMemoryExtractionScheduler;
  private memoryDreamLastScanAtMs = 0;
  private pendingMemoryUpdate?: ProjectMemoryUpdate;
  private contextSourcePort?: ContextSourcePort;
  private skillPort?: SkillPort;
  private capabilityInstallPort?: CapabilityInstallPort;
  private mcpPort?: McpPort;
  private mcpStartupPromise?: Promise<McpConnectionSnapshot>;
  private residencyBlockingWorkCount = 0;
  private mcpInitialized = false;
  private mcpToolsRegistered = false;
  private registeredMcpToolNames?: string[];
  private mcpToolsSignature?: string;
  private mcpToolListRevision?: number;
  private subagentPort?: SubagentPort;
  private readonly getAgentDefinitions: GetAgentDefinitions;
  private readonly prepareAgentDefinitions: ReturnType<
    typeof createTurnAgentDefinitions
  >["prepare"];
  private readonly reloadDefinitions: ReturnType<
    typeof createTurnAgentDefinitions
  >["reload"];
  private dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  private modelCatalogPort?: ModelCatalogPort;
  private runtimeTaskRegistry: RuntimeTaskRegistry;
  // 修复依据：只有本 runtime 创建的 registry 才归它 teardown；子 runtime 拿到的是共享实例。
  private readonly ownsRuntimeTaskRegistry: boolean;
  // 「run 还欠着决定、主代理闲着」的提醒钟；由命令队列的忙 / 闲沿驱动，beginShutdown 停掉。
  private workflowBlockedReminder: WorkflowBlockedReminderClock;
  private branchGeneration = 0;
  private artifactStore?: ToolArtifactStorePort;
  private executionPort?: ExecutionPort;
  private fileSystemPort?: FileSystemPort;
  private fileLockRegistry: IFileLockRegistry;
  private fileTransactionTaskRegistry: IFileTransactionTaskRegistry;
  private codeIntelligencePort?: CodeIntelligencePort;
  private imageProcessorPort?: ImageProcessorPort;
  private pdfDocumentPort?: PdfDocumentPort;
  private skillLoadOutcome?: SkillLoadOutcome;
  private workingDirectory: string;
  private workspaceRoot: string;
  private sessionStore?: SessionStorePort;
  private sessionPersisted = false;
  private sessionRowCreated = false;
  private needsPlanModeExitReminder = false;
  private latestConversationMessageId?: MessageId;
  private latestAssistantMessageId?: MessageId;
  private latestAssistantTurnId?: TurnId;
  private mainTurnCacheHitAggregate: MainTurnCacheHitAggregate = {
    requestCount: 0,
    totalInputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
  };
  private currentTurnFileChanges: RuntimeTurnFileChangeMap = new Map();
  private lastAssistantCompletedAtMs?: number;
  private lastEmittedLocalDate?: string;
  private autoCompactConsecutiveFailures = 0;
  private runtimeCommandQueue: RuntimeCommandQueue;
  private runtimeCommandDrainActive = false;
  private activeForegroundExecution?: ActiveForegroundExecutionState;
  /** sendQueuedNow 的 Core 调度权；只活在当前进程，匹配 runtime command 出队即消费。 */
  private foregroundPromotionLease?: ForegroundPromotionLeaseState;
  private activeTurn?: ActiveTurnSteeringState;
  private activeTurnStartReservation?: ActiveTurnStartReservation;
  private pendingInputSequence = 0;
  /** sendQueuedNow reservation；只活在当前 CLI 进程，防 drain/多端重复提升。 */
  private pendingInputReservations = new Map<string, string>();
  // v4 setAutoDrain：false 时排队输入不自动消费
  // （turn-stop 不续跑、roundtrip 间不 drain），保留成 held 供显式消费。
  private queueAutoDrain = true;
  // 暂停队列恢复后由 CLI 按投影 FIFO 逐项提升。这个窗口内禁止 core 只看当前
  // activeTurn.pendingInputs 做行内 drain，否则新入队消息会越过仍留在投影中的旧暂停项。
  private queueExternalDrainActive = false;
  private shuttingDown = false;
  private subagentShutdownPromise?: Promise<void>;
  private backgroundTaskNotificationsSealed = false;
  private backgroundTaskNotificationSealReason?:
    | "subagent_terminal"
    | "subagent_cancelled";
  private pendingModelChangeTimeline?: PendingModelChangeTimeline;
  private sessionStartHookRan = false;
  private sessionTitleGenerationAttempted = false;
  private agentTelemetry: RuntimeTelemetryFacade;

  constructor(
    sessionId: SessionId,
    config: AgentRuntimeConfig,
    deps: AgentRuntimeDeps,
  ) {
    const runtime = this as unknown as AgentRuntimeInternal;
    this.sessionId = sessionId;
    this.turnNumber = 0;
    // 3.12.2：兼容旧 Host/内部调用传入 legacy，但本版本 Runtime、日志和子 Agent 只使用 preflight。
    this.config = {
      ...config,
      modelContextBudgetStrategy: DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
      // Root получает право делегировать полный worker-набор. Router-дети
      // наследуют его явно в subagent.ts; read-only и worker-дети не получают
      // этот набор и пересекаются со своим фактическим tool surface.
      ...(config.delegationToolAllowlist === undefined && config.taskType !== "subagent_child"
        ? { delegationToolAllowlist: [...WORKER_SUBAGENT_TOOL_NAMES] }
        : {}),
    };
    Object.assign(this.config, resolveExecutionState(config));
    const definitions = createTurnAgentDefinitions(
      deps.getAgentDefinitions ??
        createAgentDefinitionsReader(this.config.subagents?.profiles ?? [], {
          builtInModelSelectionOverrides:
            this.config.subagents?.builtInModelSelectionOverrides,
        }),
      deps.loadAgentDefinitions,
      deps.reloadAgentDefinitions,
    );
    // Host 每轮加载的快照会替代启动配置；在统一读取出口补齐 Memory 工具，
    // 避免子 Agent 有持久记忆提示却没有 Write/Edit，也不回写原始配置。
    this.getAgentDefinitions = () =>
      projectPersistentAgentMemoryTools(definitions.get(), this.config.memory);
    this.prepareAgentDefinitions = definitions.prepare;
    this.reloadDefinitions = definitions.reload;
    this.agentTelemetry = new RuntimeTelemetryFacade({
      agentName: config.agentName,
      causation: deps.agentTelemetryCausation,
      causationMode: deps.agentTelemetryCausationMode,
      parentSessionId: config.parentSessionId,
      port: deps.agentTelemetry,
      sessionId,
      taskType: config.taskType,
    });
    this.permissionService =
      deps.permissionService ?? new PermissionService(defaultPermissionConfig);
    this.permissionBroker =
      deps.permissionBroker ?? createDenyPermissionBroker();
    this.toolScheduler =
      deps.toolScheduler ??
      new ToolScheduler({
        maxConcurrency: this.config.toolConcurrency?.maxConcurrency,
      });
    this.eventReducer = new EventReducer();
    this.eventStore = deps.eventStore;
    this.sessionStore = deps.sessionStore;
    this.rootTraceContext =
      deps.traceContext ?? createRootTraceContext({ sessionId });
    this.appVersion = deps.appVersion ?? "0.0.0";
    this.logger = deps.logger?.child({
      ...traceContextToLogContext(this.rootTraceContext),
      module: "core.runtime",
    });
    if (deps.eventSink) {
      this.eventSinks.add(deps.eventSink);
    }
    this.now = deps.now ?? (() => new Date());
    this.isRemoteWorkspace = deps.isRemoteWorkspace ?? (() => false);
    this.modelFactory = deps.modelFactory;
    this.modelIoDir = deps.modelIoDir;
    this.providerRuntimeHeadersPort = deps.providerRuntimeHeadersPort;
    this.browserControlPort = deps.browserControlPort;
    this.modelRequestAdmission = deps.modelRequestAdmission;
    configureOffPeakRuntime(
      this as unknown as import("./internal.js").AgentRuntimeInternal,
      deps.onOffPeakLifecycleEvent,
    );
    // 旧会话的选择缺失不能阻断历史恢复；不在这里制造默认模型。
    this.sessionModelSelection =
      config.modelSelection && cloneModelSelection(config.modelSelection);
    this.messageHistory = new MessageHistoryImpl();
    this.readFileState = deps.sharedReadFileState ?? new Map();
    this.memoryRecallState = createMemoryRecallState();
    this.runtimeCommandQueue = createRuntimeCommandQueue();
    this.workingDirectory = config.workingDirectory ?? ".";
    this.contextSourcePort = deps.contextSourcePort;
    this.contextSourceSnapshot = deps.initialContextSourceSnapshot
      ? structuredClone(deps.initialContextSourceSnapshot)
      : undefined;
    this.skillPort = deps.skillPort;
    this.capabilityInstallPort = deps.capabilityInstallPort;
    this.mcpPort = deps.mcpPort;
    if (deps.runtimeTaskRegistry) {
      this.runtimeTaskRegistry = deps.runtimeTaskRegistry;
      this.ownsRuntimeTaskRegistry = false;
    } else {
      this.runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry({ workLedger: deps.workLedger });
      this.ownsRuntimeTaskRegistry = true;
    }
    const branchOwnerSessionId = this.config.parentSessionId ?? sessionId;
    this.branchGeneration =
      this.runtimeTaskRegistry.getBranchGenerationForSession(
        branchOwnerSessionId,
      );
    this.runtimeTaskRegistry.setBranchGenerationForSession(
      sessionId,
      this.branchGeneration,
    );
    if (!this.config.parentSessionId)
      this.runtimeTaskRegistry.openSessionOwner(sessionId);
    this.workflowBlockedReminder = createWorkflowBlockedReminder(runtime);
    this.artifactStore = deps.artifactStore;
    this.executionPort = deps.executionPort;
    this.fileSystemPort = deps.fileSystemPort;
    this.fileLockRegistry = deps.fileLockRegistry ?? createFileLockRegistry();
    // Инкремент 4.2: единый владелец жизненного цикла фоновых файловых транзакций.
    // Реестр получает тот же FileLockRegistry, поэтому отмена задачи снимает её локи.
    this.fileTransactionTaskRegistry =
      deps.fileTransactionTaskRegistry ??
      createFileTransactionTaskRegistry({ lockRegistry: this.fileLockRegistry });
    this.codeIntelligencePort = deps.codeIntelligencePort;
    this.imageProcessorPort = deps.imageProcessorPort;
    this.pdfDocumentPort = deps.pdfDocumentPort;
    this.subagentPort =
      deps.subagentPort ?? runtime.createDefaultSubagentPort(deps);
    this.dynamicWorkflowRunPort = deps.dynamicWorkflowRunPort;
    // GUI「配置」解析子代理模型用的目录（与工具上下文拿的是同一个端口）。
    this.modelCatalogPort = deps.modelCatalogPort;
    this.registry = deps.toolRegistry ?? createToolRegistry();
    this.workspaceRoot = this.workingDirectory;
    // 必须先于工具装配：registerRuntimeBuiltInTools 的灰度门读的就是这个状态。
    this.dynamicWorkflowToolsActivated =
      resolveInitialDynamicWorkflowToolsActivated(this.config);
    const tooling = initializeRuntimeTooling(runtime, deps, sessionId);
    this.hookRunner = tooling.hookRunner;
    this.workspaceHookAdmission = deps.workspaceHookAdmission;
    this.executor = tooling.executor;

    this.contextBuilder = deps.contextBuilder ?? null;
    if (this.contextBuilder) {
      runtime.initializeMessageHistoryFromContext(
        this.contextBuilder,
        this.rootTraceContext,
      );
      this.contextInitialized = true;
    }
    runtime.startMcpStartup(this.rootTraceContext);
  }

  async closeBrowserSession(): Promise<void> {
    this.beginShutdown();
    disposeNodeReplSession(this.sessionId);
    await this.subagentShutdownPromise;
    try {
      await this.browserControlPort?.closeSession?.({
        sessionId: this.sessionId,
        traceContext: this.rootTraceContext,
      });
    } catch (error) {
      // browser backend 清理失败不能阻断 execution/MCP/session store 的主关闭链路。
      this.logger?.warn("Browser session cleanup failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "browser.session_cleanup.failed",
      });
    }
  }

  beginShutdown(): void {
    // ExecutionPort.close() 会把后台 Bash 收口为 cancelled；若允许
    // teardown terminal event 再唤醒模型，并与随后关闭的 session store 竞态。
    this.shuttingDown = true;
    // 修复依据：任务快照跨越整个 Agent 树共享，子 runtime teardown 必须由同一 registry
    // 同步封住 admission、取消本会话直接拥有的后台 children，并等待它们真实退出。
    this.subagentShutdownPromise ??= this.runtimeTaskRegistry
      .cancelSubagentChildren(
        this.sessionId,
        new Error(`Agent runtime is shutting down: ${this.sessionId}`),
      )
      .catch((error: unknown) => {
        this.logger?.warn("Subagent shutdown settlement failed", {
          error: error instanceof Error ? error.message : String(error),
          event: "subagent.shutdown.settlement_failed",
        });
      });
    // 同一条理由：会话在关，提醒钟不能再到点唤起一轮。
    this.workflowBlockedReminder.stop();
    // 修复依据：periodic work-ledger sweep 是 registry 自有的 unref setInterval；
    // root runtime 关闭时停掉，注入的共享 registry 由注入方负责。
    if (this.ownsRuntimeTaskRegistry) this.runtimeTaskRegistry.dispose?.();
    // 关闭单个 session 后进程仍存活，
    // 因此必须先终止该 runtime 的 Extraction，不能只在超时后放弃等待。
    this.memoryExtractionScheduler?.shutdown();
  }
}

/**
 * Публичная поверхность рантайма: члены объявлены в `agent-runtime-surface.ts`,
 * чтобы класс и его методы оставались в пределах `max-lines`.
 */
export interface AgentRuntime extends AgentRuntimeSurface {
  lastPermissionGrantId?: string;
}

installAgentRuntimeMethods(AgentRuntime);
