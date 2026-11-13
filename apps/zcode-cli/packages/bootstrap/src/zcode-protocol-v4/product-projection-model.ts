// ProductProjection 域模块：onModelSelected, onModelComplete, onCompactLifecycle, onSessionModeChanged 等。
// 函数签名为 (self, ...原方法参数)，方法体从 ProductProjection 原样移出；
// 只依赖上下文接口与类型基座，跨域调用一律经 self 上的方法，不直接 import 其它域模块。

import type {
  CompactLifecyclePayload,
  ModelCompletePayload,
  ModelSelectedPayload,
  ModelUsage,
  SessionEvent,
} from "@zcode/contracts";
import { getModelUsageContextTokens } from "@zcode/contracts";
import type {
  ConversationDelta,
  ConversationSnapshot,
  GoalState,
  SessionControl,
  StatePatch,
  TimelineMarkerPayload,
  TimelineMarkerRow,
} from "@zcode/shared/zcode-protocol-v4";
import { mapCompactMarkerOrigin, mapCompactMarkerStatus } from "./projection-rows.js";
import {
  HYDRATION_TRACE_ID,
  type AvailabilityContext,
  computeAvailability,
  computeInputRouting,
} from "./projection-state.js";
import {
  cloneSparseModelSelection,
  positiveInteger,
  sameSparseModelSelection,
} from "./product-projection-types.js";
import type { ProductProjectionContext } from "./product-projection-context.js";

export function onModelSelected(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as ModelSelectedPayload;
  // Bug 原因：把 fresh child 身份另存为 pending side state 后，原子投影 clone/adopt
  // 漏复制该字段，实时 marker 会消失。显式 null 直接复用模型基线表达 ∅→X，
  // 公共投影不再识别 Subagent 身份；后续选型只更新 config，不覆盖上一轮实际模型。
  if (payload.previousModelSelection === null) {
    self.lastTurnModel = { kind: "sourceLess" };
  }
  const prev = self.snapshot.config;
  const provider = payload.modelSelection.providerId;
  const model = payload.modelSelection.modelId;
  const thought =
    payload.effectiveReasoningLevel ?? payload.modelSelection.options?.reasoningLevel ?? "";
  const modelSelection = cloneSparseModelSelection(payload.modelSelection);
  const thoughtLevels = payload.supportedThoughtLevels
    ? [...payload.supportedThoughtLevels]
    : prev.thoughtLevels;
  const contextWindow =
    payload.contextWindow === null
      ? null
      : payload.contextWindow !== undefined
        ? positiveInteger(payload.contextWindow, 0) || undefined
        : undefined;
  // Bug 原因：旧事件只更新 config，runtime 虽已切到新模型，历史 usage 的 maxTokens
  // 仍停在源模型，直到下一次 ModelComplete 才偶然校准。窗口属于已应用模型能力，
  // 必须在同一个 ModelSelected 中提交；usedTokens 仍保留历史上下文事实。
  if (contextWindow !== undefined) {
    self.contextWindowState.touchedByEvent = true;
    self.contextWindowState.maxTokens =
      contextWindow !== null && contextWindow > 0 ? contextWindow : null;
  }
  const previousContextWindow = self.snapshot.usage.contextWindow;
  if (previousContextWindow) {
    self.contextWindowState.usedTokens = previousContextWindow.usedTokens;
  }
  const contextWindowChanged =
    contextWindow !== undefined &&
    (contextWindow === null
      ? previousContextWindow !== null
      : previousContextWindow === null || previousContextWindow.maxTokens !== contextWindow);
  // 日志事件触碰过模型选型后，种子不再覆盖（同值 return 也算触碰）。
  // 冷恢复合成的 ModelSelected（HYDRATION_TRACE_ID）例外：它只是从 message 事实
  // 重建历史选型供 modelChange marker 使用，不是权威选型动作；重放后 seedConfig
  // 仍以 runtime 真值（resume 已回写的上次/草稿选型）收口。
  if (String(event.traceId) !== HYDRATION_TRACE_ID) {
    self.configModelTouchedByEvent = true;
    if (payload.supportedThoughtLevels !== undefined) {
      self.configThoughtLevelsTouchedByEvent = true;
    }
  }
  // 选型事件只更新 config，不在选型时落 modelChange
  // marker——切换动作是意向，marker 归 onTurnStarted 按「与上一轮实际选型不同」
  // 裁决（见彼处注释与 Bug 背景）。
  const configChanged = !(
    prev.provider === provider &&
    prev.model === model &&
    sameSparseModelSelection(prev.modelSelection, modelSelection) &&
    prev.thought === thought &&
    prev.thoughtLevels.length === thoughtLevels.length &&
    prev.thoughtLevels.every((value, index) => value === thoughtLevels[index])
  );
  const modelTransition =
    payload.origin === "registryFallback" &&
    payload.previousModelSelection != null &&
    (payload.previousModelSelection.providerId !== provider ||
      payload.previousModelSelection.modelId !== model)
      ? {
          eventId: String(event.id),
          origin: payload.origin,
          from: {
            provider: payload.previousModelSelection.providerId,
            model: payload.previousModelSelection.modelId,
          },
          to: { provider, model },
        }
      : undefined;
  if (!configChanged && !contextWindowChanged && modelTransition === undefined) {
    return [];
  }
  return [
    {
      op: "state.updated",
      patch: {
        ...(configChanged
          ? { config: { ...prev, modelSelection, provider, model, thought, thoughtLevels } }
          : {}),
        // Bug 原因：仅投影 config 会丢失“由 registry fallback 触发”的来源，
        // renderer 无法安全地区分自动恢复和显式/历史切换。保留事件 ID 与起止身份，
        // 具体 toast 仍只由客户端在实时 online delivery 边界触发。
        ...(modelTransition ? { modelTransition } : {}),
        ...(contextWindowChanged
          ? {
              usage: {
                ...self.snapshot.usage,
                // Bug 原因：null 是 registry 清除显式窗口的权威事件，必须清空整个
                // usage.contextWindow；字段缺失才保留旧事件兼容语义。
                contextWindow:
                  contextWindow === null
                    ? null
                    : previousContextWindow
                      ? { ...previousContextWindow, maxTokens: contextWindow }
                      : {
                          usedTokens: self.contextWindowState.usedTokens,
                          maxTokens: contextWindow,
                          autoCompactThresholdTokens: null,
                        },
              },
            }
          : {}),
      },
    },
  ];
}

