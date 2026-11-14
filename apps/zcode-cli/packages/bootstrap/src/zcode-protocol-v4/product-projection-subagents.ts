// ProductProjection 域模块：shouldMaterializeSubagentProjection, materializeSubagentProjection, prospectiveSubagentRow, onSubagentSpawned 等。
// 函数签名为 (self, ...原方法参数)，方法体从 ProductProjection 原样移出；
// 只依赖上下文接口与类型基座，跨域调用一律经 self 上的方法，不直接 import 其它域模块。

import type {
  DynamicWorkflowRunProgressPayload,
  OpenCodeAgentPermissionUpdatedPayload,
  OpenCodeAgentRunUpdatedPayload,
  SwarmRunUpdatedPayload,
  SessionEvent,
} from "@zcode/contracts";
import { resolveZCodeBackgroundTaskControlKind } from "@zcode/shared";
import type {
  BackgroundWorkSummary,
  ConversationDelta,
  ConversationRow,
  RunningSubagentSummary,
  SubagentProjectionState,
  SubagentRow,
  WorkflowRunProgressEnvelope,
} from "@zcode/shared/zcode-protocol-v4";
import { diffWorkflowRunsState, reduceWorkflowRunsState } from "@zcode/shared/zcode-protocol-v4";
import type { ProductProjectionContext } from "./product-projection-context.js";

export function shouldMaterializeSubagentProjection(
  self: ProductProjectionContext,
  reduced: readonly ConversationDelta[],
): boolean {
  // 性能问题根因：cold hydration 曾让 checkpoint 等无关事件也扫描全部历史 rows。
  // 这里只在尚未发布的 batch accumulator 内按 materializer 的真实输入准入；live 与
  // strict fallback 仍走原路径，batch 之后直接写权威 manifest 的 store seed 不受影响。
  if (!self.hydrationAccumulator) return true;

  for (const delta of reduced) {
    switch (delta.op) {
      case "row.appended":
      case "row.upserted":
        if (delta.row.kind === "subagent" || self.findRow(delta.row.rowId)?.kind === "subagent") {
          return true;
        }
        break;
      case "row.delta":
        if (self.findRow(delta.rowId)?.kind === "subagent") return true;
        break;
      case "row.removed":
        // 后缀删除可能同时移除 subagent row；不为判定再预扫描一次 rows。
        return true;
      case "state.updated":
        if (
          delta.patch.pendingInteractions !== undefined ||
          delta.patch.backgroundWorks !== undefined
        ) {
          return true;
        }
        break;
      case "pluginUi.resourceUpdated":
      case "pluginUi.resourceListChanged":
      case "pluginUi.instanceClosed":
      case "pluginUi.appToolCall":
      // 非行 op：只动 workflowRuns 状态键，与 subagent 行投影的输入没有交集。
      case "workflowRun.updated":
      case "workflowRun.removed":
        break;
      default: {
        const exhaustiveDelta: never = delta;
        return exhaustiveDelta;
      }
    }
  }
  return false;
}

