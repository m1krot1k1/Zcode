import { isAuxiliarySessionKind, OFF_PEAK_EXECUTION_TOOL_DENYLIST } from "@zcode/shared";

import {
  TASK_LIST_SESSION_TYPES,
  isTaskListSessionType,
} from "../zcode-protocol-v4/task-list-session-membership.js";





import { type ExecutionShellSelection, type MessageWithParts, type SessionEvent, type SessionId, type SessionInfo, type SessionTaskType, type UsageStorePort, type WorkspaceId } from "@zcode/contracts";
import { zcodeProtocolErrorCodes, zcodeSessionListParamsSchema, zcodeSessionSubagentsParamsSchema, zcodeTaskTokenUsageParamsSchema, zcodeWorkspaceGenerateTextParamsSchema, parseRemoteWorkspaceIdentity, type AppToolSearchMode, type ZCodeSessionCreateParams, type IntegratedTerminalShellSelection, type ZCodeModelContextBudgetStrategy, type ZCodeSessionResumeParams, type ZCodeSessionPersistence } from "@zcode/shared";
import { buildWorkspaceRef, mapSessionInfo } from "./mapper.js";

import { ProtocolRequestError, parseParams, type ZCodeProtocolAgentServerContext, type ZCodeProtocolSessionRecord } from "./server-types.js";
import { createWorkspaceZCodeApp, ensureSessionModelAvailable } from "./workspace-model-runtime.js";










import {
  collectSubagentChildSessionIds,
  isOwnedSubagentChild,
  paginateEndedSubagents,
  projectSessionSubagents,
  resolvePrismAcceptanceByChildSessionId,
} from "../app/subagent-observation/index.js";





// Часть 1/7 модуля server-operations: вынесено по лимиту строк.

export const PLAN_MODE_GOAL_CONTINUATION_SKIPPED_MESSAGE = "Plan mode 下已记录 goal，但不会自动继续。";

export const SLOW_SNAPSHOT_LOG_THRESHOLD_MS = 1000;

export const REMOTE_AUTOMATION_TOOL_NAMES = [
  "CronCreate",
  "CronList",
  "CronUpdate",
  "CronDelete",
] as const;

export type ProtocolGoalTarget = NonNullable<
  Awaited<ReturnType<NonNullable<ZCodeProtocolSessionRecord["app"]["readTarget"]>>>
>;

export type ZCodeSessionRecordParams = (
  | ZCodeSessionCreateParams
  | (ZCodeSessionResumeParams & {
      mode?: ZCodeSessionCreateParams["mode"];
      model?: ZCodeSessionCreateParams["model"];
      parentSessionId?: ZCodeSessionCreateParams["parentSessionId"];
      thoughtLevel?: ZCodeSessionCreateParams["thoughtLevel"];
      // 自动化会话会在创建期关闭标题二次生成，而 create/resume
      // 共用 record 初始化函数；resume 兼容分支也必须声明该策略字段。
      titleGenerationEnabled?: ZCodeSessionCreateParams["titleGenerationEnabled"];
    })
) & { taskType?: SessionTaskType };

export interface SessionStartupPreferences {
  additionalDirectories?: readonly string[];
  subagentRuntimeConfigEnabled?: boolean;
  memoryEnabled: boolean;
  modelContextBudgetStrategy: ZCodeModelContextBudgetStrategy;
  nativeSearchEnhancementsEnabled: boolean;
  toolSearchMode: AppToolSearchMode;
  /** Workspace boundary для file-tools; читается из Host preferences, не из env. */
  workspaceBoundary: "strict" | "ask" | "allow";
  resolveInitialBashShellSelection: () => Promise<ExecutionShellSelection | undefined>;
}

export type SessionStartupPreferencesSource =
  | { kind: "host" }
  | { kind: "inherit"; parent: ZCodeProtocolSessionRecord };

export function resolveSupportedAppThoughtLevel(
  app: Pick<ZCodeProtocolSessionRecord["app"], "listThoughtLevels">,
  thoughtLevel: string | undefined,
): string | undefined {
  const normalizedThoughtLevel = thoughtLevel?.trim();
  if (!normalizedThoughtLevel) {
    return undefined;
  }
  const supportedLevels = app.listThoughtLevels();
  return supportedLevels.includes(normalizedThoughtLevel) ? normalizedThoughtLevel : undefined;
}

