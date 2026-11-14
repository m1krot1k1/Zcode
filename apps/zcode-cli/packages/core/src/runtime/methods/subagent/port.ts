/**
 * Сборка SubagentPort: связывает parent runtime с child AgentRuntime, tool policy,
 * permission/MCP/skill preflight и activity watchdog.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SESSION_ENTRY_MODEL_SELECTION,
  SESSION_ENTRY_RUNTIME_TASK_TERMINAL,
  parseModelSelectionValue,
} from "@zcode/contracts";
import { inheritPermissionMode } from "@zcode/contracts";
import {
  defaultScheduler,
  PermissionService,
  defaultPermissionConfig,
  buildExploreAllowedTools,
  buildExploreAgentPrompt,
  createExploreSubagentPort,
  createCoreError,
  CoreErrorType,
} from "../../deps.js";
import type {
  ExploreSubagentRuntimeRequest,
  ModelSelection,
  SubagentPort,
} from "../../deps.js";
import { AgentRuntime } from "../../agent-runtime.js";
import type { AgentRuntimeInternal } from "../../internal.js";
import { cloneModelSelection } from "../../model-selection.js";
import { resolveSubagentSelection } from "../../helpers/subagent-selection.js";
import { resolveSubagentEffortLevel } from "../../helpers/subagent-effort.js";
import { sharedReadFileStateForChild } from "../../helpers/runtime-reminders.js";
import { deriveChildClientPorts } from "../../helpers/child-client-ports.js";
import type { AgentRuntimeDeps } from "../../types.js";
import { toMcpToolName } from "../../../mcp/index.js";
import {
  buildWorkLedgerEnvelopeBlock,
  heartbeatWorkClaim,
} from "../../../runtime-task/work-ledger-wire.js";
import { createSubagentMessageSink } from "../../../subagent/message-steering.js";
import {
  isMirroredSubagentEvent,
  mirrorSubagentToolEvent,
} from "../../../subagent/tool-event-mirror.js";
import {
  isBuiltInExploreAgentProfile,
  isDelegationRouterAgentType,
} from "../../../subagent/profile.js";
import { resolveEmbeddedSearchBranchCapability } from "../../../embedded-search/capability.js";
import { getSessionShellEnvironment } from "../session-shell-environment.js";
import { createCoordinatorResponsePort } from "../../../subagent/coordinator-response.js";
import { isStaleBranchRuntimeTaskEvent } from "../runtime-command-generation.js";
import { loadPersistentAgentMemory } from "../../../subagent/persistent-memory.js";
import { createOfficialCuaPolicy } from "../../../subagent/computer-use-policy.js";
import { computeOfficialCuaServerNames } from "../mcp.js";
import { persistRuntimeModelSelection, sameModelSelection } from "../turn-model.js";
import {
  getOffPeakExecution,
  markTemporaryRuntimeSelection,
} from "../../off-peak/runtime.js";
import {
  createRuntimeTaskTerminalCatalogEntry,
  readRuntimeTaskTerminalCatalogRecord,
  runtimeTaskSnapshotFromTerminalCatalog,
} from "../../../runtime-task/registry.js";
import { buildSpawnEnvelope, resolveSubagentTaskTimeoutMs } from "./spawn-envelope.js";
import {
  createInheritedSubagentModelFactory,
  createSubagentOverrideModelFactory,
  modelSelectionFromActiveModel,
} from "./model-factory.js";
import {
  resolveRuntimeDelegationToolNames,
  resolveSubagentToolAllowlist,
} from "./child-tool-policy.js";
import {
  isModelVisibleMcpToolName,
  resolveSubagentMcpAccess,
  validateSubagentMcpRequirements,
} from "./mcp-access.js";
import {
  resolveSubagentSkillPort,
  validateSubagentComputerUseConfiguration,
} from "./skill-port.js";
import { filterSubagentChildToolNames } from "../../../subagent/tool-policy.js";

export function createDefaultSubagentPort(
  this: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
): SubagentPort | undefined {
  if (this.config.subagents?.enabled === false) {
    return undefined;
  }
  const getParentToolNames = (): readonly string[] => [
    ...new Set([
      ...this.getTools().map((tool) => tool.name),
      ...resolveRuntimeDelegationToolNames(this),
    ]),
  ];
  return createExploreSubagentPort({
    logger: this.logger,
    maxParallel: this.config.subagentMaxParallel,
    inactivityTimeoutMs: this.config.subagents?.inactivityTimeoutMs,
    autoBackgroundMs: this.config.subagents?.autoBackgroundMs,
    outputRootDir: this.config.subagents?.outputRootDir,
    getAgentDefinitions: this.getAgentDefinitions,
    builtInModelSelectionOverrides: this.config.subagents?.builtInModelSelectionOverrides,
    runtimeTaskRegistry: this.runtimeTaskRegistry,
    persistTerminalTaskCatalog: async (task) => {
      const entry = createRuntimeTaskTerminalCatalogEntry(task);
      if (!entry || !deps.sessionStore?.saveSessionEntry) return false;
      await deps.sessionStore.saveSessionEntry(entry);
      return true;
    },
    resolveTerminalTaskCatalog: async (taskId) => {
      const sessionId = this.runtimeTaskRegistry.getRootSessionIdForSession(this.sessionId);
      const entries = await deps.sessionStore?.sessionEntries?.({
        sessionID: sessionId,
        type: SESSION_ENTRY_RUNTIME_TASK_TERMINAL,
        idPrefix: `runtime-task-terminal:${sessionId}:${taskId}:`,
      });
      if (!entries) return undefined;
      const records = entries
        .filter((entry) => entry.sessionID === sessionId)
        .map(readRuntimeTaskTerminalCatalogRecord)
        .filter((record): record is NonNullable<typeof record> => record?.taskId === taskId);
      const newestCompletion = Math.max(...records.map((record) => record.completedAt));
      const latestCandidates = records.filter((record) => record.completedAt === newestCompletion);
      if (latestCandidates.length > 1) {
        throw new Error(`Saved task has ambiguous terminal attempts: ${taskId}`);
      }
      const latest = latestCandidates[0];
      if (!latest) return undefined;
      const outputRootDir = this.config.subagents?.outputRootDir ?? join(tmpdir(), "zcode-agents");
      return runtimeTaskSnapshotFromTerminalCatalog(latest, sessionId, outputRootDir);
    },
    // Эффективная поверхность родителя: зарегистрированные built-ins ∪ делегируемый набор.
    // Getter обязателен: subagent port создаётся до инициализации tool registry, а MCP tools
    // регистрируются позже; eager-снимок терял бы фактическую поверхность.
    get parentToolNames() {
      return getParentToolNames();
    },
    // Per-role hard deadline; setting raises each role's minimum without shortening router headroom.
    getTaskTimeoutMs: (agentType) =>
      resolveSubagentTaskTimeoutMs(agentType, this.config.subagentTaskTimeoutMinutes),
    getChildEventCursor: (sessionId) => this.eventStore.getLatestSequenceNumber(sessionId),
    getChildEventsAfter: (sessionId, cursor) => this.eventStore.getEventsAfter(sessionId, cursor),
    emitParentEvent: async (event, traceContext) => {
      if (isStaleBranchRuntimeTaskEvent(this, event)) return;
      await this.appendEvent(event, traceContext);
    },
    enqueueParentTaskNotification: (notification) => {
      this.enqueueBackgroundTaskNotification({
        originMeta: notification.originMeta,
        taskId: notification.taskId,
        text: notification.text,
        traceContext: notification.traceContext,
      });
      return undefined;
    },
    getAllowedTools: () => {
      return buildExploreAllowedTools({
        embeddedSearchEnabled: resolveSubagentEmbeddedSearchEnabled(),
      });
    },
    runExploreAgent: async (request, options) => {
      const offPeak = getOffPeakExecution(this);
      const childBinding = offPeak?.createChildBinding();
      // Idle-выбор принадлежит исполнению до явного takeover. После завершения основной
      // фазы ticket binding уже недоступен, но возобновлённый SendMessage ребёнок обязан
      // остаться на idle-модели: selectionForChild отдаёт её без нового билета.
      if (offPeak) {
        const selection = offPeak.selectionForChild(this.getSessionModelSelection());
        if (selection)
          options = {
            ...options,
            modelOverride: {
              selection,
              ...(childBinding ? { requestDependencies: childBinding.requestDependencies } : {}),
              background: "allow",
            },
          };
      }
      try {
        request.reportActivity?.();
        const builtInExplore = isBuiltInExploreAgentProfile(request.profile);
        // Bug 原因：profile 的 injectAgentsMd=false 曾让 Explore 与后代失去项目规则；
        // 被接纳的 workspace 指令快照必须覆盖每个 subagent profile 的本地选择。
        const agentsMdInstructions =
          this.contextSourceSnapshot?.userInstructions ??
          this.config.subagentContext?.userInstructions;
        const workspaceRules =
          this.contextSourceSnapshot?.workspaceRules ?? this.config.subagentContext?.workspaceRules;
        const bundledHarnessRules =
          this.contextSourceSnapshot?.bundledHarnessRules ??
          this.config.subagentContext?.bundledHarnessRules;
        const parentSelection = this.getSessionModelSelection();
        const { selection: profileChildSelection, hasConcreteModel } = resolveSubagentSelection({
          profileSelection: request.profile.modelSelection,
          parentSelection,
          overrideSelection: options?.modelOverride?.selection,
          resolveSelection: deps.resolveEffectiveModelSelection,
        });
        const modelOverride = options?.modelOverride;
        const inheritedModel = !modelOverride && !hasConcreteModel ? options?.model : undefined;
        // Core Server override 优先于持久化 profile 与父模型继承，但仍只是标准 Selection。
        let childSelection = inheritedModel
          ? modelSelectionFromActiveModel(inheritedModel)
          : profileChildSelection;
        const embeddedSearchEnabled = resolveSubagentEmbeddedSearchEnabled();
        const baseChildEnvInfo = this.contextSourceSnapshot?.envInfo ??
          this.config.envInfo ?? {
            cwd: request.workingDirectory,
            platform: "unknown",
            shell: "unknown",
            osVersion: "unknown",
            nodeVersion: "unknown",
          };
        const shellEnvironment = getSessionShellEnvironment(this);
        const bashShellSelection = shellEnvironment?.selection;
        const childEnvInfo = {
          ...baseChildEnvInfo,
          ...(shellEnvironment ? { shell: shellEnvironment.promptShell } : {}),
        };
        const baseAgentPrompt =
          builtInExplore && request.systemPrompt?.trim() === ""
            ? buildExploreAgentPrompt({ embeddedSearchEnabled })
            : request.systemPrompt?.trim();
        const persistentMemory = await loadPersistentAgentMemory({
          fileSystemPort: deps.fileSystemPort,
          logger: this.logger,
          memory: this.config.memory,
          profile: request.profile,
          traceContext: request.traceContext,
          workspaceRoot: request.workspaceRoot,
        });
        // Host сообщает уровень рекурсии и конкурентную ёмкость, не ограничивая число задач.
        const spawnEnvelope = buildSpawnEnvelope({
          level: request.level,
          maxParallel: request.maxParallel,
        });
        // Реестр работ: предупреждаем ребёнка, чем заняты другие агенты в том же workspace.
        // Ошибка реестра не должна ломать спавн — пропадает только подсказка.
        let workLedgerBlock: string | undefined;
        try {
          workLedgerBlock = buildWorkLedgerEnvelopeBlock({
            ledger: this.runtimeTaskRegistry.workLedger,
            workspacePath: request.workspaceRoot || request.workingDirectory,
            agentId: request.agentId,
          });
        } catch (error) {
          this.logger?.warn("Work ledger envelope block failed", {
            agentId: request.agentId,
            error: String(error),
          });
        }
        // 空 agent prompt 不是一个语义段；先硬拼 `\n\n` 会把缺失段的边界
        // 泄漏到 persistent Memory 开头。这里只组合非空正文，block 左边界由 builder 统一添加。
        const agentPrompt = [
          spawnEnvelope,
          baseAgentPrompt,
          persistentMemory?.prompt,
          workLedgerBlock,
        ]
          .filter((part): part is string => typeof part === "string" && part.length > 0)
          .join("\n\n");
        const childRuntimeEnvInfo = {
          ...childEnvInfo,

          cwd: request.workingDirectory,
        };
        const officialCuaServerNames = computeOfficialCuaServerNames(
          this.config.mcp?.servers ?? {},
          new Set(this.config.mcp?.trustedOfficialCuaServerNames ?? []),
        );
        const preflightCuaPolicy = createOfficialCuaPolicy(
          officialCuaServerNames,
          [],
          this.config.pluginReferenceCatalog,
        );
        await validateSubagentComputerUseConfiguration(request, preflightCuaPolicy, this.skillPort);
        const childMcpAccess = await resolveSubagentMcpAccess.call(
          this,
          request,
          officialCuaServerNames,
        );
        const requestedMcpTools = filterSubagentChildToolNames(
          request.allowedTools.filter((toolName) => {
            const normalized = toolName.trim();
            return (
              isModelVisibleMcpToolName(normalized) &&
              (this.config.toolAllowlist === undefined ||
                this.config.toolAllowlist.includes(normalized))
            );
          }),
          this.config.toolDisallowlist,
        );
        // 修复依据：先按父级 allow/deny policy 保留显式 MCP 请求，再验证 startup snapshot；
        // 先构造 child toolset 会静默丢掉缺失 descriptor，让本应报错的子会话错误启动。
        validateSubagentMcpRequirements(
          { ...request, allowedTools: requestedMcpTools },
          requestedMcpTools,
          childMcpAccess,
        );
        // child Model 必须先于 allowlist 解析创建：WebSearch 是模型能力条件工具，child 能力
        // 清单（SubagentSpawned.allowedTools）只能按 child 自己的 Active Model 过滤。
        // 创建顺序前移只改变错误优先级，不改变其它 preflight 的语义。
        let baseChildModelFactory = modelOverride
          ? createSubagentOverrideModelFactory(modelOverride, this.modelFactory)
          : inheritedModel
            ? createInheritedSubagentModelFactory(childSelection, inheritedModel, this.modelFactory)
            : this.modelFactory;
        if (!baseChildModelFactory) {
          throw createCoreError(
            CoreErrorType.ConfigurationError,
            `Subagent model factory cannot resolve ${childSelection.providerId}/${childSelection.modelId}`,
            { recoverable: true },
          );
        }
        let childModel = baseChildModelFactory({ selection: childSelection });
        // Класс effort применяется после profile/parent/override резолва: модель остаётся
        // той же, меняется только уровень в её собственной шкале. Без поля поведение
        // не меняется вообще; абсолютный reasoningLevel из tool input не принимается.
        if (request.effort !== undefined) {
          const catalogEntries = this.modelCatalogPort?.listModels();
          const findCatalogEntry = (selection: typeof childSelection) =>
            catalogEntries?.find(
              (entry) =>
                entry.providerId === selection.providerId &&
                entry.modelId === selection.modelId &&
                entry.disabledReason === undefined,
            );
          const parentCatalogEntry = parentSelection
            ? findCatalogEntry(parentSelection)
            : undefined;
          const parentLevel =
            options?.model?.options.reasoningLevel ??
            parentSelection?.options?.reasoningLevel ??
            parentCatalogEntry?.defaultReasoningLevel;
          const childCatalogEntry = findCatalogEntry(childSelection);
          const supportedLevels =
            childCatalogEntry?.reasoningLevels ?? childModel.optionSpecs.reasoningLevel.values;
          const effortResolution = resolveSubagentEffortLevel({
            effort: request.effort,
            effortAboveParent: request.effortAboveParent,
            baseLevel: childSelection.options?.reasoningLevel,
            parentLevel,
            supportedLevels,
          });
          if (effortResolution.outcome === "unknown-class") {
            this.logger?.warn("Subagent effort class is unknown; keeping the resolved level", {
              event: "subagent.effort.unknown_class",
              module: "core.subagent",
              agentType: request.agentType,
              effort: request.effort,
            });
          } else {
            this.logger?.debug("Subagent effort resolved", {
              event: "subagent.effort.resolved",
              module: "core.subagent",
              agentType: request.agentType,
              effort: request.effort,
              outcome: effortResolution.outcome,
              reasoningLevel: effortResolution.level,
              baseClamped: effortResolution.baseClamped,
            });
          }
          if (
            effortResolution.level &&
            effortResolution.level !== childSelection.options?.reasoningLevel
          ) {
            childSelection = {
              ...childSelection,
              options: { ...childSelection.options, reasoningLevel: effortResolution.level },
            };
            baseChildModelFactory = modelOverride
              ? createSubagentOverrideModelFactory(
                  { ...modelOverride, selection: childSelection },
                  this.modelFactory,
                )
              : inheritedModel
                ? createInheritedSubagentModelFactory(
                    childSelection,
                    inheritedModel,
                    this.modelFactory,
                  )
                : this.modelFactory;
            if (!baseChildModelFactory) {
              throw createCoreError(
                CoreErrorType.ConfigurationError,
                `Subagent model factory cannot resolve ${childSelection.providerId}/${childSelection.modelId}`,
                { recoverable: true },
              );
            }
            childModel = baseChildModelFactory({ selection: childSelection });
          }
        }
        const childToolAllowlist = resolveSubagentToolAllowlist.call(
          this,
          request,
          childMcpAccess.snapshot?.tools.map((descriptor) => toMcpToolName(descriptor)) ?? [],
          childModel,
        );
        const childMode = resolveSubagentPermissionMode(
          this.getPlanEnabled() ? "plan" : this.config.mode,
          request.permissionMode,
          builtInExplore,
        );
        const childCuaPolicy = createOfficialCuaPolicy(
          officialCuaServerNames,
          childMcpAccess.parentSnapshot?.tools ?? childMcpAccess.snapshot?.tools ?? [],
          this.config.pluginReferenceCatalog,
        );
        await validateSubagentComputerUseConfiguration(request, childCuaPolicy, this.skillPort);
        const childSkillPort = resolveSubagentSkillPort(
          this.skillPort,
          request.profile.skills,
          childCuaPolicy,
        );
        const childModelFactory: NonNullable<AgentRuntimeDeps["modelFactory"]> = (target) =>
          target.selection.providerId === childSelection.providerId &&
          target.selection.modelId === childSelection.modelId &&
          target.selection.options?.reasoningLevel === childSelection.options?.reasoningLevel
            ? childModel
            : baseChildModelFactory(target);
        const parentToolCallId = traceStringAttribute(request.traceContext, "parentToolCallId");
        // 对外交互端口（permission broker + provider runtime headers）：与 dwf actor、legacy
        // workflow child 共用同一条派生，路由身份统一落到本 runtime 的会话。
        const childClientPorts = deriveChildClientPorts(
          {
            permissionBroker: this.permissionBroker,
            ...(this.providerRuntimeHeadersPort === undefined
              ? {}
              : {
                  providerRuntimeHeadersPort: this.providerRuntimeHeadersPort,
                }),
          },
          {
            agentId: request.agentId,
            agentType: request.agentType,
            childSessionId: request.sessionId,
            description: request.description,
            parentSessionId: this.sessionId,
            parentToolCallId,
            ...(request.traceContext.turnId === undefined
              ? {}
              : { parentTurnId: request.traceContext.turnId }),
          },
        );
        // Browser Use：子代理与当前对话共用 tab（tabOwner: "parent"），用户能在面板里看到它开的 tab，
        // 它也能看到对话里已有的 tab；workspace / clientMode 经 forChildSession 登记回父会话解析。
        // 子代理结束只撤销登记，不关 tab。端口没有 forChildSession（CLI headless）时退回子会话自己的 scope。
        const childBrowserControlPort =
          this.browserControlPort?.forChildSession?.({
            childSessionId: request.sessionId,
            parentSessionId: this.sessionId,
            tabOwner: "parent",
          }) ?? this.browserControlPort;
        const mirroredToolNameByChildToolCallId = new Map<string, string>();
        let sessionReadyNotified = false;
        const notifySessionReady = async (info?: { reasoningLevel?: string }) => {
          if (sessionReadyNotified) return;
          await request.onSessionReady?.(info);
          sessionReadyNotified = true;
        };
        this.logger?.debug("Starting subagent child runtime", {
          parentSessionId: this.sessionId,
          childSessionId: request.sessionId,
          agentType: request.agentType,
        });
        if (options?.signal?.aborted) {
          throw options.signal.reason ?? new Error("Subagent runtime start aborted");
        }
        if (request.resumeFromStore) this.runtimeTaskRegistry.openSessionOwner(request.sessionId);
        const childRuntime = new AgentRuntime(
          request.sessionId,
          {
            // 旧 plan 枚举不包含基础权限；拆分后继承完整状态，避免被构造器回退成 build。
            mode: childMode === "plan" ? this.config.mode : childMode,
            planEnabled: childMode === "plan",
            // 模型选择的影响不只在最终 request.model：MCS、内建搜索与 token/media 预算会在
            // child runtime 内按 default model 预先塑形。同步 child 因此必须把整套执行
            // 配置都指向父 turn 快照；runner 禁止它转后台，provider registry 则由父 turn
            // finally 清理，快照不会成为可恢复的 session 配置。
            modelSelection: cloneModelSelection(childSelection),
            modelContextBudgetStrategy: this.config.modelContextBudgetStrategy,
            workingDirectory: request.workingDirectory,
            // 执行模型只由 child Active Model 投影进 Context；envInfo 不保存第二份模型事实。
            envInfo: childRuntimeEnvInfo,
            // Explore 子运行时之前没有继承主会话的流式配置，Protocol 桌面端虽已默认
            // 开启 modelStreaming，子请求仍会退回 generateText。部分 OpenAI-compatible 端点在
            // 非流式请求里也返回 SSE `data:` 帧，generateText 会按普通 JSON 解析并报
            // Invalid JSON response；继承父配置可让子 agent 与主链路走同一 streamText 语义。
            modelStreaming: this.config.modelStreaming,
            bashTimeoutPolicy: this.config.bashTimeoutPolicy,
            // 子代理不能把 strict/ask 降级成 allow：边界是会话级安全策略，结构性继承。
            workspaceBoundary: this.config.workspaceBoundary,
            // Объявленный родителем write-scope наследуется ребёнком; иначе ветка писала бы
            // вне согласованной области, а ledger-конфликт оставался бы только подсказкой.
            ...(request.writePaths === undefined ? {} : { writeScope: request.writePaths }),
            midConversationSystem: this.config.midConversationSystem,
            toolSearch: this.config.toolSearch,
            bashShellSelection,
            // child 只复用父 runtime 已解析的 instructions snapshot；Project Context 仍不继承。
            currentDate: this.contextSourceSnapshot?.currentDate ?? this.config.currentDate,
            subagentContext: {
              agentPrompt: agentPrompt ?? "",
              ...(agentsMdInstructions ? { userInstructions: agentsMdInstructions } : {}),
              ...(bundledHarnessRules ? { bundledHarnessRules } : {}),
              ...(workspaceRules ? { workspaceRules } : {}),
            },
            agentName: `zcode-${request.agentType}`,
            // Child knows its routing identity: start -> orchestrator only, orchestrator ->
            // worker roles, worker/custom roles -> full catalog. Root remains undefined.
            agentType: request.agentType,
            // 子代理的 maxTurns 只有显式配置才生效：profile 优先，其次 subagents 级设置；
            // 两者都缺省时保持 undefined = 无限制（docs/specs/max-turns-limit.md）。
            // 这里过去用 `?? 4` 注入隐式上限，与契约冲突。
            maxTurns: request.maxTurns ?? this.config.subagents?.maxTurns,
            parentSessionId: this.sessionId,
            taskType: "subagent_child",
            // Router-роль не использует Write/Edit/Bash сама, но должна передать
            // worker-возможности дальше. Набор наследуется только router-детьми;
            // read-only и worker-дети пересекаются со своим фактическим tool surface.
            // Грант выдаётся уже ограниченным политикой текущей сессии (toolAllowlist /
            // toolDisallowlist), чтобы router не мог расширить её на следующем уровне.
            delegationToolAllowlist: isDelegationRouterAgentType(request.agentType)
              ? resolveRuntimeDelegationToolNames(this)
              : undefined,
            // 动态工作流灰度门必须结构性继承：
            // 父会话关着而子代理开着，等于 Agent 工具变成绕过灰度的后门。默认路径（child 继承
            // 父 registry 可见的工具名）本来就够，但**自定义 agent profile 显式写
            // `allowedTools: ["CreateWorkflow"]` 时会跳过那次交集**，只剩这一道能挡住。
            dynamicWorkflowEnabled: this.config.dynamicWorkflowEnabled,
            // launch.md「On demand: activation」Children 段：子代理继承父会话**此刻**的工具面——
            // 父未激活则子也按需（子会话里没有 `/workflow` 入口，实际等于没有工作流工具）；
            // 父已激活则子出生即注册。
            dynamicWorkflowToolsOnDemand:
              this.config.dynamicWorkflowToolsOnDemand === true &&
              !this.dynamicWorkflowToolsActivated,
            // Explore 保留独立的只读工具策略；其余显式 profile 使用下方的权限继承与 allowlist 计算。
            toolset: builtInExplore ? "explore" : "main",
            toolAllowlist: childToolAllowlist,
            toolDisallowlist: this.config.toolDisallowlist,
            embeddedSearchBackend: this.config.embeddedSearchBackend,
            nativeSearchEnhancementsEnabled: this.config.nativeSearchEnhancementsEnabled,
            subagents: {
              backgroundBashMaxMs: this.config.subagents?.backgroundBashMaxMs,
              enabled: this.config.subagents?.enabled,
              inactivityTimeoutMs: this.config.subagents?.inactivityTimeoutMs,
              autoBackgroundMs: this.config.subagents?.autoBackgroundMs,
              maxTurns: this.config.subagents?.maxTurns,
              outputRootDir: this.config.subagents?.outputRootDir,
              profiles: this.config.subagents?.profiles,
              builtInModelSelectionOverrides: this.config.subagents?.builtInModelSelectionOverrides,
            },
            mcp: childMcpAccess.config,
          },
          {
            // Планировщик и все поколения child должны видеть тот же снимок профилей,
            // с которым root проверил DAG; иначе динамический профиль пропадал на depth 2+.
            getAgentDefinitions: options?.internalAgentProfilesSnapshot
              ? () => ({ activeAgents: options.internalAgentProfilesSnapshot! })
              : this.getAgentDefinitions,
            agentTelemetry: this.agentTelemetry.port,
            agentTelemetryCausation: this.agentTelemetry.captureCausation(),
            // 前台 child 的生命周期被父 Agent Tool await，使用真实父子 Span；后台 child
            // 可能晚于父 Tool/Turn 结束，只能作为独立 Trace 用 Link 保留因果关系。
            agentTelemetryCausationMode: request.background ? "linked_root" : "child",
            eventStore: this.eventStore,
            sessionStore: deps.sessionStore,
            // Все поколения Agent используют единый registry: он владеет lineage, квотами,
            // cancellation handles и branch generation всего root run.
            runtimeTaskRegistry: this.runtimeTaskRegistry,
            // 子 runtime 继承父的模型请求准入端口：subagent 的请求 provider 同样看得见，
            // 它们该与父一样喂治理器信号（父是 observer 则子也是 observer）。
            modelRequestAdmission: this.modelRequestAdmission,
            modelFactory: childModelFactory,
            resolveEffectiveModelSelection: deps.resolveEffectiveModelSelection,
            // 子 runtime 自己仍使用 request.sessionId 做事件持久化和 trace 归档；对外阻塞交互
            // （permission / AskUserQuestion / provider runtime headers）一律路由回父 session——
            // 桌面 UI 只认识父 task 的 sessionId。派生收敛在 deriveChildClientPorts 一处，
            // dwf actor 与 legacy workflow child 走同一条。
            ...childClientPorts,
            ...(childBrowserControlPort === undefined
              ? {}
              : { browserControlPort: childBrowserControlPort }),
            coordinatorResponsePort: createCoordinatorResponsePort({
              agentId: request.agentId,
              agentType: request.agentType,
              childSessionId: request.sessionId,
              parentToolCallId,
              enqueue: (input) => this.enqueueSubagentMessage(input),
            }),
            // Explore 使用独立只读权限配置；general-purpose 和自定义 agent 继承父权限服务。
            permissionService: builtInExplore
              ? new PermissionService(defaultPermissionConfig)
              : this.permissionService,
            toolScheduler: deps.toolScheduler ?? defaultScheduler,
            executionPort: deps.executionPort,
            fileSystemPort: deps.fileSystemPort,
            // CodeIndex остаётся Host-owned: потомок получает только типизированный query-port.
            codeIntelligencePort: deps.codeIntelligencePort,
            // Один trace и один workspace делят карту Read: повтор того же диапазона
            // получает уже существующий stub, а не новый дамп файла.
            ...sharedReadFileStateForChild(
              this.workingDirectory,
              request.workingDirectory,
              this.readFileState,
            ),
            // Explore 子运行时会暴露 WebFetch，但之前没有继承主 runtime 的
            // HTTP client port，导致工具在真正发请求前抛出配置错误，而不是网络请求失败。
            httpClientPort: deps.httpClientPort,
            imageProcessorPort: deps.imageProcessorPort,
            pdfDocumentPort: deps.pdfDocumentPort,
            memoryRoot: persistentMemory?.rootDir,
            mcpPort: childMcpAccess.port,
            skillPort: childSkillPort,
            artifactStore: deps.artifactStore,
            appVersion: this.appVersion,
            eventSink: {
              onSessionEvent: async (event) => {
                // Причина по source trace: mirror descendant event повторно поднимался через
                // каждого предка и получал новые mirror-обёртки. Mirror принадлежит текущему
                // parent runtime; выше передаются только raw events.
                if (isMirroredSubagentEvent(event)) return;
                request.reportActivity?.();
                // Прогресс ребёнка = жизнь claim'а: heartbeat не чаще раза в минуту,
                // иначе append-only журнал распухнет на каждом streaming-событии.
                try {
                  heartbeatWorkClaim(this.runtimeTaskRegistry.workLedger, request.agentId);
                } catch (error) {
                  this.logger?.warn("Work ledger heartbeat failed", {
                    agentId: request.agentId,
                    error: String(error),
                  });
                }
                // child runtime 的事件已经按 childSessionId 落库，但旧链路只把
                // 少量工具事件镜像给 parent sink，导致 UI 订阅 child topic 后只能拿到打开时
                // 的 hydration，后续流式内容不会更新。raw child event 只通知父 runtime 的
                // 外部 sinks，不再次 append，因此不会重复持久化；bootstrap 再按 event.sessionId
                // 把它路由到 child publisher。
                await this.notifyEventSinks(event, {
                  ...request.traceContext,
                  sessionId: request.sessionId,
                });
                // Raw descendant events поднимаются для их владельцев, но проекция принадлежит
                // только runtime непосредственного child; иначе предок исказит agentId/childSessionId.
                if (event.sessionId !== request.sessionId) return;
                const mirroredEvent = mirrorSubagentToolEvent(event, {
                  agentId: request.agentId,
                  agentType: request.agentType,
                  background: request.background,
                  childSessionId: request.sessionId,
                  description: request.description,
                  parentSessionId: this.sessionId,
                  parentToolCallId,
                  parentTurnId: request.traceContext.turnId,
                  toolNameByChildToolCallId: mirroredToolNameByChildToolCallId,
                });
                if (!mirroredEvent) return;

                // parent mirror 保留原语义：父会话只看到 subagent 摘要/工具活动，raw child
                // 正文不会污染父 timeline。
                await this.notifyEventSinks(mirroredEvent, {
                  ...request.traceContext,
                  sessionId: this.sessionId,
                });
              },
            },
            logger: this.logger,
            traceContext: request.traceContext,
          },
        );

        const resumesExistingChild = request.resumeFromStore === true;
        // Idle-модель не должна закрепляться в истории child: persist возвращает
        // пользовательский выбор. Это не зависит от ticket binding, потому что защита
        // нужна и для resume завершённого ребёнка, где новый билет уже не выдаётся.
        if (offPeak)
          markTemporaryRuntimeSelection(
            childRuntime as unknown as AgentRuntimeInternal,
            offPeak.ordinarySelection,
          );
        let previousSelection: ModelSelection | undefined;
        if (resumesExistingChild) {
          const persistedMessages = await this.sessionStore?.messages({
            sessionID: request.sessionId,
          });
          // terminal resume 只恢复已有历史；模型初始化前失败不能变成一次空 session 创建。
          if (!persistedMessages?.length) {
            throw createCoreError(
              CoreErrorType.SessionNotFound,
              `No transcript found for agent ${request.agentId}`,
              { recoverable: true },
            );
          }
          const entries = await this.sessionStore?.sessionEntries?.({
            sessionID: request.sessionId,
            type: SESSION_ENTRY_MODEL_SELECTION,
          });
          previousSelection = parseModelSelectionValue(entries?.at(-1)?.data);
          await childRuntime.resumeFromStore({
            persistedMessages,
            traceContext: request.traceContext,
          });
          // 恢复只导入历史；本轮 profile 选出的模型仍是执行权威，并更新冷恢复所用的选择记录。
          await persistRuntimeModelSelection(
            childRuntime as unknown as AgentRuntimeInternal,
            childSelection,
          );
        } else {
          // 父会话过去先发布 SubagentSpawned，child 的首轮 executeTurn 才落库。
          // 并发派生时目录查询会在两者之间读到少一个 child。这里把持久化提升为发布前闸门。
          await childRuntime.ensureSessionPersistedForExternalActivity(request.prompt, {
            traceContext: request.traceContext,
          });
        }
        await notifySessionReady({ reasoningLevel: childModel.options.reasoningLevel });
        if (
          !resumesExistingChild ||
          (previousSelection && !sameModelSelection(previousSelection, childSelection))
        ) {
          // 同模型恢复不重复插入分隔线；配置变化复用现有事件和 transcript 记录。
          childRuntime.recordPendingModelChange({
            ...(previousSelection
              ? {
                  fromModel: previousSelection,
                  fromModelLabel: `${previousSelection.providerId}/${previousSelection.modelId}`,
                }
              : {}),
            toModel: childSelection,
            toModelLabel: `${childSelection.providerId}/${childSelection.modelId}`,
          });
          await childRuntime.emitModelSelected({
            modelSelection: childSelection,
            effectiveReasoningLevel: childModel.options.reasoningLevel,
            previousModelSelection: previousSelection ?? null,
            traceContext: request.traceContext,
          });
        }
        request.registerMessageSink?.(createSubagentMessageSink(childRuntime, request));
        try {
          if (options?.signal?.aborted) {
            throw options.signal.reason ?? new Error("Subagent runtime start aborted");
          }
          const turnResult = await childRuntime.executeTurn(request.prompt, undefined, {
            ...(childBinding
              ? {
                  offPeakTaskId: offPeak!.offPeakTaskId,
                  modelExecution: {
                    selectionScope: "execution" as const,
                    memoryExtraction: "skip" as const,
                  },
                }
              : { offPeakTaskId: undefined }),
            abortSignal: options?.signal,
            ...(options?.internalSwarmRootRunId
              ? {
                  internalSwarmRootRunId: options.internalSwarmRootRunId,
                  internalSwarmRootTurnId: options.internalSwarmRootTurnId,
                }
              : {}),
            // 子 Runtime 的首轮输入来自父 Agent，而不是真实用户直接输入；保留源事实，避免
            // Subagent Turn 在 Trace 和成功率报表里被误归类为 user。
            inputSource: "subagent",
            inputPresentation: "coordinator_input",
            traceContext: request.traceContext,
          });
          return {
            ...turnResult,
            ...(childModel.options.reasoningLevel
              ? { reasoningLevel: childModel.options.reasoningLevel }
              : {}),
          };
        } finally {
          const cancelled = options?.signal?.aborted === true;
          childRuntime.sealBackgroundTaskNotifications({
            reason: cancelled ? "subagent_cancelled" : "subagent_terminal",
            traceContext: request.traceContext,
          });
          if (cancelled) {
            await childRuntime.cancelRunningRuntimeBackgroundTasks({
              reason: "subagent_cancelled",
              traceContext: request.traceContext,
            });
          }
          await childRuntime.closeBrowserSession();
        }
      } finally {
        childBinding?.release();
      }
    },
  });
}

function resolveSubagentEmbeddedSearchEnabled(): boolean {
  const embeddedSearchDecision = resolveEmbeddedSearchBranchCapability({
    bashAvailable: true,
  });

  return embeddedSearchDecision.useEmbeddedSearchBranch;
}

function resolveSubagentPermissionMode(
  parentMode: AgentRuntimeInternal["config"]["mode"],
  permissionMode: ExploreSubagentRuntimeRequest["permissionMode"],
  builtInExplore: boolean,
): AgentRuntimeInternal["config"]["mode"] {
  switch (permissionMode) {
    case "bypassPermissions":
    case "dontAsk":
      return inheritPermissionMode(parentMode, "yolo");
    case "acceptEdits":
      return "edit";
    case "auto":
      return "auto";
    case "plan":
      return "plan";
    case "default":
    case undefined:
      return inheritPermissionMode(parentMode, builtInExplore ? "yolo" : parentMode);
    default:
      return parentMode;
  }
}

function traceStringAttribute(
  traceContext: { attributes?: Record<string, string | number | boolean> },
  key: string,
): string | undefined {
  const value = traceContext.attributes?.[key];
  return typeof value === "string" ? value : undefined;
}