export function materializeSubagentProjection(
  self: ProductProjectionContext,
  reduced: readonly ConversationDelta[],
): ConversationDelta[] {
  const previous: SubagentProjectionState = self.snapshot.subagents ?? {
    revision: 0,
    childSessionIds: [],
    running: [],
    endedTotal: 0,
  };
  const previousRunningById = new Map(previous.running.map((item) => [item.childSessionId, item]));
  const latestRowByChildId = new Map<string, SubagentRow>();
  const collectSubagentRow = (row: SubagentRow | null): void => {
    if (row?.childSessionId && !self.invalidSubagentChildSessionIds.has(row.childSessionId)) {
      latestRowByChildId.set(row.childSessionId, row);
    }
  };
  // 性能问题根因：旧实现先复制完整 rows 数组，再扫描所有普通 conversation rows。
  // subagentRowIdByAgentId 已是 reducer 查找用的派生索引；这里按 rowId 去重，并通过
  // rowIndexById 恢复当前时间线顺序；row.removed 应用后会清理已失效的 alias。
  const currentRowIds = new Set(self.subagentRowIdByAgentId.values());
  for (const delta of reduced) {
    if (delta.op === "row.upserted") {
      if (delta.row.kind === "subagent" || self.findRow(delta.row.rowId)?.kind === "subagent") {
        currentRowIds.add(delta.row.rowId);
      }
    } else if (delta.op === "row.delta" && self.findRow(delta.rowId)?.kind === "subagent") {
      currentRowIds.add(delta.rowId);
    }
  }
  const currentRows: Array<{ rowIndex: number; row: ConversationRow }> = [];
  for (const rowId of currentRowIds) {
    const rowIndex = self.rowIndexById.get(rowId);
    const row = rowIndex === undefined ? undefined : self.snapshot.rows.window[rowIndex];
    if (rowIndex !== undefined && row !== undefined) currentRows.push({ rowIndex, row });
  }
  currentRows.sort((left, right) => left.rowIndex - right.rowIndex);
  for (const { row } of currentRows) {
    collectSubagentRow(self.prospectiveSubagentRow(row, reduced, 0));
  }
  for (let index = 0; index < reduced.length; index += 1) {
    const delta = reduced[index]!;
    if (delta.op !== "row.appended") continue;
    collectSubagentRow(self.prospectiveSubagentRow(delta.row, reduced, index + 1));
  }

  let pendingInteractions = self.snapshot.pendingInteractions;
  let backgroundWorks = self.snapshot.backgroundWorks;
  for (const delta of reduced) {
    if (delta.op !== "state.updated") continue;
    if (delta.patch.pendingInteractions !== undefined) {
      pendingInteractions = delta.patch.pendingInteractions;
    }
    if (delta.patch.backgroundWorks !== undefined) {
      backgroundWorks = delta.patch.backgroundWorks;
    }
  }
  const waitingChildIds = new Set<string>();
  // workspace-hook-trust 新增的 hook review 交互 payload 没有 origin 字段，跳过守卫避免误读。
  for (const interaction of pendingInteractions) {
    if (!("origin" in interaction.payload)) continue;
    const origin = interaction.payload.origin;
    if (origin?.kind === "subagent") waitingChildIds.add(origin.childSessionId);
  }
  const blockedChildIds = new Set(
    backgroundWorks.flatMap((work) =>
      work.kind === "subagent" && work.status === "running" && work.blocked && work.childSessionId
        ? [work.childSessionId]
        : [],
    ),
  );

  const childSessionIds = [...latestRowByChildId.keys()];
  const running: RunningSubagentSummary[] = [];
  for (const [childSessionId, row] of latestRowByChildId) {
    if (row.status !== "running") continue;
    const previousItem = previousRunningById.get(childSessionId);
    const title = previousItem?.title || row.summaryText.trim() || row.subagentType;
    running.push({
      childSessionId,
      agentId: row.entityId,
      ...(row.parentToolCallId ? { toolCallId: row.parentToolCallId } : {}),
      subagentType: row.subagentType,
      title,
      status: waitingChildIds.has(childSessionId)
        ? "waiting"
        : blockedChildIds.has(childSessionId)
          ? "blocked"
          : "running",
      ...(row.startedAt !== undefined ? { startedAt: row.startedAt } : {}),
    });
  }
  running.sort(
    (left, right) =>
      (right.startedAt ?? 0) - (left.startedAt ?? 0) ||
      right.childSessionId.localeCompare(left.childSessionId),
  );
  const endedTotal = childSessionIds.length - running.length;
  const semanticState = { childSessionIds, running, endedTotal };
  if (
    JSON.stringify(semanticState) ===
    JSON.stringify({
      childSessionIds: previous.childSessionIds,
      running: previous.running,
      endedTotal: previous.endedTotal,
    })
  ) {
    return [];
  }
  return [
    {
      op: "state.updated",
      patch: {
        subagents: {
          revision: previous.revision + 1,
          ...semanticState,
        },
      },
    },
  ];
}

