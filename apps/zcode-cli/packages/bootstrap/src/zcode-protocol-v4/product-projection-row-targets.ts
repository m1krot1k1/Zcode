// ProductProjection 域模块：resolveRowActionTarget, getMessageIdsForTurnRow, isLatestAssistantSegmentRow, resolveStableForkCandidate 等。
// 函数签名为 (self, ...原方法参数)，方法体从 ProductProjection 原样移出；
// 只依赖上下文接口与类型基座，跨域调用一律经 self 上的方法，不直接 import 其它域模块。

import type { SessionEvent, SessionForkedPayload } from "@zcode/contracts";
import type {
  AssistantTextRow,
  ConversationDelta,
  ConversationRow,
  ConversationRowTarget,
  TimelineMarkerRow,
  ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  type ConversationRowTargetAction,
  type ConversationRowTargetResolution,
  type StableForkCandidateResolution,
  type ConversationEditTarget,
} from "./product-projection-types.js";
import type { ProductProjectionContext } from "./product-projection-context.js";

export function resolveRowActionTarget(
  self: ProductProjectionContext,
  target: ConversationRowTarget,
  action: ConversationRowTargetAction,
): ConversationRowTargetResolution {
  const row = self.findRow(target.rowId);
  if (!row || self.entityIdByRowId.get(target.rowId) !== target.entityId) {
    return { ok: false, status: "stale", reasonCode: "proto.staleTarget" };
  }
  if (action === "editUserQuery") {
    const editTarget = self.resolveEditTargetByEntityId(target.entityId);
    if (row.actions?.canEdit !== true || !row.actions.editDisposition || !editTarget) {
      return {
        ok: false,
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      };
    }
    return { ok: true, action, row, editTarget };
  }
  if (action === "retryTurn") {
    const messageId = self.messageIdByRowId.get(row.rowId);
    const userRow = self.snapshot.rows.window.find(
      (candidate) =>
        candidate.turnId === row.turnId &&
        candidate.kind === "userInput" &&
        candidate.origin === "realUser",
    );
    const userEntityId = userRow ? self.entityIdByRowId.get(userRow.rowId) : undefined;
    const editTarget = userEntityId ? self.editTargetByEntityId.get(userEntityId) : undefined;
    if (row.actions?.canRetry !== true || !messageId || !editTarget) {
      return {
        ok: false,
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      };
    }
    return { ok: true, action, row, messageId, editTarget };
  }
  if (action === "forkAssistant") {
    const messageId = self.messageIdByRowId.get(row.rowId);
    if (row.actions?.canFork !== true || !messageId) {
      return {
        ok: false,
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      };
    }
    return { ok: true, action, row, messageId };
  }
  if (action === "setAssistantFeedback") {
    const messageId = self.messageIdByRowId.get(row.rowId);
    if (row.kind !== "assistantText" || !messageId) {
      return {
        ok: false,
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      };
    }
    return { ok: true, action, row, messageId };
  }
  if (action === "setHighspeedMetrics") {
    const messageId = self.messageIdByRowId.get(row.rowId);
    if (row.kind !== "userInput" || !row.highspeed || !messageId) {
      return {
        ok: false,
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      };
    }
    return { ok: true, action, row, messageId };
  }
  if (row.kind !== "turnHeader") {
    return {
      ok: false,
      status: "rejected",
      reasonCode: "guard.actionUnavailable",
    };
  }
  if (
    (action === "applyFileRewind" || action === "fileRewindPreview") &&
    (!row.fileChanges || row.actions?.canRewindFiles !== true)
  ) {
    return {
      ok: false,
      status: "rejected",
      reasonCode: "guard.actionUnavailable",
    };
  }
  return {
    ok: true,
    action,
    row,
    messageIds: self.getMessageIdsForTurnRow(row.rowId),
  };
}

export function getMessageIdsForTurnRow(self: ProductProjectionContext, rowId: number): string[] {
  const row = self.findRow(rowId);
  if (!row) return [];
  const messageIds = new Set<string>();
  const runtimeTurnId = self.runtimeTurnIdByProductTurnId.get(row.turnId);
  // Bug 原因：model-only turn 不生成可见 userInput row，过去只扫描 row 会漏掉
  // checkpoint 使用的隐藏 user messageId。新 turn 有持久消息时 productTurnId
  // 就是该 messageId；把它作为精确锚点后无需扩大 runtime turn 的兜底范围。
  if (runtimeTurnId && runtimeTurnId !== row.turnId) {
    messageIds.add(row.turnId);
  }
  for (const candidate of self.snapshot.rows.window) {
    if (candidate.turnId !== row.turnId) continue;
    const messageId = self.messageIdByRowId.get(candidate.rowId);
    if (messageId) messageIds.add(messageId);
  }
  for (const [messageId, continuationRowId] of self.outputContinuationRowIdByMessageId) {
    const continuationRow = self.findRow(continuationRowId);
    if (continuationRow?.turnId === row.turnId) messageIds.add(messageId);
  }
  return [...messageIds];
}