export const DEFAULT_PROTOCOL_EVENT_SEQUENCE_KEY = "__default__";

export const PROTOCOL_TOOL_INPUT_DELTA_BATCH_MAX_CHARS = 4 * 1024;

export const PROTOCOL_TOOL_INPUT_DELTA_BATCH_MAX_INTERVAL_MS = 750;

export const PROTOCOL_TEXT_STREAMING_DELTA_BATCH_MAX_CHARS = 2 * 1024;

export const PROTOCOL_TEXT_STREAMING_DELTA_BATCH_MAX_INTERVAL_MS = 250;

export type ProtocolStreamingDeltaKind = "reasoning_delta" | "text_delta" | "tool_input_delta";

export function protocolSourceEventKey(event: SessionEvent): string {
  return event.sequenceNumber > 0 ? `seq:${event.sequenceNumber}` : `event:${String(event.id)}`;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function timestampMsForProtocolEvent(event: SessionEvent): number {
  const timestampMs = event.timestamp.getTime();
  return Number.isFinite(timestampMs) ? timestampMs : 0;
}

export function copyStringFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  keys: string[],
): void {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) {
      target[key] = value;
    }
  }
}

export function copyBooleanFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  keys: string[],
): void {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") {
      target[key] = value;
    }
  }
}

export function copyNumberFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  keys: string[],
): void {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      target[key] = value;
    }
  }
}

export function copyObjectKeySummary(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  sourceKey: string,
  targetPrefix: string,
): void {
  const value = source[sourceKey];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const keys = Object.keys(value).sort();
  target[`${targetPrefix}KeyCount`] = keys.length;
  target[`${targetPrefix}Keys`] = keys.slice(0, 20);
}

export function measureJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
  } catch {
    return 0;
  }
}

export function slugifyImportedSession(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return slug.length > 0 ? slug : "imported-session";
}

export interface ActivatedSessionForResume {
  record: ZCodeProtocolSessionRecord;
  knownSession?: SessionInfo;
  /** 仅供启动本次 V4 hydration，不写入 record 或跨请求缓存。 */
  persistedMessages?: MessageWithParts[];
}

/** 只拆掉本次失败的 record；不删除持久历史或 gateway publisher。 */
export async function discardFailedSessionResume(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  record: ZCodeProtocolSessionRecord,
): Promise<void> {
  if (context.sessions.get(sessionId) !== record) return;
  record.unsubscribe?.();
  context.sessions.delete(sessionId);
  try {
    await record.app.close?.();
  } catch {
    /* 保留原始恢复错误。 */
  }
  await record.eventStore.deleteSession(sessionId as SessionId).catch(() => undefined);
}

export function resolveLegacyRemoteWorkspace(
  context: ZCodeProtocolAgentServerContext,
  legacyWorkspaceDirectory: string,
): { workspaceIdentity: WorkspaceId; workspacePath: string } | null {
  const currentWorkspacePath = context.deps.cwd ?? process.cwd();
  const direct = parseRemoteWorkspaceIdentity(legacyWorkspaceDirectory);
  if (direct?.kind === "wsl" && direct.workspacePath === currentWorkspacePath) {
    return {
      workspaceIdentity: legacyWorkspaceDirectory as WorkspaceId,
      workspacePath: direct.workspacePath,
    };
  }

  const identityPrefix = currentWorkspacePath === "/" ? "/" : `${currentWorkspacePath}/`;
  if (!legacyWorkspaceDirectory.startsWith(identityPrefix)) return null;
  const embeddedIdentity = legacyWorkspaceDirectory.slice(identityPrefix.length);
  const embedded = parseRemoteWorkspaceIdentity(embeddedIdentity);
  if (
    embedded?.kind !== "wsl" ||
    `${identityPrefix}${embeddedIdentity}` !== legacyWorkspaceDirectory ||
    embedded.workspacePath !== currentWorkspacePath
  ) {
    return null;
  }

  // 只接受当前 app-server cwd 直接拼出的精确形态，不在任意路径中模糊搜索 remote: 前缀。
  return {
    workspaceIdentity: embeddedIdentity as WorkspaceId,
    workspacePath: embedded.workspacePath,
  };
}