export function prospectiveSubagentRow(
  self: ProductProjectionContext,
  row: ConversationRow,
  reduced: readonly ConversationDelta[],
  startIndex: number,
): SubagentRow | null {
  let prospective: ConversationRow | null = row;
  for (let index = startIndex; index < reduced.length && prospective; index += 1) {
    const delta = reduced[index]!;
    switch (delta.op) {
      case "row.appended":
      case "state.updated":
      case "pluginUi.resourceUpdated":
      case "pluginUi.resourceListChanged":
      case "pluginUi.instanceClosed":
      case "pluginUi.appToolCall":
      // 非行 op：改不了这一行的 prospective 形态。
      case "workflowRun.updated":
      case "workflowRun.removed":
        break;
      case "row.upserted":
        if (delta.row.rowId === prospective.rowId) prospective = delta.row;
        break;
      case "row.delta":
        if (
          delta.rowId === prospective.rowId &&
          delta.path === "summaryText" &&
          prospective.kind === "subagent"
        ) {
          prospective = {
            ...prospective,
            summaryText: prospective.summaryText + delta.append,
          };
        }
        break;
      case "row.removed":
        if (prospective.rowId >= delta.fromRowId) prospective = null;
        break;
      default: {
        const exhaustiveDelta: never = delta;
        return exhaustiveDelta;
      }
    }
  }
  return prospective?.kind === "subagent" ? prospective : null;
}

export function onSubagentSpawned(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as Record<string, unknown>;
  const agentId = self.subagentAgentId(payload, event);
  const existing = self.findSubagentLifecycleRow(agentId, payload, event);
  if (existing) self.subagentRowIdByAgentId.set(agentId, existing.rowId);
  const childSessionId = self.stringPayload(payload, "childSessionId");
  const parentToolCallId = self.stringPayload(payload, "parentToolCallId");
  const resumedBackgroundWork = self.resumedSubagentBackgroundWorkDelta(
    event,
    payload,
    agentId,
    childSessionId,
  );
  if (
    existing?.status === "running" &&
    (!childSessionId || childSessionId === existing.childSessionId) &&
    (!parentToolCallId || parentToolCallId === existing.parentToolCallId) &&
    (payload.background !== true || existing.backgrounded === true)
  ) {
    return resumedBackgroundWork ? [resumedBackgroundWork] : [];
  }
  if (existing) {
    const row: SubagentRow = {
      ...existing,
      status: "running",
      summaryText:
        self.stringPayload(payload, "description") ??
        self.stringPayload(payload, "prompt") ??
        existing.summaryText,
      // resume 事件携带的是 SendMessage call id，但 parentToolCallId 是 row 的创建锚点；
      // 已存在的锚点不能作为生命周期字段被覆盖，否则 UI 无法再关联原 Agent 行。
      ...(!existing.parentToolCallId && parentToolCallId ? { parentToolCallId } : {}),
      ...(childSessionId ? { childSessionId } : {}),
      ...(self.stringPayload(payload, "reasoningLevel")
        ? { reasoningLevel: self.stringPayload(payload, "reasoningLevel") }
        : {}),
      ...(payload.background === true ? { backgrounded: true as const } : {}),
      ...(payload.background === true ? { workId: agentId } : {}),
      startedAt: self.ms(event),
    };
    delete row.endedAt;
    return [{ op: "row.upserted", row }, ...(resumedBackgroundWork ? [resumedBackgroundWork] : [])];
  }
  const row: SubagentRow = {
    ...self.rowBase(event, self.turnIdOf(event), agentId),
    kind: "subagent",
    ...(self.stringPayload(payload, "parentToolCallId")
      ? { parentToolCallId: self.stringPayload(payload, "parentToolCallId") }
      : {}),
    subagentType: self.stringPayload(payload, "agentType") ?? "subagent",
    status: "running",
    summaryText:
      self.stringPayload(payload, "description") ??
      self.stringPayload(payload, "summaryText") ??
      self.stringPayload(payload, "prompt") ??
      "",
    ...(self.stringPayload(payload, "childSessionId")
      ? { childSessionId: self.stringPayload(payload, "childSessionId") }
      : {}),
    ...(self.stringPayload(payload, "reasoningLevel")
      ? { reasoningLevel: self.stringPayload(payload, "reasoningLevel") }
      : {}),
    ...(payload.background === true ? { backgrounded: true as const } : {}),
    ...(payload.background === true ? { workId: agentId } : {}),
    startedAt: self.ms(event),
  };
  self.subagentRowIdByAgentId.set(agentId, row.rowId);
  return [{ op: "row.appended", row }, ...(resumedBackgroundWork ? [resumedBackgroundWork] : [])];
}

