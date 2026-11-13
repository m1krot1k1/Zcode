// ProductProjection 域模块：getSnapshot, setRuntimeInitialization, getDroppedContentStreamEventCount, getNormalizationDiagnostics 等。
// 函数签名为 (self, ...原方法参数)，方法体从 ProductProjection 原样移出；
// 只依赖上下文接口与类型基座，跨域调用一律经 self 上的方法，不直接 import 其它域模块。

import type {
  ModelStreamingPayload,
  PluginUiAppToolCallRequestedPayload,
  PluginUiResourceListChangedPayload,
  PluginUiResourceUpdatedPayload,
  SessionEvent,
} from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import { clearSettledOutputPreviews } from "./product-projection-bash-progress.js";
import {
  ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS,
  isZCodeModelRetryRecoveryProgressPayload,
} from "@zcode/shared";
import type {
  AssistantTextRow,
  ConversationDelta,
  ConversationRow,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import {
  applyConversationDeltas,
  applyConversationDeltasMutable,
  createMutableConversationSnapshotAccumulator,
} from "@zcode/shared/zcode-protocol-v4";
import {
  normalizeConversationEvent,
  type CanonicalConversationFact,
  type ConversationNormalizationDiagnostic,
} from "./event-normalizer.js";
import { deltaBumpsRevision } from "./projection-state.js";
import {
  type SessionConfigSeed,
  sameSparseModelSelection,
  cloneSparseModelSelection,
  type SessionUsageSeed,
  type SessionSubagentsSeed,
  type ConversationEditTarget,
} from "./product-projection-types.js";
import type { ProductProjectionContext } from "./product-projection-context.js";

export function getSnapshot(self: ProductProjectionContext): ConversationSnapshot {
  return self.snapshot;
}

export function setRuntimeInitialization(
  self: ProductProjectionContext,
  state: NonNullable<ConversationSnapshot["runtimeInitialization"]>,
  minimumSeq: number = self.snapshot.seq + 1,
  minimumRevision: number = self.snapshot.revision + 1,
): void {
  self.snapshot = {
    ...self.snapshot,
    runtimeInitialization: state,
    seq: Math.max(self.snapshot.seq, minimumSeq),
    revision: Math.max(self.snapshot.revision, minimumRevision),
  };
}

export function getDroppedContentStreamEventCount(self: ProductProjectionContext): number {
  return self.droppedContentStreamEventCount;
}

export function getNormalizationDiagnostics(
  self: ProductProjectionContext,
): readonly ConversationNormalizationDiagnostic[] {
  return self.normalizationDiagnostics;
}

export function establishedStreamingAppend(
  self: ProductProjectionContext,
  event: SessionEvent,
): string | null {
  if (event.type !== SessionEventType.ModelStreaming || !self.isRunning()) return null;
  const payload = event.payload as ModelStreamingPayload;
  if (payload.kind === "text_delta" && self.streamingTextRowId !== null) return payload.delta;
  if (payload.kind === "reasoning_delta" && self.streamingReasoningRowId !== null) {
    return payload.delta;
  }
  if (
    payload.kind === "tool_input_delta" &&
    self.toolRowIdByCallId.has(String(payload.toolCallId))
  ) {
    const state = self.fileToolInputPreviewByCallId.get(String(payload.toolCallId));
    if (state) {
      if (
        state.lastPublishedAt !== null &&
        self.ms(event) - state.lastPublishedAt <
          ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS
      ) {
        return "";
      }
      // 上界估算必须包含窗口内累计 suffix；只算当前 delta 会低估下一份 wire snapshot。
      return `${state.pendingAppend}${payload.delta}`;
    }
    return payload.delta;
  }
  return null;
}

export function seedConfig(self: ProductProjectionContext, seed: SessionConfigSeed): void {
  const config = { ...self.snapshot.config };
  let changed = false;
  if (!config.permissionGrant && seed.permissionGrant) {
    config.permissionGrant = seed.permissionGrant;
    changed = true;
  }
  if (!self.configModelTouchedByEvent) {
    if (
      Object.hasOwn(seed, "modelSelection") &&
      !sameSparseModelSelection(config.modelSelection, seed.modelSelection)
    ) {
      // 恢复的空选择也有明确语义，不能因为 falsy 而保留历史事件里的旧选型。
      config.modelSelection = seed.modelSelection
        ? cloneSparseModelSelection(seed.modelSelection)
        : undefined;
      changed = true;
    }
    if (seed.provider !== undefined && config.provider !== seed.provider) {
      config.provider = seed.provider;
      changed = true;
    }
    if (seed.model !== undefined && config.model !== seed.model) {
      config.model = seed.model;
      changed = true;
    }
    if (seed.thought !== undefined && config.thought !== seed.thought) {
      config.thought = seed.thought;
      changed = true;
    }
  }
  const seedThoughtLevels = seed.thoughtLevels;
  if (
    !self.configThoughtLevelsTouchedByEvent &&
    seedThoughtLevels !== undefined &&
    (config.thoughtLevels.length !== seedThoughtLevels.length ||
      config.thoughtLevels.some((value, index) => value !== seedThoughtLevels[index]))
  ) {
    config.thoughtLevels = [...seedThoughtLevels];
    changed = true;
  }
  if (!self.configModeTouchedByEvent && seed.mode && config.mode !== seed.mode) {
    config.mode = seed.mode;
    changed = true;
  }
  if (
    !self.configModeTouchedByEvent &&
    seed.planEnabled !== undefined &&
    config.planEnabled !== seed.planEnabled
  ) {
    config.planEnabled = seed.planEnabled;
    changed = true;
  }
  if (changed) {
    self.snapshot = { ...self.snapshot, config };
  }
}

export function seedSharedContextImport(
  self: ProductProjectionContext,
  source: ConversationSnapshot["sharedContextImport"] | null | undefined,
): void {
  const title = source?.title.trim();
  if (!title) return;
  if (
    self.snapshot.sharedContextImport?.title === title &&
    (source as { contextId?: string }).contextId ===
      (self.snapshot.sharedContextImport as { contextId?: string }).contextId &&
    (source as { status?: string }).status ===
      (self.snapshot.sharedContextImport as { status?: string }).status
  ) {
    return;
  }
  self.snapshot = {
    ...self.snapshot,
    sharedContextImport: {
      ...source,
      title,
    },
  };
}

export function seedUsage(self: ProductProjectionContext, seed: SessionUsageSeed): void {
  const current = self.snapshot.usage;
  const currentContextWindow = current.contextWindow;
  if (currentContextWindow) {
    self.contextWindowState.usedTokens = currentContextWindow.usedTokens;
  }
  // 未知容量也有内部用量事实；迟到的恢复种子不能覆盖真实 ModelComplete/Compact 水位。
  if (self.contextWindowState.usedTokens > 0) {
    return;
  }
  const seededContextWindow = seed.contextWindow;
  if (!Number.isFinite(seededContextWindow.usedTokens) || seededContextWindow.usedTokens <= 0) {
    return;
  }
  const cumulative = {
    inputTokens: seed.cumulative?.inputTokens ?? current.cumulative.inputTokens,
    outputTokens: seed.cumulative?.outputTokens ?? current.cumulative.outputTokens,
    cacheReadTokens: seed.cumulative?.cacheReadTokens ?? current.cumulative.cacheReadTokens,
    cacheWriteTokens: seed.cumulative?.cacheWriteTokens ?? current.cumulative.cacheWriteTokens,
  };
  if (self.contextWindowState.touchedByEvent) {
    // 同类守卫：显式 ModelSelected.contextWindow（含 null）是日志权威容量，
    // hydration seed 只能补回更准确的 token 事实，不得覆盖 maxTokens 或重新显示 null。
    self.contextWindowState.usedTokens = seededContextWindow.usedTokens;
    self.snapshot = {
      ...self.snapshot,
      usage: {
        contextWindow: currentContextWindow
          ? {
              ...currentContextWindow,
              usedTokens: seededContextWindow.usedTokens,
            }
          : null,
        cumulative,
      },
    };
    return;
  }
  if (
    seededContextWindow.maxTokens !== null &&
    (!Number.isFinite(seededContextWindow.maxTokens) || seededContextWindow.maxTokens <= 0)
  ) {
    return;
  }

  // 合成历史事件只有零用量占位；种子补真实水位，未知容量不妨碍内部保留 token。
  self.contextWindowState.usedTokens = seededContextWindow.usedTokens;
  self.contextWindowState.maxTokens = seededContextWindow.maxTokens;
  self.snapshot = {
    ...self.snapshot,
    usage: {
      contextWindow:
        seededContextWindow.maxTokens === null
          ? null
          : { ...seededContextWindow, maxTokens: seededContextWindow.maxTokens },
      cumulative,
    },
  };
}

export function seedSubagents(self: ProductProjectionContext, seed: SessionSubagentsSeed): void {
  const childSessionIds = [...new Set(seed.childSessionIds)];
  const allowed = new Set(childSessionIds);
  self.invalidSubagentChildSessionIds = new Set(
    self.snapshot.rows.window.flatMap((row) =>
      row.kind === "subagent" && row.childSessionId && !allowed.has(row.childSessionId)
        ? [row.childSessionId]
        : [],
    ),
  );
  const running = seed.running.filter((item) => allowed.has(item.childSessionId));
  self.snapshot = {
    ...self.snapshot,
    subagents: {
      // 非空 cold manifest 必须至少从 1 开始；renderer 用 0 区分尚未建立权威态，
      // 否则旧 session 的 stateRevision=0 会让 child tab 失效同步被永久跳过。
      revision: Math.max(childSessionIds.length > 0 ? 1 : 0, Math.floor(seed.revision)),
      childSessionIds,
      running,
      endedTotal: Math.max(0, childSessionIds.length - running.length),
    },
  };
}

export function getMessageIdForRow(self: ProductProjectionContext, rowId: number): string | null {
  return self.messageIdByRowId.get(rowId) ?? null;
}

export function getEntityIdForRow(self: ProductProjectionContext, rowId: number): string | null {
  return self.entityIdByRowId.get(rowId) ?? null;
}

export function resolveEditTarget(
  self: ProductProjectionContext,
  rowId: number,
): ConversationEditTarget | null {
  if (!self.isLatestEditableUserRow(rowId)) return null;
  const entityId = self.entityIdByRowId.get(rowId);
  return entityId ? self.resolveEditTargetByEntityId(entityId) : null;
}

export function resolveEditTargetByEntityId(
  self: ProductProjectionContext,
  entityId: string,
): ConversationEditTarget | null {
  if (entityId !== self.currentEditableEntityId) return null;
  const target = self.editTargetByEntityId.get(entityId);
  return target ? { ...target, intent: { ...target.intent } } : null;
}

export function getTurnIdForRow(self: ProductProjectionContext, rowId: number): string | null {
  return self.findRow(rowId)?.turnId ?? null;
}

export function applyEvent(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  return self.applyEventInternal(event, true);
}

export function beginHydrationReplay(self: ProductProjectionContext): void {
  if (self.hydrationAccumulator) throw new Error("hydration replay already active");
  self.hydrationAccumulator = createMutableConversationSnapshotAccumulator(self.snapshot);
  self.snapshot = self.hydrationAccumulator.snapshot;
  self.rowIndexById = self.hydrationAccumulator.rowIndexById;
}

export function applyHydrationEvent(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  if (!self.hydrationAccumulator) throw new Error("hydration replay is not active");
  return self.applyEventInternal(event, false);
}

export function completeHydrationReplay(self: ProductProjectionContext): ConversationDelta[] {
  if (!self.hydrationAccumulator) throw new Error("hydration replay is not active");
  const deltas = self.materializeCommandRowActions([]);
  applyConversationDeltasMutable(self.hydrationAccumulator, deltas);
  self.hydrationAccumulator = null;
  return deltas;
}

export function applyEventInternal(
  self: ProductProjectionContext,
  event: SessionEvent,
  materializeActions: boolean,
): ConversationDelta[] {
  if (event.type === SessionEventType.SubagentSpawned) {
    const childSessionId = self.stringPayload(
      event.payload as Record<string, unknown>,
      "childSessionId",
    );
    // live spawn 已经过 core persist-before-publish 闸门；若它是旧 ghost 的合法 resume，
    // 以新事件恢复资格。hydration 期间 seed 尚未建立排除集合，不会误放历史引用。
    if (childSessionId) self.invalidSubagentChildSessionIds.delete(childSessionId);
  }
  const runtimeTurnId = String(event.turnId ?? self.currentTurnId ?? "turn-unknown");
  const productTurnId =
    event.type === SessionEventType.TurnStarted
      ? undefined
      : (self.productTurnIdByRuntimeTurnId.get(runtimeTurnId) ?? runtimeTurnId);
  const reduced =
    event.type === SessionEventType.AssistantFeedbackUpdated
      ? self.onAssistantFeedbackUpdated(event)
      : event.type === SessionEventType.HighspeedMetricsUpdated
        ? self.onHighspeedMetricsUpdated(event)
        : event.type === SessionEventType.TurnExecutionModelFallback
          ? self.onTurnExecutionModelFallback(event)
          : (() => {
              const fact = normalizeConversationEvent(event, {
                productTurnId,
                openAssistantSegments: self.openAssistantSegments(),
              });
              self.normalizationDiagnostics.push(...fact.diagnostics);
              return self.reduce(fact);
            })();
  const subagentDeltas = self.shouldMaterializeSubagentProjection(reduced)
    ? self.materializeSubagentProjection(reduced)
    : [];
  const reducedWithSubagents = [...reduced, ...subagentDeltas];
  // row、命令 target 与 actions 必须属于同一个 materialization transaction。
  // 旧实现只维护 side-map/最新行判断，UI action 由别处推断，cold/tool-only/failed
  // 轮会出现“入口可见但 target 不可解析”，新目标出现后旧入口也不会撤销。
  const deltas = materializeActions
    ? [...reducedWithSubagents, ...self.materializeCommandRowActions(reducedWithSubagents)]
    : reducedWithSubagents;
  const finalDeltas = self.attachRevision(clearSettledOutputPreviews(deltas));
  if (self.hydrationAccumulator) {
    applyConversationDeltasMutable(self.hydrationAccumulator, finalDeltas);
    self.snapshot.seq = event.sequenceNumber;
  } else {
    const previousRowsLength = self.snapshot.rows.window.length;
    self.snapshot = {
      ...applyConversationDeltas(self.snapshot, finalDeltas),
      seq: event.sequenceNumber,
    };
    self.updateRowIndexAfterImmutableApply(previousRowsLength, finalDeltas);
  }
  self.updateToolIndexesAfterDeltas(finalDeltas);
  return finalDeltas;
}

export function materializeCommandRowActions(
  self: ProductProjectionContext,
  reduced: ConversationDelta[],
): ConversationDelta[] {
  const prospective = applyConversationDeltas(self.snapshot, reduced);
  const rows = prospective.rows.window;
  const rowById = new Map(rows.map((row) => [row.rowId, row]));
  const latestAssistantRowIdByTurn = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== "assistantText") continue;
    const current = latestAssistantRowIdByTurn.get(row.turnId);
    if (current === undefined || row.rowId > current) {
      latestAssistantRowIdByTurn.set(row.turnId, row.rowId);
    }
  }
  const compactActive = prospective.control.activeWorks.some((work) => work.kind === "compact");
  const completionBlockingActive = prospective.control.activeWorks.length > 0;
  let latestEditable: ConversationRow | undefined;
  let latestAssistant: AssistantTextRow | undefined;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (
      !latestEditable &&
      !compactActive &&
      row.kind === "userInput" &&
      row.origin === "realUser"
    ) {
      latestEditable = row;
    }
    if (!latestAssistant && row.kind === "assistantText") {
      latestAssistant = row;
    }
    if (latestEditable && latestAssistant) break;
  }
  // 旧逻辑只按“最新完整 assistant”挑 retry，background result 的
  // synthetic turn 因此会错误获得入口；若只在 find 条件里过滤 synthetic，又会跳过
  // 最新 background assistant，让更早真实用户轮的 retry 复活。这里必须先锁定全时间线
  // 最新 assistant，再校验同轮 realUser canonical cause，保证普通 retry 不跨轮回退。
  const latestRetryable = (() => {
    if (
      completionBlockingActive ||
      !latestAssistant ||
      latestAssistant.state !== "complete" ||
      !self.messageIdByRowId.has(latestAssistant.rowId)
    ) {
      return undefined;
    }
    const headerId = self.turnHeaderRowIdByTurnId.get(latestAssistant.turnId);
    const header = headerId === undefined ? undefined : rowById.get(headerId);
    if (header?.kind !== "turnHeader" || header.state === "running") return undefined;
    const canonicalUserRow = rows.find(
      (row) =>
        row.turnId === latestAssistant.turnId &&
        row.kind === "userInput" &&
        row.origin === "realUser",
    );
    const canonicalUserEntityId = canonicalUserRow
      ? self.entityIdByRowId.get(canonicalUserRow.rowId)
      : undefined;
    if (!canonicalUserEntityId || !self.editTargetByEntityId.has(canonicalUserEntityId)) {
      return undefined;
    }
    return latestAssistant;
  })();
  const latestEditableEntityId =
    latestEditable === undefined ? null : (self.entityIdByRowId.get(latestEditable.rowId) ?? null);
  // edit action 与命令 resolver 必须共用 canonical target authority。过去 drain 分支只
  // 登记 messageId，UI 因而显示 Edit，但提交必被 resolver 以 actionUnavailable 拒绝。
  const latestEditableRowId =
    latestEditable &&
    latestEditableEntityId &&
    self.messageIdByRowId.has(latestEditable.rowId) &&
    self.editTargetByEntityId.has(latestEditableEntityId)
      ? latestEditable.rowId
      : null;
  // entity target 历史表会保留旧记录；仅撤销 row action 不足以阻止
  // entityId 直查绕过 latest-only 语义。当前可编辑 authority 与 actions 在同一次
  // materialization 中更新，resolver 不再遍历 rows，也不把 rowId 当 canonical key。
  self.currentEditableEntityId = latestEditableRowId === null ? null : latestEditableEntityId;
  const latestRetryableRowId = latestRetryable?.rowId ?? null;
  const deltas: ConversationDelta[] = [];

  for (const row of rows) {
    if (row.kind !== "turnHeader" && row.kind !== "userInput" && row.kind !== "assistantText")
      continue;
    const nextActions = { ...row.actions };
    if (row.kind === "turnHeader") {
      const canRewindFiles =
        !completionBlockingActive &&
        prospective.pendingInteractions.length === 0 &&
        row.state !== "running" &&
        row.fileChanges?.state === "active";
      if (canRewindFiles) nextActions.canRewindFiles = true;
      else delete nextActions.canRewindFiles;
    } else if (row.kind === "userInput") {
      if (row.rowId === latestEditableRowId) {
        nextActions.canEdit = true;
        nextActions.editDisposition = "rewind";
      } else {
        delete nextActions.canEdit;
        delete nextActions.editDisposition;
      }
    } else {
      if (row.rowId === latestRetryableRowId) nextActions.canRetry = true;
      else delete nextActions.canRetry;
      const headerId = self.turnHeaderRowIdByTurnId.get(row.turnId);
      const header = headerId === undefined ? undefined : rowById.get(headerId);
      const canFork =
        !compactActive &&
        row.state === "complete" &&
        header?.kind === "turnHeader" &&
        header.state === "completedSuccess" &&
        latestAssistantRowIdByTurn.get(row.turnId) === row.rowId &&
        self.messageIdByRowId.has(row.rowId);
      if (canFork) nextActions.canFork = true;
      else delete nextActions.canFork;
    }
    const actions = Object.keys(nextActions).length > 0 ? nextActions : undefined;
    if (JSON.stringify(actions) === JSON.stringify(row.actions)) continue;
    const nextRow: ConversationRow = { ...row, actions };
    if (!actions) delete nextRow.actions;
    deltas.push({ op: "row.upserted", row: nextRow });
  }
  return deltas;
}