export function isLatestAssistantSegmentRow(
  self: ProductProjectionContext,
  rowId: number,
): boolean {
  const row = self.findRow(rowId);
  if (row?.kind !== "assistantText") return false;
  for (let index = self.snapshot.rows.window.length - 1; index >= 0; index -= 1) {
    const candidate = self.snapshot.rows.window[index]!;
    if (candidate.kind === "assistantText" && candidate.turnId === row.turnId) {
      return candidate.rowId === rowId;
    }
  }
  return false;
}

export function resolveStableForkCandidate(
  self: ProductProjectionContext,
  rowId: number,
): StableForkCandidateResolution {
  if (self.snapshot.control.activeWorks.some((work) => work.kind === "compact")) {
    return { ok: false, reasonCode: "guard.compactOperationLock" };
  }
  const row = self.findRow(rowId);
  if (row?.kind !== "assistantText") {
    return { ok: false, reasonCode: "guard.forkAssistantOnly" };
  }
  const headerRowId = self.turnHeaderRowIdByTurnId.get(row.turnId);
  const header = headerRowId === undefined ? undefined : self.findRow(headerRowId);
  if (
    row.state !== "complete" ||
    row.actions?.canFork !== true ||
    header?.kind !== "turnHeader" ||
    header.state !== "completedSuccess" ||
    !self.isLatestAssistantSegmentRow(rowId)
  ) {
    return { ok: false, reasonCode: "guard.forkTargetNotStable" };
  }
  const boundaryMessageId = self.messageIdByRowId.get(rowId);
  if (!boundaryMessageId) {
    return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
  }
  const startMessageId =
    self.snapshot.rows.window
      .filter((candidate) => candidate.turnId === row.turnId && candidate.kind === "userInput")
      .map((candidate) => self.messageIdByRowId.get(candidate.rowId))
      .find((messageId): messageId is string => Boolean(messageId)) ?? null;
  return {
    ok: true,
    candidate: {
      productTurnId: row.turnId,
      transcriptTurnId: self.runtimeTurnIdByProductTurnId.get(row.turnId) ?? row.turnId,
      startMessageId,
      boundaryMessageId,
    },
  };
}

export function isLatestRetryAssistantRow(self: ProductProjectionContext, rowId: number): boolean {
  const row = self.findRow(rowId);
  return Boolean(
    row?.kind === "assistantText" &&
    row.actions?.canRetry === true &&
    self.messageIdByRowId.has(rowId),
  );
}

export function isLatestEditableUserRow(self: ProductProjectionContext, rowId: number): boolean {
  const row = self.findRow(rowId);
  return Boolean(
    row?.kind === "userInput" &&
    row.origin === "realUser" &&
    row.actions?.canEdit === true &&
    self.messageIdByRowId.has(rowId),
  );
}

export function rowIdForMessageId(
  self: ProductProjectionContext,
  messageId: string,
): number | null {
  const continuationRowId = self.outputContinuationRowIdByMessageId.get(messageId);
  if (continuationRowId !== undefined) return continuationRowId;
  for (const [rowId, mid] of self.messageIdByRowId) {
    if (mid === messageId) return rowId;
  }
  return null;
}

export function getTurnRewindAnchor(self: ProductProjectionContext, rowId: number): string | null {
  return self.rewindAnchorForRows(self.snapshot.rows.window, rowId);
}

export function rewindAnchorForRows(
  self: ProductProjectionContext,
  rows: readonly ConversationRow[],
  rowId: number,
): string | null {
  const row = rows.find((candidate) => candidate.rowId === rowId);
  if (!row) return null;
  const turnId = row.turnId;
  for (const [candidateRowId, messageId] of self.messageIdByRowId) {
    const candidate = rows.find((item) => item.rowId === candidateRowId);
    if (candidate && candidate.turnId === turnId) return messageId;
  }
  return null;
}