export function resumedSubagentBackgroundWorkDelta(
  self: ProductProjectionContext,
  event: SessionEvent,
  payload: Record<string, unknown>,
  agentId: string,
  childSessionId: string | undefined,
): ConversationDelta | undefined {
  if (payload.background !== true || payload.resumed !== true || !childSessionId) {
    return undefined;
  }

  // SendMessage resume 直接进入 subagent port，不经过 Agent tool executor，
  // 因而不会产生 tracker 的 BackgroundTaskStarted。SubagentSpawned 已是单一启动事实，
  // 这里在同一次 V4 transaction 内补齐可取消 work，避免再引入第二个可失败事件。
  const previous = self.snapshot.backgroundWorks;
  const existing = previous.find((work) => work.workId === agentId);
  const title =
    self.stringPayload(payload, "description") ??
    self.stringPayload(payload, "prompt") ??
    existing?.title ??
    agentId;
  if (
    existing?.status === "running" &&
    existing.kind === "subagent" &&
    existing.title === title &&
    existing.childSessionId === childSessionId &&
    existing.cancellable === true
  ) {
    return undefined;
  }
  const next: BackgroundWorkSummary = {
    workId: agentId,
    kind: "subagent",
    title,
    status: "running",
    startedAt: self.ms(event),
    cancellable: true,
    anchorRowId: existing?.anchorRowId ?? null,
    childSessionId,
  };
  const backgroundWorks = existing
    ? previous.map((work) => (work.workId === agentId ? next : work))
    : [...previous, next];
  return { op: "state.updated", patch: { backgroundWorks } };
}

export function onSubagentMessage(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as Record<string, unknown>;
  const row = self.findSubagentRow(self.subagentAgentId(payload, event));
  const append =
    self.stringPayload(payload, "summaryText") ??
    self.stringPayload(payload, "text") ??
    self.stringPayload(payload, "message");
  if (!row || !append) return [];
  return [{ op: "row.delta", rowId: row.rowId, path: "summaryText", append }];
}