export async function listSessions(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionListParamsSchema, rawParams ?? {});
  const store = context.deps.sessionStore;
  // 显式 ID 查询只读持久化身份，供 Host 修复旧索引；不能为了识别 child 激活 runtime。
  const candidates = params.sessionIds
    ? await Promise.all(params.sessionIds.map((id) => store?.getSession(id as SessionId) ?? null))
    : store
      ? await store.listSessions({
          directory: params.workspace?.workspacePath,
          limit: params.limit ?? 50,
          taskTypes: [...TASK_LIST_SESSION_TYPES],
        })
      : [];
  const scoped = await Promise.all(
    candidates.map(async (session) => {
      if (!session) return null;
      if (!params.workspace) return session.time.deleted === undefined ? session : null;
      const expectedKey =
        params.workspace.workspaceIdentity?.trim() || params.workspace.workspacePath;
      const visited = new Set<string>();
      let current: SessionInfo | null = session;
      while (current && current.time.deleted === undefined && !visited.has(current.id)) {
        visited.add(current.id);
        const path = current.path || current.directory;
        const key = current.workspaceID?.trim() || path;
        if (key === expectedKey) return session;
        // 子 runtime 的历史行可能只有 cwd，没有远端 workspace identity；仅精确 ID 查询
        // 可凭持久化父链证明归属。目录或显式身份不同就拒绝，不回写身份、不激活 runtime。
        if (
          !params.sessionIds ||
          !isAuxiliarySessionKind(current.taskType) ||
          !current.parentID ||
          path !== params.workspace.workspacePath ||
          (current.workspaceID?.trim() && key !== path)
        )
          return null;
        current = (await store?.getSession(current.parentID)) ?? null;
        if (current && (current.path || current.directory) !== params.workspace.workspacePath)
          return null;
      }
      return null;
    }),
  );
  const stored = scoped.filter((session): session is SessionInfo => session !== null);
  const storedIds = new Set(stored.map((session) => String(session.id)));
  const sessions = stored.map((session) =>
    mapSessionInfo({
      session,
      workspace:
        params.workspace ?? buildWorkspaceRef({ workspacePath: session.path ?? session.directory }),
    }),
  );
  if (params.sessionIds) return { sessions };
  for (const record of context.sessions.values()) {
    if (record.persistence === "deferred") continue;
    if (!isTaskListSessionType(record.taskType)) continue;
    if (storedIds.has(record.app.sessionId)) continue;
    if (params.workspace && params.workspace.workspaceKey !== record.workspace.workspaceKey)
      continue;
    sessions.push(
      mapSessionInfo({
        app: record.app,
        workspace: record.workspace,
        taskType: record.taskType,
        parentSessionId: record.parentSessionId,
      }),
    );
  }
  return { sessions };
}