export function attachRevision(
  self: ProductProjectionContext,
  deltas: ConversationDelta[],
): ConversationDelta[] {
  if (!deltas.some(deltaBumpsRevision)) return deltas;
  const revision = self.snapshot.revision + 1;
  const last = deltas[deltas.length - 1];
  if (last?.op === "state.updated") {
    return [...deltas.slice(0, -1), { op: "state.updated", patch: { ...last.patch, revision } }];
  }
  return [...deltas, { op: "state.updated", patch: { revision } }];
}

export function reduce(
  self: ProductProjectionContext,
  fact: CanonicalConversationFact,
): ConversationDelta[] {
  const event = fact.event;
  switch (event.type) {
    case SessionEventType.SessionCreated:
      return self.onSessionCreated(event);
    case SessionEventType.SessionResumed:
      return self.onSessionResumed(event);
    case SessionEventType.SessionTitleUpdated:
      return self.onSessionTitleUpdated(event);
    case SessionEventType.TurnStarted:
      if (fact.semanticKind !== "userIntent") return [];
      return [
        ...self.onTurnStarted(fact),
        // model-only 维护 turn（manual /compact、goal continuation）没有资格
        // 承载 SessionStart 摘要；pending 保持到下一条 user-visible 真实 turn。
        ...(self.currentTurnStartedModelOnly
          ? []
          : self.flushPendingSessionHookInvocations(fact.productTurnId)),
      ];
    case SessionEventType.ModelStreaming: {
      if (fact.semanticKind !== "assistantSegment") return [];
      const shouldClearApiRetry =
        self.acceptsActiveModelEvent(event) &&
        isZCodeModelRetryRecoveryProgressPayload(
          event.payload as unknown as Record<string, unknown>,
        );
      const streamingDeltas = self.onModelStreaming(fact);
      return shouldClearApiRetry
        ? [...streamingDeltas, ...self.setApiRetry(null)]
        : streamingDeltas;
    }
    case SessionEventType.ModelNetworkStatus:
      return self.onModelNetworkStatus(event);
    case SessionEventType.StreamRecoveryStarted:
      return self.onStreamRecoveryStarted(event);
    case SessionEventType.StreamRecoveryTailDiscarded:
      return self.onStreamRecoveryTailDiscarded(event);
    case SessionEventType.StreamRecoveryRetryStarted:
      return self.onStreamRecoveryRetryStarted(event);
    case SessionEventType.ModelSelected:
      return self.onModelSelected(event);
    case SessionEventType.ModelComplete:
      return self.onModelComplete(event);
    case SessionEventType.ToolCallScheduled:
      return self.onToolCallScheduled(event);
    case SessionEventType.StreamingToolLedgerUpdated:
      return self.onStreamingToolIdentity(event);
    case SessionEventType.ToolCallStarted:
      return self.onToolCallActivity(event);
    case SessionEventType.ToolCallProgress:
      return self.onToolCallProgress(event);
    case SessionEventType.ToolCallResult:
      return self.onToolCallResult(event);
    case SessionEventType.ToolCallError:
      return self.onToolCallError(event);
    case SessionEventType.PermissionRequested:
      return self.onPermissionRequested(event);
    case SessionEventType.PermissionResolved:
      return self.onPermissionResolved(event);
    case SessionEventType.PermissionDenied:
      return self.onPermissionDenied(event);
    case SessionEventType.PluginUiResourceUpdated: {
      // live-only，不改快照；renderer 按 subscribers 派发给沙箱实例。
      const payload = event.payload as PluginUiResourceUpdatedPayload;
      return [
        {
          op: "pluginUi.resourceUpdated",
          pluginId: payload.pluginId,
          serverName: payload.serverName,
          uri: payload.uri,
          subscribers: payload.subscribers,
        },
      ];
    }
    case SessionEventType.PluginUiResourceListChanged: {
      const payload = event.payload as PluginUiResourceListChangedPayload;
      return [
        {
          op: "pluginUi.resourceListChanged",
          pluginId: payload.pluginId,
          serverName: payload.serverName,
          subscribers: payload.subscribers,
        },
      ];
    }
    case SessionEventType.PluginUiInstanceClosed: {
      const payload = event.payload as PluginUiResourceListChangedPayload;
      return [{ op: "pluginUi.instanceClosed", ...payload }];
    }
    case SessionEventType.PluginUiAppToolCallRequested: {
      // App-Provided Tools 信箱：live-only，投递给 subscribers 里唯一的实例。
      const payload = event.payload as PluginUiAppToolCallRequestedPayload;
      return [
        {
          op: "pluginUi.appToolCall",
          activity: payload.activity,
          ...(payload.cancelled ? { cancelled: true } : {}),
          pluginId: payload.pluginId,
          serverName: payload.serverName,
          subscribers: payload.subscribers,
          callId: payload.callId,
          toolName: payload.toolName,
          arguments: payload.arguments,
        },
      ];
    }
    case SessionEventType.UserInputAutoResolutionUpdated:
      return self.onUserInputAutoResolutionUpdated(event);
    case SessionEventType.WorkspaceHookReviewRequested:
      return self.onWorkspaceHookReviewRequested(event);
    case SessionEventType.WorkspaceHookReviewSettled:
      return self.onWorkspaceHookReviewSettled(event);
    case SessionEventType.WorkspaceHookReviewSuperseded:
      return self.onWorkspaceHookReviewSuperseded(event);
    case SessionEventType.WorkspaceHookAdmissionUpdated:
      return self.onWorkspaceHookAdmissionUpdated(event);
    case SessionEventType.HookRunStarted:
    case SessionEventType.HookRunProgress:
    case SessionEventType.HookRunCompleted:
    case SessionEventType.HookRunFailed:
    case SessionEventType.HookRunBlocked:
      return self.onHookRunLifecycle(event);
    case SessionEventType.TurnSteerQueued:
      return self.onTurnSteerQueued(event);
    case SessionEventType.TurnSteerDeliveryChanged:
      return self.onTurnSteerDeliveryChanged(event);
    case SessionEventType.TurnSteerDispatchChanged:
      return self.onTurnSteerDispatchChanged(event);
    case SessionEventType.TurnSteerDrained:
      return self.onTurnSteerDrained(event);
    case SessionEventType.TurnSteerDiscarded:
      return self.onTurnSteerDiscarded(event);
    case SessionEventType.SessionInputPromoted:
      return self.onSessionInputPromoted(event);
    case SessionEventType.TurnSteerReordered:
      return self.onTurnSteerReordered(event);
    case SessionEventType.QueueAutoDrainChanged:
      return self.onQueueAutoDrainChanged(event);
    case SessionEventType.FollowupModeChanged:
      return self.onFollowupModeChanged(event);
    case SessionEventType.SessionModeChanged:
      return self.onSessionModeChanged(event);
    case SessionEventType.TurnComplete:
      return self.onTurnComplete(event);
    case SessionEventType.TurnError:
      return self.onTurnError(event);
    case SessionEventType.CompactStarted:
    case SessionEventType.CompactCompleted:
    case SessionEventType.CompactFailed:
      return self.onCompactLifecycle(event);
    case SessionEventType.TargetChanged:
      return self.onTargetChanged(event);
    case SessionEventType.TargetCompletionVerification:
      return self.onTargetVerification(event);
    case SessionEventType.SessionForked:
      return self.onSessionForked(event);
    case SessionEventType.RewindTriggered:
      return self.onRewindTriggered(event);
    case SessionEventType.BackgroundTaskStarted:
    case SessionEventType.BackgroundTaskUpdated:
    case SessionEventType.BackgroundTaskCompleted:
      return self.onBackgroundTaskLifecycle(event);
    case SessionEventType.DynamicWorkflowRunProgress:
      return self.onDynamicWorkflowRunProgress(event);
    case SessionEventType.SubagentSpawned:
      return self.onSubagentSpawned(event);
    case SessionEventType.SubagentMessage:
      return self.onSubagentMessage(event);
    case SessionEventType.SubagentStopped:
      return self.onSubagentStopped(event);
    case SessionEventType.OpenCodeAgentRunUpdated:
      return self.onOpenCodeAgentRunUpdated(event);
    case SessionEventType.SwarmRunUpdated:
      return self.onSwarmRunUpdated(event);
    case SessionEventType.OpenCodeAgentPermissionUpdated:
      return self.onOpenCodeAgentPermissionUpdated(event);
    default:
      return [];
  }
}

