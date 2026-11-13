// ProductProjection 域模块：closeOpenToolRows, isOpenForegroundToolRow, updateToolIndexesAfterDeltas, pruneRemovedSubagentIndexes 等。
// 函数签名为 (self, ...原方法参数)，方法体从 ProductProjection 原样移出；
// 只依赖上下文接口与类型基座，跨域调用一律经 self 上的方法，不直接 import 其它域模块。

import type {
  SessionEvent,
  StreamingToolLedgerPayload,
  ToolCallErrorPayload,
  ToolCallProgressPayload,
  ToolCallResultPayload,
  ToolCallScheduledPayload,
  ToolCallStartedPayload,
} from "@zcode/contracts";
import { DEFERRED_TOOL_CALL_NAME, CoreErrorType } from "@zcode/contracts";
import { projectToolActivity } from "./product-projection-bash-progress.js";
import {
  ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS,
  extractPlanStepsFromToolInput,
  extractPlanStepsFromToolOutput,
  isZCodeFileStreamingToolInputPreviewTool,
} from "@zcode/shared";
import type { ConversationDelta, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { shouldHideInvalidToolCallFromProduct } from "../tool-call-product-visibility.js";
import {
  parseListAppsSnapshot,
  readOfficialCuaAction,
  resolveCuaAppIdentity,
} from "./cua-app-snapshot.js";
import { type CanonicalModelStream } from "./event-normalizer.js";
import { buildToolOutput } from "./projection-rows.js";
import { stringifyToolInput, toProtocolToolCallDisplay } from "./product-projection-types.js";
import type { ProductProjectionContext } from "./product-projection-context.js";

export function closeOpenToolRows(
  self: ProductProjectionContext,
  event: SessionEvent,
  status: "cancelled" | "error",
  only?: (row: ToolCallRow) => boolean,
): ConversationDelta[] {
  if (self.openForegroundToolCallIds.size === 0) return [];
  const openRows: ToolCallRow[] = [];
  for (const toolCallId of self.openForegroundToolCallIds) {
    const row = self.findToolRow(toolCallId);
    // 派生索引不能成为第二份权威状态；收口前始终以当前 snapshot row 复核。
    if (!row || !self.isOpenForegroundToolRow(row)) continue;
    if (only && !only(row)) continue;
    openRows.push(row);
  }
  if (openRows.length === 0) return [];
  // Set 可能因迟到 reopen 改变插入顺序；rowId 单调递增，排序后保持旧 timeline delta 顺序。
  if (openRows.length > 1) {
    openRows.sort((left, right) => left.rowId - right.rowId);
  }
  const deltas: ConversationDelta[] = [];
  const closedToolCallIds = new Set<string>();
  for (const row of openRows) {
    const next: ToolCallRow = {
      ...row,
      status,
      inputText: `${row.inputText ?? ""}${self.takePendingStreamingToolInput(row.toolCallId)}`,
      endedAt: self.ms(event),
    };
    delete next.approvalInteractionId;
    if (status === "error") {
      // executor 早退或事件缺失时，旧投影只在 stop 路径收口工具；
      // success/error turn 会留下运行态行，cold snapshot 缺 header 后被 UI 误判为 thinking。
      next.error = {
        code: "fault.runtime.toolLifecycleIncomplete",
        message: "Tool call ended without a terminal event.",
      };
    } else {
      delete next.error;
    }
    closedToolCallIds.add(row.toolCallId);
    deltas.push({ op: "row.upserted", row: next });
  }

  const pendingInteractions = self.snapshot.pendingInteractions.filter(
    (interaction) =>
      !(
        (interaction.payload.kind === "permission" || interaction.payload.kind === "userInput") &&
        typeof interaction.payload.toolCallId === "string" &&
        closedToolCallIds.has(interaction.payload.toolCallId)
      ),
  );
  if (pendingInteractions.length !== self.snapshot.pendingInteractions.length) {
    deltas.push({ op: "state.updated", patch: { pendingInteractions } });
  }
  return deltas;
}

export function isOpenForegroundToolRow(self: ProductProjectionContext, row: ToolCallRow): boolean {
  return (
    row.backgrounded !== true &&
    (row.status === "inputStreaming" ||
      row.status === "pendingApproval" ||
      row.status === "running")
  );
}

export function updateToolIndexesAfterDeltas(
  self: ProductProjectionContext,
  deltas: readonly ConversationDelta[],
): void {
  for (const delta of deltas) {
    if (delta.op === "row.appended" || delta.op === "row.upserted") {
      if (delta.row.kind !== "toolCall") continue;
      if (self.isOpenForegroundToolRow(delta.row)) {
        self.openForegroundToolCallIds.add(delta.row.toolCallId);
      } else {
        self.openForegroundToolCallIds.delete(delta.row.toolCallId);
      }
      continue;
    }
    if (delta.op !== "row.removed") continue;
    for (const [toolCallId, rowId] of self.toolRowIdByCallId) {
      if (rowId < delta.fromRowId) continue;
      // Bug 原因：rewind 过去只删 rows/message 索引，旧 toolCallId 仍会阻止新分支
      // 重新打开同 id 的流式工具；open tracker 也会留下已经不存在的 row。
      self.toolRowIdByCallId.delete(toolCallId);
      self.openForegroundToolCallIds.delete(toolCallId);
      self.fileToolInputPreviewByCallId.delete(toolCallId);
    }
    self.pruneRemovedSubagentIndexes();
  }
}

export function pruneRemovedSubagentIndexes(self: ProductProjectionContext): void {
  for (const [agentId, rowId] of self.subagentRowIdByAgentId) {
    if (self.findRow(rowId)?.kind === "subagent") continue;
    // Bug 原因：rewind 只重建 rowIndex，旧 agent alias 仍会被后续每次 subagent
    // materialization 枚举。仅在 row.removed 已应用后按权威 snapshot 清理一次，
    // 避免长会话随已删除历史持续增长；普通事件不会扫描该索引。
    self.subagentRowIdByAgentId.delete(agentId);
  }
}

export function openToolRow(
  self: ProductProjectionContext,
  event: SessionEvent,
  payload: CanonicalModelStream,
  entityId?: string,
): ConversationDelta[] {
  const toolCallId = String(payload.toolCallId ?? "");
  if (
    toolCallId === "" ||
    shouldHideInvalidToolCallFromProduct(payload.toolName) ||
    self.toolRowIdByCallId.has(toolCallId)
  ) {
    return [];
  }
  const row: ToolCallRow = {
    ...self.rowBase(event, self.turnIdOf(event), toolCallId),
    kind: "toolCall",
    ...(payload.assistantResponseId ? { assistantResponseId: payload.assistantResponseId } : {}),
    toolCallId,
    toolName: payload.toolName ?? "",
    status: "inputStreaming",
    inputText: "",
  };
  self.toolRowIdByCallId.set(toolCallId, row.rowId);
  if (isZCodeFileStreamingToolInputPreviewTool(row.toolName)) {
    self.fileToolInputPreviewByCallId.set(toolCallId, {
      lastPublishedAt: null,
      pendingAppend: "",
    });
  }
  if (entityId) self.entityIdByRowId.set(row.rowId, entityId);
  return [{ op: "row.appended", row }];
}

export function appendStreamingToolInput(
  self: ProductProjectionContext,
  event: SessionEvent,
  payload: CanonicalModelStream,
): ConversationDelta[] {
  const toolCallId = String(payload.toolCallId ?? "");
  const rowId = self.toolRowIdByCallId.get(toolCallId);
  if (rowId === undefined || self.findToolRow(toolCallId)?.input !== undefined) return [];
  const state = self.fileToolInputPreviewByCallId.get(toolCallId);
  if (!state) {
    return [{ op: "row.delta", rowId, path: "inputText", append: payload.delta }];
  }

  state.pendingAppend += payload.delta;
  const now = self.ms(event);
  if (
    state.lastPublishedAt !== null &&
    now - state.lastPublishedAt < ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS
  ) {
    return [];
  }

  const append = state.pendingAppend;
  state.pendingAppend = "";
  state.lastPublishedAt = now;
  return append === "" ? [] : [{ op: "row.delta", rowId, path: "inputText", append }];
}

export function flushStreamingToolInput(
  self: ProductProjectionContext,
  toolCallId: string,
): ConversationDelta[] {
  const append = self.takePendingStreamingToolInput(toolCallId);
  if (append === "") return [];
  const rowId = self.toolRowIdByCallId.get(toolCallId);
  return rowId === undefined ? [] : [{ op: "row.delta", rowId, path: "inputText", append }];
}

export function takePendingStreamingToolInput(
  self: ProductProjectionContext,
  toolCallId: string,
): string {
  const state = self.fileToolInputPreviewByCallId.get(toolCallId);
  self.fileToolInputPreviewByCallId.delete(toolCallId);
  return state?.pendingAppend ?? "";
}

export function finalizeStreamingToolInput(
  self: ProductProjectionContext,
  event: SessionEvent,
  payload: CanonicalModelStream,
): ConversationDelta[] {
  const toolCallId = String(payload.toolCallId ?? "");
  if (toolCallId === "") return [];
  self.fileToolInputPreviewByCallId.delete(toolCallId);
  if (shouldHideInvalidToolCallFromProduct(payload.toolName)) return [];
  const inputText = stringifyToolInput(payload.input);
  const existing = self.findToolRow(toolCallId);
  // scheduled 或完整 tool_call 已定稿输入；迟到原始流不能覆盖执行身份。
  if (existing?.input !== undefined) return [];
  if (existing) {
    return [
      {
        op: "row.upserted",
        row: {
          ...existing,
          ...(payload.assistantResponseId
            ? { assistantResponseId: payload.assistantResponseId }
            : {}),
          toolName: existing.toolName || payload.toolName || "",
          inputText,
          input: payload.input,
        },
      },
    ];
  }

  const row: ToolCallRow = {
    ...self.rowBase(event, self.turnIdOf(event), toolCallId),
    kind: "toolCall",
    ...(payload.assistantResponseId ? { assistantResponseId: payload.assistantResponseId } : {}),
    toolCallId,
    toolName: payload.toolName ?? "",
    status: "inputStreaming",
    inputText,
    input: payload.input,
  };
  self.toolRowIdByCallId.set(toolCallId, row.rowId);
  return [{ op: "row.appended", row }];
}

export function onStreamingToolIdentity(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  if (self.isMirroredSubagentToolEvent(event) || !self.acceptsActiveModelEvent(event)) return [];
  const payload = event.payload as StreamingToolLedgerPayload;
  if (
    payload.status !== "tool_call_closed" ||
    payload.input === undefined ||
    payload.toolName === DEFERRED_TOOL_CALL_NAME ||
    shouldHideInvalidToolCallFromProduct(payload.toolName)
  )
    return [];
  const row = self.findToolRow(String(payload.toolCallId));
  if (row?.toolName !== DEFERRED_TOOL_CALL_NAME) return [];
  // 断流恢复可能直接提交工具错误而不经过 scheduled；目标身份取 Core 已闭合的调用，
  // 只补齐包装行，不触发 scheduled 的 Todo 等业务更新，也不重置已有状态和错误。
  return [
    {
      op: "row.upserted",
      row: {
        ...row,
        toolName: payload.toolName,
        input: payload.input,
        inputText: stringifyToolInput(payload.input),
      },
    },
  ];
}

export function onToolCallScheduled(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  if (self.isMirroredSubagentToolEvent(event) || !self.isRunning()) return [];
  const payload = event.payload as ToolCallScheduledPayload;
  const toolCallId = String(payload.toolCallId);
  self.fileToolInputPreviewByCallId.delete(toolCallId);
  if (shouldHideInvalidToolCallFromProduct(payload.toolName)) return [];
  const inputText = stringifyToolInput(payload.input);
  const cuaAction = readOfficialCuaAction(payload.toolName);
  const cuaApp =
    cuaAction && cuaAction !== "list_apps"
      ? resolveCuaAppIdentity(payload.input, self.latestListAppsSnapshot)
      : undefined;
  const existing = self.findToolRow(toolCallId);
  const planDeltas = self.todoPlanDeltas(
    event,
    extractPlanStepsFromToolInput({
      title: payload.toolName,
      kind: payload.toolName,
      input: payload.input,
    }),
  );
  if (existing) {
    // replayable 会过滤 row.delta(inputText)，定稿 upsert 必须携带完整 inputText。
    // 否则断线恢复只能看到结构化 input，丢失 v4 row 的输入文本终态。
    return [
      {
        op: "row.upserted",
        row: {
          ...existing,
          toolName: payload.toolName,
          ...(payload.assistantMessageId
            ? { assistantResponseId: String(payload.assistantMessageId) }
            : {}),
          inputText,
          input: payload.input,
          ...(cuaApp ? { cuaApp } : {}),
          ...(payload.display?.kind === "mcp_tool" ? { display: payload.display } : {}),
        },
      },
      ...planDeltas,
    ];
  }
  const row: ToolCallRow = {
    ...self.rowBase(event, self.turnIdOf(event), toolCallId),
    kind: "toolCall",
    ...(payload.assistantMessageId
      ? { assistantResponseId: String(payload.assistantMessageId) }
      : {}),
    toolCallId,
    toolName: payload.toolName,
    status: "inputStreaming",
    inputText,
    input: payload.input,
    ...(cuaApp ? { cuaApp } : {}),
    ...(payload.display?.kind === "mcp_tool" ? { display: payload.display } : {}),
  };
  self.toolRowIdByCallId.set(toolCallId, row.rowId);
  return [{ op: "row.appended", row }, ...planDeltas];
}

export function onToolCallActivity(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  if (self.isMirroredSubagentToolEvent(event) || !self.isRunning()) return [];
  const payload = event.payload as ToolCallStartedPayload;
  self.recordHighspeedToolStarted(self.turnIdOf(event), String(payload.toolCallId), self.ms(event));
  const row = self.findToolRow(String(payload.toolCallId));
  if (!row) return [];
  return projectToolActivity(event, row);
}

export function onToolCallProgress(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  if (self.isMirroredSubagentToolEvent(event) || !self.isRunning()) return [];
  const payload = event.payload as ToolCallProgressPayload;
  const row = self.findToolRow(String(payload.toolCallId));
  if (!row || row.status !== "running") return [];
  // 两个分支共用 ToolCallProgress：Bash 尾窗与 MCP 百分比必须分别投影，避免合并后互相覆盖。
  if (row.toolName === "Bash") return projectToolActivity(event, row);
  const total =
    typeof payload.total === "number" && Number.isFinite(payload.total) && payload.total > 0
      ? payload.total
      : undefined;
  const fraction =
    total !== undefined && typeof payload.progress === "number" && Number.isFinite(payload.progress)
      ? Math.min(1, Math.max(0, payload.progress / total))
      : undefined;
  const message =
    typeof payload.message === "string" && payload.message.trim().length > 0
      ? payload.message.trim().slice(0, 200)
      : undefined;
  if (fraction === undefined && message === undefined && total === undefined) return [];
  return [
    {
      op: "row.upserted",
      row: {
        ...row,
        progress: {
          ...(fraction !== undefined ? { fraction } : {}),
          ...(total !== undefined ? { total } : {}),
          ...(message !== undefined ? { message } : {}),
          updatedAt: self.ms(event),
        },
      },
    },
  ];
}

export function onToolCallResult(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  if (self.isMirroredSubagentToolEvent(event) || !self.isRunning()) return [];
  const payload = event.payload as ToolCallResultPayload;
  const toolCallId = String(payload.toolCallId);
  self.recordHighspeedToolEnded(self.turnIdOf(event), toolCallId, self.ms(event), payload.duration);
  const row = self.findToolRow(toolCallId);
  if (!row) return [];
  const success = payload.result.success;
  if (success && readOfficialCuaAction(row.toolName) === "list_apps") {
    // 摘要身份必须来自 Agent 已观察到的成功事实；失败结果不能清空旧快照。
    const snapshot = parseListAppsSnapshot(payload.result.content, payload.result.display);
    if (snapshot) self.latestListAppsSnapshot = snapshot;
  }
  const display = toProtocolToolCallDisplay(payload.result.display);
  const next: ToolCallRow = {
    ...row,
    status: success ? "success" : "error",
    // 终态清除运行中进度（R7）。
    progress: undefined,
    output: buildToolOutput(payload.result, toolCallId),
    ...(display ? { display } : {}),
    endedAt: self.ms(event),
  };
  if (!success) {
    next.error = {
      code: payload.result.error?.type ?? "fault.runtime.toolFailed",
      message: payload.result.error?.message ?? "Tool execution failed.",
    };
  }
  const planDeltas = success
    ? self.todoPlanDeltas(
        event,
        extractPlanStepsFromToolOutput({
          title: row.toolName,
          kind: row.toolName,
          output: payload.result.content,
        }),
      )
    : [];
  return [{ op: "row.upserted", row: next }, ...planDeltas];
}

export function todoPlanDeltas(
  self: ProductProjectionContext,
  event: SessionEvent,
  steps: ReturnType<typeof extractPlanStepsFromToolInput>,
): ConversationDelta[] {
  if (!steps) return [];
  const items = steps.map((step, index) => ({
    id: step.id || `todo-${index + 1}`,
    content: step.title,
    status:
      step.status === "in_progress"
        ? ("inProgress" as const)
        : step.status === "completed"
          ? ("completed" as const)
          : ("pending" as const),
  }));
  const updatedAt = self.ms(event);
  const goal = self.snapshot.goal;
  if (!goal) {
    return [{ op: "state.updated", patch: { plan: { items, updatedAt } } }];
  }

  const iteration =
    goal.status === "verifying" || goal.status === "verified" || goal.status === "failed"
      ? Math.max(1, goal.iteration)
      : Math.max(1, goal.iteration + 1);
  const iterations = [
    ...goal.iterations.filter((entry) => entry.iteration !== iteration),
    { iteration, items, updatedAt },
  ].sort((left, right) => left.iteration - right.iteration);
  return [
    {
      op: "state.updated",
      patch: {
        goal: { ...goal, iterations },
        plan: { items, updatedAt },
      },
    },
  ];
}

export function onToolCallError(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  if (self.isMirroredSubagentToolEvent(event) || !self.isRunning()) return [];
  const payload = event.payload as ToolCallErrorPayload;
  self.recordHighspeedToolEnded(self.turnIdOf(event), String(payload.toolCallId), self.ms(event));
  const row = self.findToolRow(String(payload.toolCallId));
  if (!row) return [];
  const cancelled =
    payload.error.type === CoreErrorType.ToolCancelled || payload.error.code === "TOOL_CANCELLED";
  return [
    {
      op: "row.upserted",
      row: {
        ...row,
        // Stop 会先产生 tool_cancelled，再产生 cancelled turn；若先把工具
        // 终态写成 error，后续只收口 running row 的 turn reducer 无法纠正为 stopped。
        status: cancelled ? "cancelled" : "error",
        progress: undefined,
        ...(cancelled
          ? { error: undefined }
          : { error: { code: payload.error.type, message: payload.error.message } }),
        endedAt: self.ms(event),
      },
    },
  ];
}