export function onSubagentStopped(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as Record<string, unknown>;
  const agentId = self.subagentAgentId(payload, event);
  const existing = self.findSubagentLifecycleRow(agentId, payload, event);
  const parentToolCallId = self.stringPayload(payload, "parentToolCallId");
  const status = self.mapSubagentStatus(self.stringPayload(payload, "status"));
  const summaryText =
    self.stringPayload(payload, "summaryText") ??
    self.stringPayload(payload, "result") ??
    self.stringPayload(payload, "error") ??
    self.stringPayload(payload, "description") ??
    existing?.summaryText ??
    "";
  const totalTokens =
    typeof payload.totalTokens === "number" && Number.isFinite(payload.totalTokens)
      ? payload.totalTokens
      : undefined;
  const totalDurationMs =
    typeof payload.totalDurationMs === "number" && Number.isFinite(payload.totalDurationMs)
      ? payload.totalDurationMs
      : undefined;
  const subtreeTotalTokens =
    typeof payload.subtreeTotalTokens === "number" && Number.isFinite(payload.subtreeTotalTokens)
      ? payload.subtreeTotalTokens
      : undefined;
  const subtreeTotalDurationMs =
    typeof payload.subtreeTotalDurationMs === "number" &&
    Number.isFinite(payload.subtreeTotalDurationMs)
      ? payload.subtreeTotalDurationMs
      : undefined;
  const subtreeToolUseCount =
    typeof payload.subtreeToolUseCount === "number" &&
    Number.isFinite(payload.subtreeToolUseCount)
      ? payload.subtreeToolUseCount
      : undefined;
  const row: SubagentRow = existing
    ? {
        ...existing,
        status,
        summaryText,
        endedAt: self.ms(event),
        ...(totalTokens === undefined ? {} : { totalTokens }),
        ...(totalDurationMs === undefined ? {} : { totalDurationMs }),
        ...(subtreeTotalTokens === undefined ? {} : { subtreeTotalTokens }),
        ...(subtreeTotalDurationMs === undefined ? {} : { subtreeTotalDurationMs }),
        ...(subtreeToolUseCount === undefined ? {} : { subtreeToolUseCount }),
        // resumed child 的终态同样属于原 Agent row，只在旧 row 缺失锚点时补齐。
        ...(!existing.parentToolCallId && parentToolCallId ? { parentToolCallId } : {}),
        ...(self.stringPayload(payload, "childSessionId")
          ? { childSessionId: self.stringPayload(payload, "childSessionId") }
          : {}),
      }
    : {
        ...self.rowBase(event, self.turnIdOf(event), agentId),
        kind: "subagent",
        ...(self.stringPayload(payload, "parentToolCallId")
          ? {
              parentToolCallId: self.stringPayload(payload, "parentToolCallId"),
            }
          : {}),
        subagentType: self.stringPayload(payload, "agentType") ?? "subagent",
        status,
        summaryText,
        ...(self.stringPayload(payload, "childSessionId")
          ? { childSessionId: self.stringPayload(payload, "childSessionId") }
          : {}),
        ...(payload.background === true ? { backgrounded: true as const } : {}),
        ...(payload.background === true ? { workId: agentId } : {}),
        endedAt: self.ms(event),
        ...(totalTokens === undefined ? {} : { totalTokens }),
        ...(totalDurationMs === undefined ? {} : { totalDurationMs }),
        ...(subtreeTotalTokens === undefined ? {} : { subtreeTotalTokens }),
        ...(subtreeTotalDurationMs === undefined ? {} : { subtreeTotalDurationMs }),
        ...(subtreeToolUseCount === undefined ? {} : { subtreeToolUseCount }),
      };
  self.subagentRowIdByAgentId.set(agentId, row.rowId);
  return [{ op: existing ? "row.upserted" : "row.appended", row }];
}