export function onModelComplete(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as ModelCompletePayload;
  const retryClearDeltas = self.acceptsActiveModelEvent(event) ? self.setApiRetry(null) : [];
  // 与旧 reducer 同一裁决：只有主会话往返才能覆盖 context 水位。
  const isMainTurn =
    payload.querySource !== undefined
      ? payload.querySource === "main_turn"
      : payload.stopReason !== "tool_internal";
  if (isMainTurn) self.outputContinuationTextRowId = null;
  if (
    isMainTurn &&
    payload.stopReason?.trim().toLowerCase() === "length" &&
    payload.toolCallCount === 0
  ) {
    const lastVisibleRow = self.snapshot.rows.window.at(-1);
    if (
      lastVisibleRow?.kind === "assistantText" &&
      lastVisibleRow.turnId === self.turnIdOf(event) &&
      lastVisibleRow.state === "complete"
    ) {
      self.outputContinuationTextRowId = lastVisibleRow.rowId;
    }
  }
  // subagent ModelComplete 的 usage 仍不是主会话水位，但它携带的
  // fileChanges 是 child session 自己的 workspace 事实，必须独立投影到 child turn header。
  const supportsFileChangeSummary = isMainTurn || payload.querySource === "subagent";
  const usage = payload.usage as ModelUsage;
  const deltas: ConversationDelta[] = [];
  const turnId = self.turnIdOf(event);
  const headerRowId = self.turnHeaderRowIdByTurnId.get(turnId);
  const headerRow = headerRowId !== undefined ? self.findRow(headerRowId) : undefined;
  if (headerRow?.kind === "turnHeader") {
    const fileChanges =
      supportsFileChangeSummary && payload.fileChanges && payload.fileChanges.files > 0
        ? {
            fileChanges: {
              additions: payload.fileChanges.additions,
              deletions: payload.fileChanges.deletions,
              files: payload.fileChanges.files,
              // Bug 根因：该条件对象随后与 headerRow 展开合并，TS 会把字面量扩宽为
              // string，导致 CLI 启动前构建无法满足 TurnFileChangeSummary 契约。
              state: "active" as const,
            },
          }
        : {};
    if (isMainTurn || "fileChanges" in fileChanges) {
      deltas.push({
        op: "row.upserted",
        row: {
          ...headerRow,
          ...fileChanges,
          // Bug 根因：Renderer 观察 running 快照的时机不可靠，continuous 可合并更新，
          // replayable 也可能首次恢复即终态。单 Turn token 必须在权威事件投影中累计。
          ...(isMainTurn
            ? { outputTokens: (headerRow.outputTokens ?? 0) + (usage.outputTokens ?? 0) }
            : {}),
        },
      });
    }
  }
  if (!isMainTurn) return [...deltas, ...retryClearDeltas];
  const usedTokens = getModelUsageContextTokens(usage) ?? 0;
  self.contextWindowState.usedTokens = usedTokens;
  const maxTokens = payload.contextWindow ?? self.contextWindowState.maxTokens;
  const cumulative = self.snapshot.usage.cumulative;
  deltas.push({
    op: "state.updated",
    patch: {
      usage: {
        // Bug 原因：registry 已显式清除窗口时，缺少 contextWindow 的 ModelComplete
        // 过去会用 0 重建对象，破坏未知容量语义。token 继续在侧状态和累计值中更新。
        contextWindow:
          maxTokens === null
            ? null
            : {
                usedTokens,
                maxTokens,
                autoCompactThresholdTokens:
                  self.snapshot.usage.contextWindow?.autoCompactThresholdTokens ?? null,
                ...(payload.cacheHit ? { cache: payload.cacheHit } : {}),
                ...(payload.contextUsageBreakdown && payload.contextUsageBreakdown.length > 0
                  ? { breakdown: payload.contextUsageBreakdown }
                  : {}),
              },
        cumulative: {
          inputTokens: cumulative.inputTokens + (usage.inputTokens ?? 0),
          outputTokens: cumulative.outputTokens + (usage.outputTokens ?? 0),
          cacheReadTokens: cumulative.cacheReadTokens + (usage.cacheReadTokens ?? 0),
          cacheWriteTokens: cumulative.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
        },
      },
    },
  });
  // ModelComplete 是缺少 network completed 事件时的成功兜底，不能让重试提示悬挂。
  deltas.push(...retryClearDeltas);
  return deltas;
}

