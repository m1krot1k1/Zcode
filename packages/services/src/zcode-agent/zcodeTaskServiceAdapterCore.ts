/**
 * zcodeTaskServiceAdapterCore.ts: Опции, общие типы, состояние задачи и базовые помощники адаптера.
 */
import type { ZCodeWorkspaceEventSubscriptionParams } from "../session/zcodeTaskService.js";
import type { IZCodeAgentService, ZCodeAgentWorkspaceTarget } from "./zcodeAgent.js";
import type { ZCodeTaskIndexSyncer } from "./zcodeTaskIndexSyncer.js";
import type {
  InputId,
  TraceId,
  ZCodeAgentMcpServer,
  ZCodeApiRetryStatus,
  ZCodeBackgroundTaskControlItem,
  ZCodeBackgroundTurnAttribution,
  ZCodeError,
  ZCodePersistedToolCall,
  ZCodeProvider,
  ZCodeSessionSettingsState,
  ZCodeSlashCommand,
  ZCodeStreamEvent,
  ZCodeTaskMeta,
  ZCodeTaskRuntimeCommand,
  ZCodeToolProjectionMemory,
  ZCodeWorkspaceEvent,
  ZCodeWorkspaceTaskListChanged,
} from "@zcode/shared";
import type { CuaProductMcpServerResolver } from "#src/cua-permission-broker/index.js";
import type { ISettingService } from "#src/setting/setting.js";
import { settingsToConfigOptions } from "./zcodeConfigOptions.js";
import { Emitter } from "@zcode/rpc";
import {
  createZCodeToolProjectionMemory,
  resolveWorkspaceKey,
  ZCODE_AGENT_PROVIDER,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import {
  AUTOMATION_MUTATION_TOOL_NAMES,
  OFF_PEAK_MUTATION_TOOL_NAMES,
} from "#src/zcode-agent/automationToolPolicy.js";
import { createBotTopicAdmission } from "#src/zcode-agent/botTopicAdmission.js";
import { createZCodeAgentConnectionScope } from "#src/zcode-agent/zcodeAgentConnectionScope.js";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CreateZCodeTaskServiceAdapterOptions {
  zcodeAgentService: IZCodeAgentService;
  taskIndexRepo?: TaskIndexRepo;
  // syncer 现在持有 workspace emitter 和 broadcast 入口，adapter 必须共用同一实例，
  // 否则 desktop-continuous 路径和 task adapter 路径的事件订阅会分裂成两份，UI 收不全。
  taskIndexSyncer: ZCodeTaskIndexSyncer;
  settingService?: Pick<ISettingService, "get">;
  cuaProductMcpServerResolver?: CuaProductMcpServerResolver;
}

export interface TaskTarget {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  cronAutomationId?: string;
  remoteSessionId?: string;
}

export interface TaskTargetWithMcpServers extends TaskTarget {
  additionalDirectories?: string[];
  model?: string;
  thoughtLevel?: string;
  mcpServers?: ZCodeAgentMcpServer[];
  toolDenylist?: string[];
}

export type WorkspaceEventInput = string | ZCodeWorkspaceEventSubscriptionParams;
export type ZCodeSendPromptRuntimeCommand = Extract<
  ZCodeTaskRuntimeCommand,
  { type: "send_prompt" }
>;
export type ZCodeTerminalStreamEvent =
  | Extract<ZCodeStreamEvent, { type: "task_complete" }>
  | Extract<ZCodeStreamEvent, { type: "task_error" }>;

export const GLM_PROVIDER: ZCodeProvider = ZCODE_AGENT_PROVIDER;
export const EMPTY_SLASH_COMMANDS: ZCodeSlashCommand[] = [];
export const logger = createServiceLogger("zcode-task-service");

export interface LiveToolProjection {
  order: number;
  parentToolUseId: string | null;
  tool: ZCodePersistedToolCall;
  toolId: string;
}

function padDatePart(value: number): string {
  return value.toString().padStart(2, "0");
}

function formatZCodeAgentLogDate(now: Date): string {
  return [now.getFullYear(), padDatePart(now.getMonth() + 1), padDatePart(now.getDate())].join("-");
}

export function resolveZCodeAgentCurrentLogFilePath(now = new Date()): string {
  const configuredLogDir = process.env.ZCODE_LOG_DIR?.trim();
  const logDir = configuredLogDir || join(homedir(), ".zcode", "cli", "log");
  return join(logDir, `zcode-${formatZCodeAgentLogDate(now)}.jsonl`);
}

export function unsupported(name: string): never {
  throw Object.assign(
    new Error(`ZCode task service adapter does not support IZCodeTaskService.${name} yet.`),
    {
      code: "ZCODE_AGENT_UNSUPPORTED_LEGACY_TASK_METHOD",
    },
  );
}

export interface TaskAdapterState {
  botConnectionScopes: Map<string, ReturnType<typeof createZCodeAgentConnectionScope>>;
  errorEmitter: Emitter<ZCodeError>;
  taskEmitters: Map<string, Emitter<ZCodeStreamEvent>>;
  globalTaskEmitters: Map<string, Emitter<ZCodeStreamEvent>>;
  taskTargets: Map<string, TaskTarget>;
  topicAdmission: ReturnType<typeof createBotTopicAdmission>;
  runtimeCommands: Map<string, ZCodeTaskRuntimeCommand[]>;
  runtimeCommandDrains: Map<string, Promise<void>>;
  apiRetryByTaskKey: Map<string, ZCodeApiRetryStatus | null>;
  backgroundTaskControlsByTaskKey: Map<string, ZCodeBackgroundTaskControlItem[]>;
  streamedTurnText: Map<string, { messageId?: string; text: string }>;
  activePromptInputIds: Map<string, InputId>;
  toolProjectionMemoryByTaskKey: Map<string, ZCodeToolProjectionMemory>;
  liveToolProjectionsByTaskKey: Map<string, Map<string, LiveToolProjection>>;
  legacySnapshotTaskKeys: Set<string>;
  disposed: boolean;
  memoryDiagnostics: ReturnType<typeof registerMemoryDiagnosticsProvider>;
  taskIndexRepo: TaskIndexRepo;
  taskIndexSyncer: ZCodeTaskIndexSyncer;
}

export function createTaskAdapterState(
  options: CreateZCodeTaskServiceAdapterOptions,
): TaskAdapterState {
  // Bot 原来绕过连接 facade，导致真实附件 admission 缺少可信身份；复用既有 scope，
  // 同一 Bot 接入的附件、命令及对账共用连接，不改变桌面与手机各自的传输模式。
  const botConnectionScopes = new Map<string, ReturnType<typeof createZCodeAgentConnectionScope>>();
  const errorEmitter = new Emitter<ZCodeError>();
  const taskEmitters = new Map<string, Emitter<ZCodeStreamEvent>>();
  const globalTaskEmitters = new Map<string, Emitter<ZCodeStreamEvent>>();
  const taskTargets = new Map<string, TaskTarget>();
  const topicAdmission = createBotTopicAdmission();
  const runtimeCommands = new Map<string, ZCodeTaskRuntimeCommand[]>();
  const runtimeCommandDrains = new Map<string, Promise<void>>();
  const apiRetryByTaskKey = new Map<string, ZCodeApiRetryStatus | null>();
  const backgroundTaskControlsByTaskKey = new Map<string, ZCodeBackgroundTaskControlItem[]>();
  const streamedTurnText = new Map<string, { messageId?: string; text: string }>();
  const activePromptInputIds = new Map<string, InputId>();
  const toolProjectionMemoryByTaskKey = new Map<string, ZCodeToolProjectionMemory>();
  const liveToolProjectionsByTaskKey = new Map<string, Map<string, LiveToolProjection>>();
  const legacySnapshotTaskKeys = new Set<string>();
  // 内存诊断计数器（docs/monitoring/memory-diagnostics-log.md）：对应审计里 deleteTask
  // 不清理的 per-task 表，只读 size。
  const memoryDiagnostics = registerMemoryDiagnosticsProvider("task", () => ({
    runtimeCommands: runtimeCommands.size,
    activePromptInputs: activePromptInputIds.size,
    toolMemoryTasks: toolProjectionMemoryByTaskKey.size,
    taskEmitters: taskEmitters.size,
  }));
  const taskIndexRepo = options.taskIndexRepo ?? new TaskIndexRepo();
  const taskIndexSyncer = options.taskIndexSyncer;
  return {
    botConnectionScopes,
    errorEmitter,
    taskEmitters,
    globalTaskEmitters,
    taskTargets,
    topicAdmission,
    runtimeCommands,
    runtimeCommandDrains,
    apiRetryByTaskKey,
    backgroundTaskControlsByTaskKey,
    streamedTurnText,
    activePromptInputIds,
    toolProjectionMemoryByTaskKey,
    liveToolProjectionsByTaskKey,
    legacySnapshotTaskKeys,
    disposed: false,
    memoryDiagnostics,
    taskIndexRepo,
    taskIndexSyncer,
  };
}

export type CoreHelpers = ReturnType<typeof createCoreHelpers>;

export function createCoreHelpers(
  deps: { options: CreateZCodeTaskServiceAdapterOptions } & Pick<
    TaskAdapterState,
    | "activePromptInputIds"
    | "botConnectionScopes"
    | "globalTaskEmitters"
    | "taskEmitters"
    | "taskIndexSyncer"
    | "taskTargets"
    | "toolProjectionMemoryByTaskKey"
  >,
) {
  const {
    activePromptInputIds,
    botConnectionScopes,
    globalTaskEmitters,
    taskEmitters,
    taskIndexSyncer,
    taskTargets,
    toolProjectionMemoryByTaskKey,
    options,
  } = deps;

  function botAgent(workspace: ZCodeAgentWorkspaceTarget) {
    const key = JSON.stringify([resolveWorkspaceKey(workspace), workspace.remoteSessionId ?? ""]);
    let scope = botConnectionScopes.get(key);
    if (!scope) {
      scope = createZCodeAgentConnectionScope(options.zcodeAgentService, {
        connectionId: `bot-${randomUUID()}`,
        clientMode: "desktop-continuous",
        role: "trusted-host-relay",
      });
      botConnectionScopes.set(key, scope);
    }
    return scope.service;
  }

  function notifySyncerSession(target: TaskTarget): void {
    taskIndexSyncer.ensureSessionSubscription({
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      sessionId: target.taskId,
    });
  }

  function resolvePromptToolDenylist(params: {
    automationId?: string;
    offPeakTaskId?: string;
    toolDenylist?: string[];
  }): string[] | undefined {
    const toolDenylist = new Set(params.toolDenylist);
    // 持久化的 cronAutomationId 不能当成当前 turn 的执行身份，否则定时任务
    // 跑过一次后，用户在同一会话主动修改调度也永久看不到 CronUpdate。权限必须只看本轮
    // automationId；cronAutomationId 仅保留任务归属和 UI 展示语义。
    if (params.automationId) {
      for (const toolName of AUTOMATION_MUTATION_TOOL_NAMES) {
        toolDenylist.add(toolName);
      }
    }
    // 闲时派发轮纵深隐藏 OffPeakCreate；不与 automation 分支合并（cron 轮放行）。
    if (params.offPeakTaskId) {
      for (const toolName of OFF_PEAK_MUTATION_TOOL_NAMES) {
        toolDenylist.add(toolName);
      }
    }
    return toolDenylist.size > 0 ? [...toolDenylist] : undefined;
  }

  function turnAttributionOf(
    params: ZCodeBackgroundTurnAttribution,
  ): ZCodeBackgroundTurnAttribution {
    if (params.automationId) return { automationId: params.automationId };
    if (params.offPeakTaskId) {
      return {
        offPeakTaskId: params.offPeakTaskId,
        ...(params.offPeakRunType ? { offPeakRunType: params.offPeakRunType } : {}),
      };
    }
    return {};
  }

  async function resolveProductMcpServers(
    servers: ZCodeAgentMcpServer[] | undefined,
  ): Promise<ZCodeAgentMcpServer[] | undefined> {
    const configuredServers = (servers?.length ?? 0) > 0 ? servers : undefined;
    if (!configuredServers || !options.cuaProductMcpServerResolver) {
      return configuredServers;
    }
    return options.cuaProductMcpServerResolver.resolveMcpServers(configuredServers);
  }

  function workspaceKey(params: { workspacePath: string; workspaceIdentity?: string }): string {
    return resolveWorkspaceKey(params);
  }

  function taskKey(params: { workspacePath: string; workspaceIdentity?: string; taskId: string }) {
    return `${workspaceKey(params)}\u0000${params.taskId}`;
  }

  function createTaskOwnerCommandError(
    message: string,
    code: "NO_ACTIVE_TASK_OWNER" | "STALE_TASK_OWNER_COMMAND",
  ): Error & { code: "NO_ACTIVE_TASK_OWNER" | "STALE_TASK_OWNER_COMMAND" } {
    return Object.assign(new Error(message), { code });
  }

  function assertCurrentOwnerRun(params: TaskTarget, ownerRunId: TraceId | undefined): void {
    if (!ownerRunId) {
      return;
    }
    const key = taskKey(params);
    const activeRunId = activePromptInputIds.get(key);
    if (!activeRunId) {
      // 手机端 owner command 到达 host 时，task 可能已经终态收口。
      // 没有 active run 时不能再把旧 command 写入 host 队列，否则会在桌面 shared host 上误发旧输入。
      throw createTaskOwnerCommandError("No active task owner.", "NO_ACTIVE_TASK_OWNER");
    }
    if (activeRunId !== ownerRunId) {
      // ownerRunId 是远控请求的 stale 防护边界。
      // 旧 run 的 enqueue/promote 不能修改当前 task command queue。
      throw createTaskOwnerCommandError("Stale task owner command.", "STALE_TASK_OWNER_COMMAND");
    }
  }

  function rememberTaskTarget(params: TaskTarget): void {
    const existing = taskTargets.get(params.taskId);
    taskTargets.set(params.taskId, {
      ...params,
      // cronAutomationId 是会话的 sticky 归属标记，供 UI 展示和任务关联使用，不参与当前
      // turn 的工具权限。resume/onDynamicTaskEvent 等入口不带值时仍需保留权威归属；明确设置
      // 或清除只能走 rememberIndexedTaskMeta。
      cronAutomationId: params.cronAutomationId ?? existing?.cronAutomationId,
    });
  }

  function getTaskTarget(taskId: string): TaskTarget {
    const target = taskTargets.get(taskId);
    if (!target) {
      throw Object.assign(new Error(`ZCode session target is not loaded: ${taskId}`), {
        code: "ZCODE_SESSION_TARGET_NOT_FOUND",
      });
    }
    return target;
  }

  function getToolProjectionMemory(params: TaskTarget): ZCodeToolProjectionMemory {
    const key = taskKey(params);
    let memory = toolProjectionMemoryByTaskKey.get(key);
    if (!memory) {
      memory = createZCodeToolProjectionMemory();
      toolProjectionMemoryByTaskKey.set(key, memory);
    }
    return memory;
  }

  function clearStreamingToolInputCache(params: TaskTarget): void {
    toolProjectionMemoryByTaskKey.get(taskKey(params))?.streamingToolInputById?.clear();
  }

  // Bugfix: workspace emitter 已上提到 syncer，adapter 通过 syncer 获取共享 emitter，
  // 保证 task adapter 路径和 desktop-continuous 路径走同一份订阅，UI 不会漏事件。
  function getWorkspaceEmitter(workspace: WorkspaceEventInput): Emitter<ZCodeWorkspaceEvent> {
    return taskIndexSyncer.getWorkspaceEmitter(workspace);
  }

  function getTaskEmitter(params: TaskTarget): Emitter<ZCodeStreamEvent> {
    const key = taskKey(params);
    let emitter = taskEmitters.get(key);
    if (!emitter) {
      emitter = new Emitter<ZCodeStreamEvent>();
      taskEmitters.set(key, emitter);
    }
    return emitter;
  }

  function getGlobalTaskEmitter(taskId: string): Emitter<ZCodeStreamEvent> {
    let emitter = globalTaskEmitters.get(taskId);
    if (!emitter) {
      emitter = new Emitter<ZCodeStreamEvent>();
      globalTaskEmitters.set(taskId, emitter);
    }
    return emitter;
  }

  function emitTaskEvent(params: TaskTarget, event: ZCodeStreamEvent): void {
    getTaskEmitter(params).fire(event);
    getGlobalTaskEmitter(params.taskId).fire(event);
  }

  // 委托到 syncer，让 archive/rename/pin/delete 等 task 元数据变更和
  // desktop-continuous 路径（turn.completed 等）走同一条广播通道。
  // 设计修正：reason 必填，发射点必须声明变更类别。
  function emitWorkspaceTaskListChanged(
    params: {
      workspacePath: string;
      workspaceIdentity?: string;
      taskId?: string;
    },
    taskMeta: ZCodeTaskMeta | undefined,
    reason: ZCodeWorkspaceTaskListChanged["reason"],
  ) {
    taskIndexSyncer.emitWorkspaceTaskListChanged(params, taskMeta, reason);
  }

  function emitWorkspaceConfig(
    params: ZCodeAgentWorkspaceTarget,
    settings: ZCodeSessionSettingsState,
  ) {
    getWorkspaceEmitter(params).fire({
      type: "workspace_config_options_update",
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      configOptions: settingsToConfigOptions(settings),
    });
  }

  return {
    botAgent,
    notifySyncerSession,
    resolvePromptToolDenylist,
    turnAttributionOf,
    resolveProductMcpServers,
    workspaceKey,
    taskKey,
    createTaskOwnerCommandError,
    assertCurrentOwnerRun,
    rememberTaskTarget,
    getTaskTarget,
    getToolProjectionMemory,
    clearStreamingToolInputCache,
    getWorkspaceEmitter,
    getTaskEmitter,
    getGlobalTaskEmitter,
    emitTaskEvent,
    emitWorkspaceTaskListChanged,
    emitWorkspaceConfig,
  };
}