export function onOpenCodeAgentRunUpdated(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as OpenCodeAgentRunUpdatedPayload;
  const existing = self.snapshot.rows.window.find(
    (candidate) => candidate.kind === "externalAgentRun" && candidate.runId === payload.runId,
  );
  const row: ConversationRow = {
    ...(existing ?? self.rowBase(event, `external:${payload.runId}`, payload.runId)),
    kind: "externalAgentRun",
    runId: payload.runId,
    commandId: payload.commandId,
    provider: "opencode-cli",
    ...(payload.modelId ? { modelId: payload.modelId } : {}),
    promptText: payload.promptText,
    output: { text: payload.outputText },
    tools: payload.tools,
    status: payload.status,
    ...(payload.status === "starting" || payload.status === "running"
      ? {}
      : { pendingPermissions: [] }),
    ...(payload.startedAt !== undefined ? { startedAt: payload.startedAt } : {}),
    ...(payload.endedAt !== undefined ? { endedAt: payload.endedAt } : {}),
    ...(payload.diagnosticCode ? { diagnosticCode: payload.diagnosticCode } : {}),
  };
  const deltas: ConversationDelta[] = [{ op: existing ? "row.upserted" : "row.appended", row }];
  const otherWorks = self.snapshot.control.activeWorks.filter(
    (work) => !(work.kind === "externalAgentRun" && work.runId === payload.runId),
  );
  const active = payload.status === "starting" || payload.status === "running";
  if (active) {
    deltas.push({
      op: "state.updated",
      patch: self.controlPatch({
        phase: "running",
        sessionEnded: false,
        activeWorks: [
          ...otherWorks,
          {
            kind: "externalAgentRun",
            commandId: payload.commandId,
            runId: payload.runId,
            sourceCommandId: payload.commandId,
            startedAt: payload.startedAt ?? self.ms(event),
          },
        ],
        canStop: true,
        stopState: "stoppable",
        stopTargetKind: otherWorks.length > 0 ? "mixed" : "externalAgentRun",
      }),
    });
  } else {
    const phase =
      payload.status === "completed"
        ? "completedSuccess"
        : payload.status === "failed"
          ? "error"
          : "completedInterrupted";
    deltas.push({
      op: "state.updated",
      patch: self.controlPatch({
        ...(otherWorks.length === 0 ? { phase, sessionEnded: phase !== "error" } : {}),
        activeWorks: otherWorks,
        canStop: otherWorks.length > 0,
        stopState: otherWorks.length > 0 ? "stoppable" : "idle",
        stopTargetKind:
          otherWorks.length === 0
            ? "unknown"
            : otherWorks.length > 1
              ? "mixed"
              : self.snapshot.control.stopTargetKind,
      }),
    });
  }
  return deltas;
}

export function onSwarmRunUpdated(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as SwarmRunUpdatedPayload;
  const existing = self.snapshot.rows.window.find(
    (candidate) => candidate.kind === "swarmRun" && candidate.swarmRunId === payload.swarmRunId,
  );
  const childSessionIds = Array.isArray(payload.childSessionIds)
    ? [
        ...new Set(
          payload.childSessionIds.filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          ),
        ),
      ].slice(0, 128)
    : existing?.kind === "swarmRun"
      ? existing.childSessionIds
      : undefined;
  const childAgentTypes =
    payload.childAgentTypes && childSessionIds
      ? Object.fromEntries(
          childSessionIds.flatMap((sessionId) => {
            const agentType = payload.childAgentTypes?.[sessionId];
            return typeof agentType === "string" && agentType.trim()
              ? [[sessionId, agentType.trim().slice(0, 80)]]
              : [];
          }),
        )
      : existing?.kind === "swarmRun"
        ? existing.childAgentTypes
        : undefined;
  const isTerminal =
    payload.status === "completed" || payload.status === "failed" || payload.status === "cancelled";
  const outcomeAcceptance =
    payload.outcomeAcceptance ??
    (isTerminal
      ? "unknown"
      : existing?.kind === "swarmRun"
        ? existing.outcomeAcceptance
        : undefined);
  const row: ConversationRow = {
    ...(existing ?? self.rowBase(event, `swarm:${payload.swarmRunId}`, payload.swarmRunId)),
    kind: "swarmRun",
    swarmRunId: payload.swarmRunId,
    status: payload.status,
    ...(outcomeAcceptance === undefined ? {} : { outcomeAcceptance }),
    ...(payload.taskCount === undefined ? {} : { taskCount: payload.taskCount }),
    ...(childSessionIds === undefined ? {} : { childSessionIds }),
    ...(childAgentTypes === undefined ? {} : { childAgentTypes }),
    ...(payload.summary === undefined ? {} : { summary: payload.summary.slice(0, 500) }),
  };
  return [{ op: existing ? "row.upserted" : "row.appended", row }];
}