export function onCompactLifecycle(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as CompactLifecyclePayload & {
    anchorMessageId?: string;
    tailStartMessageId?: string;
  };
  const existingRowId = self.compactMarkerRowIdByOperationId.get(payload.operationId);
  const existingRow = existingRowId !== undefined ? self.findRow(existingRowId) : undefined;
  const prev =
    existingRow?.kind === "timelineMarker" && existingRow.marker.type === "compact"
      ? existingRow.marker
      : undefined;

  const status = mapCompactMarkerStatus(payload.status);
  if (status === "success") {
    const coverageMessageId = payload.tailStartMessageId ?? payload.anchorMessageId;
    const coverageRowId = coverageMessageId ? self.rowIdForMessageId(coverageMessageId) : null;
    if (coverageRowId !== null) {
      self.stableCompactCoverageBoundaryRowId = Math.max(
        self.stableCompactCoverageBoundaryRowId ?? 0,
        coverageRowId,
      );
      for (const [rowId, entityId] of self.entityIdByRowId) {
        if (rowId > self.stableCompactCoverageBoundaryRowId) continue;
        const target = self.editTargetByEntityId.get(entityId);
        if (target && !target.coveredByStableCompact) {
          self.editTargetByEntityId.set(entityId, {
            ...target,
            coveredByStableCompact: true,
          });
        }
      }
    }
  }
  const tokensAfter =
    payload.truePostCompactTokenCount ?? payload.postCompactTokenCount ?? prev?.tokensAfter;
  const marker: TimelineMarkerPayload = {
    type: "compact",
    origin: prev?.origin ?? mapCompactMarkerOrigin(payload.trigger),
    status,
    // 终态事件才带 token 计数；upsert 时保留已知值（retry 不清零）。
    ...(payload.preCompactTokenCount !== undefined || prev?.tokensBefore !== undefined
      ? { tokensBefore: payload.preCompactTokenCount ?? prev?.tokensBefore }
      : {}),
    ...(tokensAfter !== undefined ? { tokensAfter } : {}),
    // summary 全文按 ref 拉（同 toolOutput/get）；以 summaryMessageId 占位。
    ...(payload.summaryMessageId !== undefined || prev?.summaryRef
      ? {
          summaryRef:
            payload.summaryMessageId !== undefined
              ? String(payload.summaryMessageId)
              : prev?.summaryRef,
        }
      : {}),
  };

  const deltas: ConversationDelta[] = [];
  if (existingRow?.kind === "timelineMarker") {
    deltas.push({
      op: "row.upserted",
      row: {
        ...existingRow,
        marker,
        ...(payload.sourceCommandId ? { sourceCommandId: payload.sourceCommandId } : {}),
      },
    });
  } else {
    const row: TimelineMarkerRow = {
      ...self.rowBase(event, self.turnIdOf(event), String(payload.operationId)),
      kind: "timelineMarker",
      lane: "assistantWork",
      marker,
      ...(payload.sourceCommandId ? { sourceCommandId: payload.sourceCommandId } : {}),
    };
    self.compactMarkerRowIdByOperationId.set(payload.operationId, row.rowId);
    deltas.push({ op: "row.appended", row });
  }

  // compacting 进出 activeWorks（guard 同源派生：compactOperationLock /
  // compactingAcceptsFutureInput 由此驱动，与 formal-proof evaluateCompacting 对齐）。
  const otherWorks = self.snapshot.control.activeWorks.filter((work) => work.kind !== "compact");
  if (status === "running") {
    deltas.push({
      op: "state.updated",
      patch: self.controlPatch({
        activeWorks: [...otherWorks, { kind: "compact", startedAt: self.ms(event) }],
        canStop: true,
        stopState: "stoppable",
        stopTargetKind: otherWorks.length > 0 ? "mixed" : "compact",
      }),
    });
  } else {
    deltas.push({
      op: "state.updated",
      patch: self.controlPatch({
        activeWorks: otherWorks,
        ...(otherWorks.length === 0
          ? {
              canStop: false,
              stopState: "idle" as const,
              stopTargetKind: "unknown" as const,
            }
          : {}),
      }),
    });
  }

  // compact 成功 → context 水位立即回落（usage.contextWindow 更新）。
  if (status === "success" && tokensAfter !== undefined) {
    self.contextWindowState.usedTokens = tokensAfter;
    const maxTokens =
      self.snapshot.usage.contextWindow?.maxTokens ?? self.contextWindowState.maxTokens;
    deltas.push({
      op: "state.updated",
      patch: {
        usage: {
          ...self.snapshot.usage,
          contextWindow:
            maxTokens === null
              ? null
              : {
                  usedTokens: tokensAfter,
                  maxTokens,
                  autoCompactThresholdTokens:
                    self.snapshot.usage.contextWindow?.autoCompactThresholdTokens ?? null,
                },
        },
      },
    });
  }
  return deltas;
}