export function registerCanonicalUserRowTarget(
  self: ProductProjectionContext,
  rowId: number,
  entityId: string,
  editTarget?: ConversationEditTarget,
): void {
  self.entityIdByRowId.set(rowId, entityId);
  if (!editTarget) return;
  self.messageIdByRowId.set(rowId, editTarget.transcriptMessageId);
  self.editTargetByEntityId.set(entityId, editTarget);
}

export function onSessionCreated(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as { contextWindow?: number };
  self.contextWindowState.maxTokens = payload.contextWindow ?? null;
  // draft 语义：会话实体已存在、无 row；phase 保持 draft，无可见 delta。
  return [];
}

export function onSessionTitleUpdated(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as {
    title?: string;
    source?: string;
  };
  const title = payload.title ?? "";
  // core 的 titleSource 有 4 值（default/first_input/generated/custom）；投影 meta 归一为
  // default/generated/custom（first_input 归入 generated：都属"非用户显式"）。
  const source: "default" | "generated" | "custom" =
    payload.source === "custom" ? "custom" : payload.source === "default" ? "default" : "generated";
  const prev = self.snapshot.meta;
  if (prev.titleSource === "custom" && source === "generated") return [];
  if (prev.title === title && prev.titleSource === source) return [];
  return [
    {
      op: "state.updated",
      patch: { meta: { title, titleSource: source } },
    },
  ];
}

export function onSessionForked(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as SessionForkedPayload;
  const isParent = String(payload.originalSessionId) === self.snapshot.sessionId;
  if (isParent) {
    // 父时间线不显示 forkCreated——fork 关系只在 sessions
    // 树/列表体现。旧实现以 nextRowId-1 近似锚点产 row，且 UI 渲染为 null
    // （隐形行污染 turn 分组）；child 首部 forkNotice 保留不变。
    return [];
  }
  // child 首部 forkNotice（forkTimelineIsBoundary）：事件 payload 不携带
  // parent 侧 rowId，先以 0 占位；transcript 锚点 → rowId 映射随传输外壳补齐。
  const row: TimelineMarkerRow = {
    ...self.rowBase(
      event,
      self.turnIdOf(event),
      `fork:${String(payload.originalSessionId)}:${String(payload.targetMessageId ?? "unknown")}`,
    ),
    kind: "timelineMarker",
    lane: "turnTailBoundary",
    marker: {
      type: "forkNotice",
      parentSessionId: String(payload.originalSessionId),
      parentRowId: 0,
    },
  };
  return [{ op: "row.appended", row }];
}

export function markStableForkAssistant(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const turnId = self.turnIdOf(event);
  const rows = self.snapshot.rows.window;
  const headerRowId = self.turnHeaderRowIdByTurnId.get(turnId);
  const headerIndex = headerRowId === undefined ? undefined : self.rowIndexById.get(headerRowId);
  const startIndex = headerIndex === undefined ? 0 : headerIndex + 1;
  let row: AssistantTextRow | undefined;
  // 性能问题根因：旧实现每个成功 turn 都复制并反转完整历史 rows，冷恢复会累积为
  // 近似 O(turns * rows) 的分配与扫描。当前 turn 的行只会出现在自身 header 之后。
  for (let index = rows.length - 1; index >= startIndex; index -= 1) {
    const candidate = rows[index];
    if (candidate?.kind !== "assistantText" || candidate.turnId !== turnId) continue;
    row = candidate;
    break;
  }
  if (!row || !self.messageIdByRowId.has(row.rowId)) return [];
  return [
    {
      op: "row.upserted",
      row: {
        ...row,
        state: "complete",
        actions: { ...row.actions, canFork: true },
      },
    },
  ];
}