export function cloneProjection(self: ProductProjectionContext): ProductProjectionContext {
  const clone = Object.create(Object.getPrototypeOf(self)) as ProductProjectionContext;
  clone.snapshot = self.snapshot;
  clone.rowIndexById = new Map(self.rowIndexById);
  clone.hydrationAccumulator = null;
  clone.nextRowId = self.nextRowId;
  clone.streamingTextRowId = self.streamingTextRowId;
  clone.streamingReasoningRowId = self.streamingReasoningRowId;
  clone.outputContinuationTextRowId = self.outputContinuationTextRowId;
  clone.toolRowIdByCallId = new Map(self.toolRowIdByCallId);
  // 实时发布逐事件走原子 clone；遗漏该侧表会让成功的 list_apps 快照在提交时丢失。
  clone.latestListAppsSnapshot = new Map(self.latestListAppsSnapshot);
  clone.openForegroundToolCallIds = new Set(self.openForegroundToolCallIds);
  clone.fileToolInputPreviewByCallId = new Map(
    [...self.fileToolInputPreviewByCallId].map(([toolCallId, state]) => [toolCallId, { ...state }]),
  );
  clone.subagentRowIdByAgentId = new Map(self.subagentRowIdByAgentId);
  clone.hookRowIdByInvocationId = new Map(self.hookRowIdByInvocationId);
  clone.pendingSessionHookInvocations = new Map(
    [...self.pendingSessionHookInvocations].map(([invocationId, pending]) => [
      invocationId,
      {
        firstEvent: pending.firstEvent,
        content: {
          ...pending.content,
          executions: pending.content.executions.map((execution) => ({ ...execution })),
        },
      },
    ]),
  );
  clone.rewoundHookInvocationIds = new Set(self.rewoundHookInvocationIds);
  clone.invalidSubagentChildSessionIds = new Set(self.invalidSubagentChildSessionIds);
  clone.messageIdByRowId = new Map(self.messageIdByRowId);
  clone.outputContinuationRowIdByMessageId = new Map(self.outputContinuationRowIdByMessageId);
  clone.entityIdByRowId = new Map(self.entityIdByRowId);
  clone.editTargetByEntityId = new Map(self.editTargetByEntityId);
  clone.currentEditableEntityId = self.currentEditableEntityId;
  clone.stableCompactCoverageBoundaryRowId = self.stableCompactCoverageBoundaryRowId;
  clone.turnHeaderRowIdByTurnId = new Map(self.turnHeaderRowIdByTurnId);
  clone.compactMarkerRowIdByOperationId = new Map(self.compactMarkerRowIdByOperationId);
  clone.goalVerifyMarkerRowIdByLifecycleKey = new Map(self.goalVerifyMarkerRowIdByLifecycleKey);
  clone.productTurnIdByRuntimeTurnId = new Map(self.productTurnIdByRuntimeTurnId);
  clone.runtimeTurnIdByProductTurnId = new Map(self.runtimeTurnIdByProductTurnId);
  clone.productTurnSplitOrdinalByRuntimeTurnId = new Map(
    self.productTurnSplitOrdinalByRuntimeTurnId,
  );
  clone.currentProductTurnStartedAtMs = self.currentProductTurnStartedAtMs;
  clone.highspeedModelDurationByTurnId = new Map(self.highspeedModelDurationByTurnId);
  clone.highspeedToolIntervalsByTurnId = new Map(
    [...self.highspeedToolIntervalsByTurnId].map(([turnId, intervals]) => [
      turnId,
      new Map([...intervals].map(([toolCallId, interval]) => [toolCallId, { ...interval }])),
    ]),
  );
  clone.deliveryByPendingInputId = new Map(self.deliveryByPendingInputId);
  clone.currentTurnId = self.currentTurnId;
  clone.currentTurnStartedModelOnly = self.currentTurnStartedModelOnly;
  clone.contextWindowState = { ...self.contextWindowState };
  clone.lastTurnModel = { ...self.lastTurnModel };
  clone.configModelTouchedByEvent = self.configModelTouchedByEvent;
  clone.configThoughtLevelsTouchedByEvent = self.configThoughtLevelsTouchedByEvent;
  clone.configModeTouchedByEvent = self.configModeTouchedByEvent;
  clone.droppedContentStreamEventCount = self.droppedContentStreamEventCount;
  clone.normalizationDiagnostics = [...self.normalizationDiagnostics];
  return clone;
}