export function onSessionModeChanged(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as {
    mode?: string;
    planEnabled?: boolean;
    source?: string;
    toolCallId?: string;
    permissionGrant?: { interactionId: string; queueItemIds: string[] };
  };
  const mode = typeof payload.mode === "string" ? payload.mode : "";
  // 日志事件触碰过 mode 后，种子不再覆盖（同值 return 也算触碰——日志有权威值）。
  if (mode) self.configModeTouchedByEvent = true;
  if (!mode) return [];
  const planEnabled = payload.planEnabled ?? mode === "plan";
  const planTransition =
    payload.source === "tool" && payload.toolCallId
      ? { toolCallId: payload.toolCallId, planEnabled }
      : self.snapshot.config.planTransition;
  if (
    self.snapshot.config.mode === mode &&
    self.snapshot.config.planEnabled === planEnabled &&
    planTransition === self.snapshot.config.planTransition &&
    !payload.permissionGrant
  )
    return [];
  return [
    {
      op: "state.updated",
      patch: {
        ...(payload.permissionGrant
          ? self.queuePatch({
              ...self.snapshot.queue,
              items: self.snapshot.queue.items.map((item) =>
                payload.permissionGrant!.queueItemIds.includes(item.queueItemId)
                  ? { ...item, mode: "yolo" as const }
                  : item,
              ),
            })
          : {}),
        config: {
          ...self.snapshot.config,
          mode,
          planEnabled,
          planTransition,
          ...(payload.permissionGrant
            ? { permissionGrant: { interactionId: payload.permissionGrant.interactionId } }
            : {}),
        },
      },
    },
  ];
}