export function onRewindTriggered(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as {
    targetMessageId?: string;
    scope?: string;
    branchCutAfterMessageId?: string;
    branchGeneration?: number;
    createdMessageId?: string;
    reason?: string;
  };
  if (payload.scope === "workspace" && payload.reason === "file_summary_rewind") {
    const targetMessageId = payload.targetMessageId;
    if (!targetMessageId) return [];
    const targetRowId = self.rowIdForMessageId(targetMessageId);
    if (targetRowId === null) return [];
    const targetRow = self.findRow(targetRowId);
    if (!targetRow) return [];
    const headerRowId = self.turnHeaderRowIdByTurnId.get(targetRow.turnId);
    const headerRow = headerRowId !== undefined ? self.findRow(headerRowId) : undefined;
    if (headerRow?.kind !== "turnHeader" || !headerRow.fileChanges) return [];
    return [
      {
        op: "row.upserted",
        row: {
          ...headerRow,
          fileChanges: {
            ...headerRow.fileChanges,
            state: "reverted",
          },
        },
      },
    ];
  }
  // 新语义只消费带 branchGeneration/cut 的已提交 conversation rewind；createdMessageId
  // 仅兼容旧 transcript。失败/冲突不发事件，因此不会制造 UI 假截断。
  const applied =
    (payload.branchGeneration !== undefined && payload.branchCutAfterMessageId !== undefined) ||
    payload.createdMessageId !== undefined;
  if ((payload.scope !== "conversation" && payload.scope !== "both") || !applied) return [];
  const targetMessageId = payload.targetMessageId;
  if (!targetMessageId) return [];
  const targetRowId = self.rowIdForMessageId(targetMessageId);
  if (targetRowId === null) return [];
  const targetRow = self.findRow(targetRowId);
  if (!targetRow) return [];
  // 从该行所属 turn 的首行起移除（整段 turn 被 rewind/edit/retry 替换）。
  const turnHeaderRowId = self.turnHeaderRowIdByTurnId.get(targetRow.turnId) ?? targetRowId;
  const fromRowId = Math.min(turnHeaderRowId, targetRowId);
  // 清理被移除行的 messageId/tool 索引，避免悬挂映射。
  for (const [rowId] of self.messageIdByRowId) {
    if (rowId >= fromRowId) self.messageIdByRowId.delete(rowId);
  }
  for (const [messageId, rowId] of self.outputContinuationRowIdByMessageId) {
    if (rowId >= fromRowId) self.outputContinuationRowIdByMessageId.delete(messageId);
  }
  for (const [rowId, entityId] of self.entityIdByRowId) {
    if (rowId >= fromRowId) {
      self.entityIdByRowId.delete(rowId);
      self.editTargetByEntityId.delete(entityId);
    }
  }
  for (const [hookInvocationId, rowId] of self.hookRowIdByInvocationId) {
    if (rowId >= fromRowId) {
      self.rewoundHookInvocationIds.add(hookInvocationId);
      self.hookRowIdByInvocationId.delete(hookInvocationId);
    }
  }
  return [{ op: "row.removed", fromRowId }];
}

export function rowBase(
  self: ProductProjectionContext,
  event: SessionEvent,
  turnId: string,
  entityId: string = String(event.id),
): {
  rowId: number;
  turnId: string;
  entityId: string;
  productTurnId: string;
  visibility: "visible";
  createdAt: number;
  createdAtSeq: number;
} {
  const rowId = self.nextRowId++;
  self.entityIdByRowId.set(rowId, entityId);
  return {
    rowId,
    turnId,
    entityId,
    productTurnId: turnId,
    visibility: "visible" as const,
    createdAt: self.ms(event),
    createdAtSeq: event.sequenceNumber,
  };
}

export function turnIdOf(self: ProductProjectionContext, event: SessionEvent): string {
  const runtimeTurnId = String(event.turnId ?? self.currentTurnId ?? "turn-unknown");
  // queue drain 切轮后，同一 runtimeTurn 的后续事件行归入最新 productTurn。
  return self.productTurnIdByRuntimeTurnId.get(runtimeTurnId) ?? runtimeTurnId;
}

export function ms(self: ProductProjectionContext, event: SessionEvent): number {
  return event.timestamp.getTime();
}

export function findRow(
  self: ProductProjectionContext,
  rowId: number,
): ConversationRow | undefined {
  const index = self.rowIndexById.get(rowId);
  return index === undefined ? undefined : self.snapshot.rows.window[index];
}

export function updateRowIndexAfterImmutableApply(
  self: ProductProjectionContext,
  previousRowsLength: number,
  deltas: readonly ConversationDelta[],
): void {
  if (deltas.some((delta) => delta.op === "row.removed")) {
    self.rowIndexById = new Map(self.snapshot.rows.window.map((row, index) => [row.rowId, index]));
    return;
  }
  let nextIndex = previousRowsLength;
  for (const delta of deltas) {
    if (delta.op !== "row.appended") continue;
    self.rowIndexById.set(delta.row.rowId, nextIndex);
    nextIndex += 1;
  }
}

export function findToolRow(
  self: ProductProjectionContext,
  toolCallId: string,
): ToolCallRow | undefined {
  const rowId = self.toolRowIdByCallId.get(toolCallId);
  if (rowId === undefined) return undefined;
  const row = self.findRow(rowId);
  return row?.kind === "toolCall" ? row : undefined;
}

export function isRunning(self: ProductProjectionContext): boolean {
  const phase = self.snapshot.control.phase;
  return phase === "running" || phase === "prewarming";
}