export async function listSessionSubagents(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  persistedMessages?: MessageWithParts[],
) {
  const params = parseParams(zcodeSessionSubagentsParamsSchema, rawParams ?? {});
  const store = context.deps.sessionStore;
  const liveParent = context.sessions.get(params.sessionId);
  if (!store) {
    return {
      revision: liveParent?.stateRevision ?? 0,
      childSessionIds: [],
      running: [],
      ended: { total: 0, items: [] },
    };
  }

  const parentSession = await store.getSession(params.sessionId as SessionId);
  if (!parentSession) {
    // 诊断：hydrate 会复用子任务种子读取；若 task index/旧 ACP task 残留了无效 ID，
    // 这里会把“持久化记录不存在”包装成 v4.hydrate，必须记录调用阶段而不是只看错误文本。
    context.logger?.warn("ZCode Protocol session subagents has no persisted parent", {
      activeSessionCount: context.sessions.size,
      activeSession: Boolean(liveParent),
      event: "zcode_protocol.session.persisted_missing",
      module: "bootstrap.zcode_protocol",
      operation: "session_subagents",
      sessionId: params.sessionId,
    });
    throw new ProtocolRequestError(
      zcodeProtocolErrorCodes.sessionUnavailable,
      `Session not found: ${params.sessionId}`,
    );
  }
  const messages = persistedMessages ?? (await store.messages({ sessionID: parentSession.id }));
  const parentEvents = liveParent
    ? await liveParent.eventStore.getEvents(parentSession.id).catch(() => [])
    : [];
  const childSessionIds = collectSubagentChildSessionIds(parentSession, messages, parentEvents);
  const childEntries = await Promise.all(
    childSessionIds.map(async (childSessionId) => {
      const childSession = await store.getSession(childSessionId as SessionId);
      if (!childSession || !isOwnedSubagentChild(parentSession.id, childSession)) return null;
      const childMessages = await store.messages({
        sessionID: childSession.id,
      });
      const liveChild = context.sessions.get(childSessionId);
      const childProjection = liveChild
        ? await liveChild.app.runtime.getProjection().catch(() => undefined)
        : undefined;
      return { childMessages, childProjection, childSession, childSessionId };
    }),
  );
  const persistedChildren = childEntries.filter(
    (entry): entry is NonNullable<typeof entry> => entry !== null,
  );
  const parentProjection = liveParent
    ? await liveParent.app.runtime.getProjection().catch(() => undefined)
    : undefined;
  const projectionInput = {
    revision: liveParent?.stateRevision ?? parentSession.time.updated,
    parentSession,
    messages,
    childSessionsById: new Map(
      persistedChildren.map((entry) => [entry.childSessionId, entry.childSession]),
    ),
    childMessagesById: new Map(
      persistedChildren.map((entry) => [entry.childSessionId, entry.childMessages]),
    ),
    childProjectionsById: new Map(
      persistedChildren.flatMap((entry) =>
        entry.childProjection ? [[entry.childSessionId, entry.childProjection]] : [],
      ),
    ),
    ...(parentProjection ? { parentProjection } : {}),
    ...(parentEvents.length > 0 ? { parentEvents } : {}),
  };
  const initialProjection = projectSessionSubagents(projectionInput);
  const requestedEndedPage = paginateEndedSubagents(initialProjection.ended, {
    cursor: params.endedCursor,
    limit: params.endedLimit,
  });
  const prismAcceptanceByChildSessionId = await resolvePrismAcceptanceByChildSessionId({
    sessionStore: store,
    ownerSession: parentSession,
    ownerMessages: messages,
    ...(parentEvents.length > 0 ? { ownerEvents: parentEvents } : {}),
    endedSubagents: requestedEndedPage.items,
    childSessionsById: projectionInput.childSessionsById,
    onReadError: (error) =>
      context.logger?.warn(
        "PRISM subagent history is unavailable; returning directory without badges",
        {
          errorType: error instanceof Error ? error.name : typeof error,
          event: "zcode_protocol.session_subagents.prism_history_unavailable",
          module: "bootstrap.zcode_protocol",
          operation: "session_subagents",
        },
      ),
  });
  const projection = projectSessionSubagents({
    ...projectionInput,
    ...(prismAcceptanceByChildSessionId.size > 0 ? { prismAcceptanceByChildSessionId } : {}),
  });
  const ended = paginateEndedSubagents(projection.ended, {
    cursor: params.endedCursor,
    limit: params.endedLimit,
  });
  return {
    revision: projection.revision,
    childSessionIds: persistedChildren.map((entry) => entry.childSessionId),
    running: projection.running,
    ended: {
      total: projection.ended.length,
      items: ended.items,
      ...(ended.nextCursor ? { nextCursor: ended.nextCursor } : {}),
    },
  };
}

export const APP_USAGE_RANGE_DAYS: Record<string, number> = { "7d": 7, "30d": 30 };