export function adoptProjection(
  self: ProductProjectionContext,
  candidate: ProductProjectionContext,
): void {
  self.snapshot = candidate.snapshot;
  self.rowIndexById = candidate.rowIndexById;
  self.hydrationAccumulator = null;
  self.nextRowId = candidate.nextRowId;
  self.streamingTextRowId = candidate.streamingTextRowId;
  self.streamingReasoningRowId = candidate.streamingReasoningRowId;
  self.outputContinuationTextRowId = candidate.outputContinuationTextRowId;
  self.toolRowIdByCallId = candidate.toolRowIdByCallId;
  self.latestListAppsSnapshot = candidate.latestListAppsSnapshot;
  self.openForegroundToolCallIds = candidate.openForegroundToolCallIds;
  self.fileToolInputPreviewByCallId = candidate.fileToolInputPreviewByCallId;
  self.subagentRowIdByAgentId = candidate.subagentRowIdByAgentId;
  self.hookRowIdByInvocationId = candidate.hookRowIdByInvocationId;
  self.pendingSessionHookInvocations = candidate.pendingSessionHookInvocations;
  self.rewoundHookInvocationIds = candidate.rewoundHookInvocationIds;
  self.invalidSubagentChildSessionIds = candidate.invalidSubagentChildSessionIds;
  self.messageIdByRowId = candidate.messageIdByRowId;
  self.outputContinuationRowIdByMessageId = candidate.outputContinuationRowIdByMessageId;
  self.entityIdByRowId = candidate.entityIdByRowId;
  self.editTargetByEntityId = candidate.editTargetByEntityId;
  self.currentEditableEntityId = candidate.currentEditableEntityId;
  self.stableCompactCoverageBoundaryRowId = candidate.stableCompactCoverageBoundaryRowId;
  self.turnHeaderRowIdByTurnId = candidate.turnHeaderRowIdByTurnId;
  self.compactMarkerRowIdByOperationId = candidate.compactMarkerRowIdByOperationId;
  self.goalVerifyMarkerRowIdByLifecycleKey = candidate.goalVerifyMarkerRowIdByLifecycleKey;
  self.productTurnIdByRuntimeTurnId = candidate.productTurnIdByRuntimeTurnId;
  self.runtimeTurnIdByProductTurnId = candidate.runtimeTurnIdByProductTurnId;
  self.productTurnSplitOrdinalByRuntimeTurnId = candidate.productTurnSplitOrdinalByRuntimeTurnId;
  self.currentProductTurnStartedAtMs = candidate.currentProductTurnStartedAtMs;
  self.highspeedModelDurationByTurnId = candidate.highspeedModelDurationByTurnId;
  self.highspeedToolIntervalsByTurnId = candidate.highspeedToolIntervalsByTurnId;
  self.deliveryByPendingInputId = candidate.deliveryByPendingInputId;
  self.currentTurnId = candidate.currentTurnId;
  self.currentTurnStartedModelOnly = candidate.currentTurnStartedModelOnly;
  self.contextWindowState = candidate.contextWindowState;
  self.lastTurnModel = candidate.lastTurnModel;
  self.configModelTouchedByEvent = candidate.configModelTouchedByEvent;
  self.configThoughtLevelsTouchedByEvent = candidate.configThoughtLevelsTouchedByEvent;
  self.configModeTouchedByEvent = candidate.configModeTouchedByEvent;
  self.droppedContentStreamEventCount = candidate.droppedContentStreamEventCount;
  self.normalizationDiagnostics = candidate.normalizationDiagnostics;
}