export function onOpenCodeAgentPermissionUpdated(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as OpenCodeAgentPermissionUpdatedPayload;
  const existing = self.snapshot.rows.window.find(
    (candidate) =>
      candidate.kind === "externalAgentRun" &&
      candidate.runId === payload.runId &&
      candidate.commandId === payload.commandId,
  );
  if (!existing || existing.kind !== "externalAgentRun") return [];
  if (existing.status !== "starting" && existing.status !== "running") return [];
  const pending = existing.pendingPermissions ?? [];
  const next =
    payload.state === "requested" && payload.request
      ? [
          ...pending.filter((request) => request.requestId !== payload.requestId),
          {
            requestId: payload.requestId,
            opencodeSessionId: payload.opencodeSessionId,
            ...payload.request,
          },
        ].slice(-32)
      : pending.filter(
          (request) =>
            request.requestId !== payload.requestId ||
            request.opencodeSessionId !== payload.opencodeSessionId,
        );
  const row: ConversationRow = { ...existing, pendingPermissions: next };
  return [{ op: "row.upserted", row }];
}

export function onBackgroundTaskLifecycle(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as {
    taskId?: string;
    toolName?: string;
    taskKind?: string;
    command?: string;
    description?: string;
    status?: string;
    cancellable?: boolean;
    blocked?: boolean;
    childSessionId?: string;
  };
  const workId = payload.taskId;
  if (!workId) return [];
  const prev = self.snapshot.backgroundWorks;
  const existing = prev.find((work) => work.workId === workId);
  const legacyKind = resolveZCodeBackgroundTaskControlKind(payload);
  // 新事件使用 runtime 的显式 taskKind；旧事件统一走 shared resolver，
  // 不能再在 reducer 内散落 Agent/Task/subagent 字符串分支。
  // "workflow" 是 workflow run（此前错标成 bash）；legacy resolver 里没有对应值，因为
  // legacy `Workflow` 工具刻意仍归 bash——两者是不同的东西，共用类别会让面板混在一起。
  const kind: BackgroundWorkSummary["kind"] =
    payload.taskKind === "subagent"
      ? "subagent"
      : payload.taskKind === "bash"
        ? "bash"
        : payload.taskKind === "workflow"
          ? "workflow"
          : legacyKind === "agent"
            ? "subagent"
            : legacyKind === "bash"
              ? "bash"
              : (existing?.kind ?? "bash");
  // 事件 status（running/completed/failed/timed_out/cancelled/spawn_error/lost）
  // → summary status（running/resultPending/failed/cancelled）。
  const rawStatus = payload.status ?? "running";
  const status: "running" | "resultPending" | "failed" | "cancelled" =
    rawStatus === "running"
      ? "running"
      : rawStatus === "cancelled"
        ? "cancelled"
        : rawStatus === "completed"
          ? "resultPending"
          : "failed";
  const title =
    payload.description?.trim() ||
    payload.command?.trim() ||
    existing?.title ||
    payload.toolName ||
    workId;
  const next: BackgroundWorkSummary = {
    workId,
    kind,
    title,
    status,
    startedAt: existing?.startedAt ?? self.ms(event),
    ...(status === "running" ? {} : { endedAt: self.ms(event) }),
    ...(typeof payload.cancellable === "boolean"
      ? { cancellable: payload.cancellable }
      : existing?.cancellable !== undefined
        ? { cancellable: existing.cancellable }
        : {}),
    ...(typeof payload.blocked === "boolean"
      ? { blocked: payload.blocked }
      : existing?.blocked !== undefined
        ? { blocked: existing.blocked }
        : {}),
    anchorRowId: existing?.anchorRowId ?? null,
    ...(payload.childSessionId
      ? { childSessionId: payload.childSessionId }
      : existing?.childSessionId
        ? { childSessionId: existing.childSessionId }
        : {}),
  };
  // 幂等：内容无变化不产 delta。
  if (
    existing &&
    existing.status === next.status &&
    existing.title === next.title &&
    existing.kind === next.kind &&
    existing.cancellable === next.cancellable &&
    existing.blocked === next.blocked &&
    existing.childSessionId === next.childSessionId
  ) {
    return [];
  }
  const backgroundWorks = existing
    ? prev.map((work) => (work.workId === workId ? next : work))
    : [...prev, next];
  return [{ op: "state.updated", patch: { backgroundWorks } }];
}