export async function inheritForkedSessionTarget(
  context: ZCodeProtocolAgentServerContext,
  parentRecord: ZCodeProtocolSessionRecord,
  forkRecord: ZCodeProtocolSessionRecord,
  forkedSessionId: string,
) {
  const parentTarget = await parentRecord.app.readTarget();
  if (!parentTarget || !context.deps.sessionStore) {
    return;
  }
  const existingChildTarget = await context.deps.sessionStore.readTarget({
    sessionID: forkedSessionId as SessionId,
  });
  if (existingChildTarget) {
    return;
  }
  if (!context.deps.sessionStore.cloneTargetForFork) {
    return;
  }

  // core fork 现在会复制 goal state；bootstrap 只保留旧 app/fake app 的兜底。
  // 不能再 setTarget 新建 targetId，否则 verifier timeline 会和 copied transcript 断开。
  await context.deps.sessionStore.cloneTargetForFork({
    sessionID: forkedSessionId as SessionId,
    source: parentTarget,
    status: parentTarget.status,
  });
  forkRecord.stateRevision++;
  forkRecord.updatedAt = Date.now();
}

export function buildPromptTurnToolDisallowlist(
  params: {
    automationId?: string;
    offPeakTaskId?: string;
    inputId?: string;
    toolDenylist?: readonly string[];
  },
  activeAutomationId = params.automationId,
  activeOffPeakTaskId = params.offPeakTaskId,
): readonly string[] | undefined {
  const tools = new Set(params.toolDenylist ?? []);
  if (activeAutomationId) tools.add("CronCreate");
  // 闲时派发轮隐藏 OffPeakCreate（防递归自我派生）；OffPeakList 只读保留。
  // 注意 automation 轮不加 OffPeakCreate——cron 轮放行（定时派生闲时任务）。
  // SendMessage / Workflow 同样隐藏，与 V4 prompt-turn 及 core turn-loop-state 同值。
  if (activeOffPeakTaskId) {
    for (const toolName of OFF_PEAK_EXECUTION_TOOL_DENYLIST) tools.add(toolName);
  }
  return tools.size > 0 ? [...tools] : undefined;
}

export function resolvePromptTurnAutomationId(params: {
  automationId?: string;
  inputId?: string;
}): string | undefined {
  const explicit = params.automationId?.trim();
  if (explicit) return explicit;
  const inputId = params.inputId?.trim();
  if (!inputId?.startsWith("automation-")) return undefined;
  const separatorIndex = inputId.indexOf(":");
  const automationId = separatorIndex >= 0 ? inputId.slice(0, separatorIndex) : inputId;
  return automationId.length > "automation-".length ? automationId : undefined;
}

export function resolvePromptTurnOffPeakTaskId(params: {
  offPeakTaskId?: string;
  inputId?: string;
}): string | undefined {
  const explicit = params.offPeakTaskId?.trim();
  if (explicit) return explicit;
  // 兜底：续跑派发的 inputId 形如 `offpeak-<uuid>:resume:<uuid>`（首段 traceId 无固定前缀，
  // 主信号必须是显式 offPeakTaskId）。
  const inputId = params.inputId?.trim();
  if (!inputId?.startsWith("offpeak-")) return undefined;
  const separatorIndex = inputId.indexOf(":");
  const offPeakTaskId = separatorIndex >= 0 ? inputId.slice(0, separatorIndex) : inputId;
  return offPeakTaskId.length > "offpeak-".length ? offPeakTaskId : undefined;
}

export function shouldCloseSessionForExpectedPersistence(
  currentPersistence: ZCodeSessionPersistence,
  expectedPersistence?: ZCodeSessionPersistence,
): boolean {
  return expectedPersistence === undefined || currentPersistence === expectedPersistence;
}