export function onFollowupModeChanged(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as { mode?: "queue" | "guide" };
  const mode: "queue" | "guide" = payload.mode === "guide" ? "guide" : "queue";
  if (self.snapshot.config.followupMode === mode) return [];
  const nextConfig: ConversationSnapshot["config"] = {
    ...self.snapshot.config,
    followupMode: mode,
  };
  const context = self.deriveContext({});
  return [
    {
      op: "state.updated",
      patch: {
        config: nextConfig,
        availability: computeAvailability(context),
        inputRouting: computeInputRouting(context, mode),
      },
    },
  ];
}

export function deriveContext(
  self: ProductProjectionContext,
  overrides: {
    goal?: GoalState | null;
    queue?: ConversationSnapshot["queue"];
  },
): AvailabilityContext {
  const goal = overrides.goal === undefined ? self.snapshot.goal : overrides.goal;
  const queue = overrides.queue ?? self.snapshot.queue;
  return {
    phase: self.snapshot.control.phase,
    goalStatus: goal?.status ?? null,
    compacting: self.snapshot.control.activeWorks.some((work) => work.kind === "compact"),
    goalVerifying: self.snapshot.control.activeWorks.some((work) => work.kind === "goalVerifier"),
    queueLength: queue.items.length,
    autoDrain: queue.autoDrain,
  };
}

export function controlPatch(
  self: ProductProjectionContext,
  control: Partial<SessionControl>,
  goal?: GoalState | null,
  queue?: ConversationSnapshot["queue"],
): StatePatch {
  const next: SessionControl = { ...self.snapshot.control, ...control };
  const nextGoal = goal === undefined ? self.snapshot.goal : goal;
  const nextQueue = queue ?? self.snapshot.queue;
  const context = {
    phase: next.phase,
    goalStatus: nextGoal?.status ?? null,
    // compacting 不是独立 phase（封闭枚举），从 activeWorks 派生。
    compacting: next.activeWorks.some((work) => work.kind === "compact"),
    goalVerifying: next.activeWorks.some((work) => work.kind === "goalVerifier"),
    queueLength: nextQueue.items.length,
    autoDrain: nextQueue.autoDrain,
  };
  return {
    control: next,
    ...(goal === undefined ? {} : { goal }),
    ...(queue === undefined ? {} : { queue }),
    availability: computeAvailability(context),
    inputRouting: computeInputRouting(context, self.snapshot.config.followupMode),
  };
}

export function goalPatch(self: ProductProjectionContext, goal: GoalState | null): StatePatch {
  return {
    goal,
    availability: computeAvailability(self.deriveContext({ goal })),
  };
}

export function queuePatch(
  self: ProductProjectionContext,
  queue: ConversationSnapshot["queue"],
): StatePatch {
  const context = self.deriveContext({ queue });
  return {
    queue,
    availability: computeAvailability(context),
    inputRouting: computeInputRouting(context, self.snapshot.config.followupMode),
  };
}