export function onDynamicWorkflowRunProgress(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  // 先转 contracts 的有界 payload、再赋给 shared 的结构化入参：这行赋值就是"两边形状不漂移"
  // 的编译期闸（shared 不得反向依赖 contracts，所以入参类型只能结构化定义）。
  const envelope: WorkflowRunProgressEnvelope = event.payload as DynamicWorkflowRunProgressPayload;
  const prior = self.snapshot.workflowRuns;
  const workflowRuns = reduceWorkflowRunsState(prior, envelope);
  // null = 语义无变化（无效事件或同一条事件重放）：不产 delta，revision 不抬。
  if (workflowRuns === null) return [];
  // 发**差**而不是整键：一条引擎事件只动一个节点，整键重发是每事件 O(N) 字节、一条 run
  // 全程 O(N²)（workflow-runs-delta.ts 的文件头讲了这笔账怎么变成节点上界和 UI 卡死的）。
  // `applyAll(prior, diff(prior, next))` 与 next **逐字节**一致是被 property 测试钉住的契约，
  // 所以 applyEventInternal 把这串 delta 应用回去之后，self.snapshot.workflowRuns 仍是 next。
  return diffWorkflowRunsState(prior, workflowRuns);
}

export function findSubagentRow(
  self: ProductProjectionContext,
  agentId: string,
): SubagentRow | undefined {
  const rowId = self.subagentRowIdByAgentId.get(agentId);
  if (rowId === undefined) return undefined;
  const row = self.findRow(rowId);
  return row?.kind === "subagent" ? row : undefined;
}

export function findSubagentLifecycleRow(
  self: ProductProjectionContext,
  agentId: string,
  payload: Record<string, unknown>,
  event: SessionEvent,
): SubagentRow | undefined {
  const exact = self.findSubagentRow(agentId);
  if (exact) return exact;

  const parentToolCallId = self.stringPayload(payload, "parentToolCallId");
  if (!parentToolCallId) return undefined;
  const turnId = self.turnIdOf(event);
  // 晚订阅 hydration 无法从后台 Agent 的文本 tool output 恢复真实 agentId，
  // 会先用 toolCallId 合成一条 SubagentRow。后到的 live lifecycle 携带真实 agentId，
  // 旧逻辑因此追加第二行，UI 又会让无 childSessionId 的合成行抢占配对。父 tool call
  // 在同一 turn 内是稳定唯一身份，这里将真实事件归并回合成行并补齐 childSessionId。
  return self.snapshot.rows.window.find(
    (row): row is SubagentRow =>
      row.kind === "subagent" && row.turnId === turnId && row.parentToolCallId === parentToolCallId,
  );
}

export function subagentAgentId(
  self: ProductProjectionContext,
  payload: Record<string, unknown>,
  event: SessionEvent,
): string {
  return (
    self.stringPayload(payload, "agentId") ??
    self.stringPayload(payload, "childSessionId") ??
    self.stringPayload(payload, "parentToolCallId") ??
    `subagent-${event.sequenceNumber}`
  );
}

export function stringPayload(
  self: ProductProjectionContext,
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function mapSubagentStatus(
  self: ProductProjectionContext,
  status: string | undefined,
): SubagentRow["status"] {
  switch (status) {
    case "completed":
    case "success":
      return "success";
    case "cancelled":
    case "stopped":
      return "cancelled";
    default:
      return "failed";
  }
}