export async function generateWorkspaceText(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
) {
  const params = parseParams(zcodeWorkspaceGenerateTextParamsSchema, rawParams);
  const active = Array.from(context.sessions.values()).find(
    (record) => record.workspace.workspaceKey === params.workspace.workspaceKey,
  );
  const input = {
    selection: params.selection,
    ...(params.prompt ? { prompt: params.prompt } : {}),
    ...(params.messages ? { messages: params.messages } : {}),
    ...(params.tools
      ? {
          tools: params.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        }
      : {}),
    querySource: params.querySource,
    ...(params.maxOutputTokens ? { maxOutputTokens: params.maxOutputTokens } : {}),
  };
  const app =
    active?.app ??
    (await createWorkspaceZCodeApp(context, params.workspace, {
      env: context.deps.env,
      eventStore: context.deps.createSessionEventStore("workspace-generate-text"),
      runtimeConfig: {
        workingDirectory: params.workspace.workspacePath,
      },
      sessionStore: context.deps.sessionStore,
      version: context.deps.version,
    }));

  try {
    const result = await app.generateWorkspaceText(input, { abortSignal });
    return {
      text: result.text,
      selection: result.selection,
      finishReason: result.finishReason,
      ...(result.requestId ? { requestId: result.requestId } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
    };
  } finally {
    if (!active) {
      await app.close?.();
    }
  }
}

export function ensureNoActiveTurn(record: ZCodeProtocolSessionRecord, message: string): void {
  if (!record.activeAbortController) {
    return;
  }
  throw new ProtocolRequestError(-32010, message);
}

export function assertExpectedProviderRevision(
  _context: ZCodeProtocolAgentServerContext,
  _record: ZCodeProtocolSessionRecord,
  expectedProviderRevision: string | undefined,
): void {
  // 兼容旧客户端字段。Provider revision 已由进程 Registry 自己管理，不再接受 Host CAS。
  void expectedProviderRevision;
}

export async function ensureSessionModelAvailableForNextTurn(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
): Promise<void> {
  if (await ensureSessionModelAvailable(context, record)) {
    record.stateRevision++;
  }
}

export async function getTaskTokenUsage(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeTaskTokenUsageParamsSchema, rawParams ?? {});
  const usageStore = context.deps.sessionStore as Partial<UsageStorePort> | undefined;
  if (!usageStore?.queryTaskUsage) {
    return {
      sessionId: params.sessionId,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      modelRequestCount: 0,
      modelErrorCount: 0,
      inputBaselineBySource: {},
    };
  }

  const usage = await usageStore.queryTaskUsage({
    sessionID: params.sessionId as SessionId,
  });
  return {
    sessionId: params.sessionId,
    totalTokens: usage.totalTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheReadTokens: usage.cacheReadTokens,
    modelRequestCount: usage.modelRequestCount,
    modelErrorCount: usage.modelErrorCount,
    inputBaselineBySource: usage.inputBaselineBySource,
  };
}

/**
 * `record.persistence` 是 runtime「会话已持久化」事实的协议侧镜像：deferred = draft（不进 session/list、
 * 不进 sessions-index、可被 expectedPersistence="deferred" 的条件关闭收回）。首发路径在 accepted 时刻
 * 抢先提升（关闭竞态需要原子判断，见 startPromptTurn / admission），但**任何**经 runtime 首次持久化的
 * 路径都必须让会话离开 draft——中枢直接启动的会话由 runtime 落行、走 controlOnly
 * 启动轮，没有首发，record 一直是 deferred，sessions-index 视其为 draft 而跳过，侧栏永远不出现。
 * 于是在事件流的唯一入口按 runtime 事实对齐一次：持久化之后 runtime 必定至少发一条事件
 * （SessionTitleUpdated first_input），紧随其后的 ingest 便把会话推进 sessions-index。
 * 测试桩的 runtime 可能没有这个方法（`as never`），缺席即不对齐。
 */
export function reconcileRecordPersistence(record: ZCodeProtocolSessionRecord): void {
  if (record.persistence !== "deferred") return;
  if (record.app.runtime?.isSessionPersisted?.() === true) record.persistence = "immediate";
}

export function integratedTerminalShellToExecutionSelection(
  selection: IntegratedTerminalShellSelection | undefined,
): ExecutionShellSelection | undefined {
  if (!selection || selection.mode === "auto") {
    return undefined;
  }
  return {
    display: {
      name: selection.dialect === "git-bash" ? "Git Bash" : "CMD",
    },
    dialect: selection.dialect,
    id: selection.id,
    label: selection.label,
    path: selection.path,
    source: "user-config",
  };
}
