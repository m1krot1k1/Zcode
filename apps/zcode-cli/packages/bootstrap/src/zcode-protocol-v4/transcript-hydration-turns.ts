// Transcript → SessionEvent 合成（「reduce(transcript) ≡ reduce(events)」）。
//
// 动机：v4 投影是事件溯源，但部分历史突变（纯对话 fork 复制 message 不复制 event、
// rewind 截断只动 message 库）会让 session 的事件日志无法覆盖可见 transcript。冷订阅
// hydration 从事件日志重建拿不到这些历史（「fork-child 历史」）。
//
// 本模块把 message 库的 transcript 反向合成为 reducer 能消费的 SessionEvent 序列——
// 从而复用整套 ProductProjection 归约逻辑，不必再写一份 message→row 的平行归约器。
// 合成事件是「视图重建」用途：只需产出与真实事件流「归约等价」的最小序列。
// v4 冷恢复只能重放 ProductProjection 认识的事件；如果 transcript 里的
// tool/reasoning/subagent/compact part 不反向合成，重启后历史可见运行态会从快照里消失。
import type { BackgroundResultOriginMeta, MessagePart, MessageWithParts, ModelSelection, TurnFileChangeSummary } from "@zcode/contracts";

import type { EventId, SessionEvent, SessionId, TraceId, TurnId } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import { getConversationModelOnlyTurnTriggerSource } from "@zcode/shared";
import { workflowBlockedMetaSchema, workflowNotificationMetaSchema, type ErrorAttribution } from "@zcode/shared/zcode-protocol-v4";


import { HYDRATION_TRACE_ID } from "./projection-state.js";

import { PushEvent, SynthesizeOptions, TurnResultForHydration, assistantErrorData, inputIntentOfMessage, isPersistedAssistantCancellation, isPersistedStreamRecoveryDiscard, isProviderContextOnlyAssistant, isRealUserTurnStarter, messageCreatedAtMs, messageEndAtMs, normalizeTurnResult, persistedErrorAttribution, textOfMessage, workflowLaunchOfMessage } from "./transcript-hydration-primitives.js";
import { GoalVerificationFact, HydratedTimelineModel, assistantMessageHasSynthesizableContent, assistantModelSelectionOf, attachmentMetasOfMessage, epilogueStartOfMessage, executionKindOfMessage, forkContextOfMessage, hydratedModelKey, isForkTimelineMessage, isTurnBoundaryStarter, mergeGoalVerificationEntryFacts, modelChangeToModelOf, pushGoalVerificationFact, steerDeliveryOfMessage, synthesizeAssistantParts, turnModelSelectionOfUserMessage } from "./transcript-hydration-parts.js";

/**
 * Оркестрация синтеза: обход транскрипта, границы turn, workflow/background-мета.
 * Вынесено из transcript-hydration.ts; зависит от примитивов и синтеза частей.
 */

export function backgroundResultOriginMetaOfMessage(
  message: MessageWithParts,
): BackgroundResultOriginMeta | undefined {
  const messageMetadata = message.info.metadata;
  const partMetadata = message.parts.find((part) => part.type === "text")?.metadata;
  const candidate = messageMetadata?.originMeta ?? partMetadata?.originMeta;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const record = candidate as Record<string, unknown>;
  const backgroundSource = record.backgroundSource;
  const workId = typeof record.workId === "string" ? record.workId.trim() : "";
  const title = typeof record.title === "string" ? record.title.trim() : "";
  // 三个取值与 BackgroundResultOriginMeta 保持同步（contracts/src/events/session.events.ts）。
  // "workflow" 是 workflow run（workId ≡ runId）：漏掉它，workflow 的后台结果轮在冷恢复后会
  // 静默退化成一条无标题 model-only 消息，工具卡→详情页的关联键随之丢失。
  if (
    (backgroundSource !== "bash" &&
      backgroundSource !== "subagent" &&
      backgroundSource !== "workflow") ||
    !workId ||
    !title
  ) {
    return undefined;
  }
  // manifest 载荷（workflowNotification）也要过冷恢复：这里若只回读三基字段，冷恢复后
  // 载荷就丢了——manifest 条目退回裸标题行。用 shared 的 zod schema 校验，畸形就**只丢载荷**
  // 保基字段，绝不抛：这是投影重建路径，一个坏载荷不该打挂整条冷恢复。
  const workflowNotification = parseWorkflowNotificationMeta(record.workflowNotification);
  // 空闲提醒的载荷在它自己的键上（contracts 的 WorkflowBlockedMeta），同样畸形只丢载荷。
  const workflowBlocked = workflowBlockedMetaSchema.safeParse(record.workflowBlocked);
  return {
    backgroundSource,
    title,
    workId,
    ...(workflowNotification ? { workflowNotification } : {}),
    ...(workflowBlocked.success ? { workflowBlocked: workflowBlocked.data } : {}),
  };
}

/** 防御性解析 manifest 载荷：畸形 / 缺席都回 undefined（调用方据此让字段缺席），绝不抛。 */
export function parseWorkflowNotificationMeta(
  value: unknown,
): BackgroundResultOriginMeta["workflowNotification"] {
  if (value === undefined || value === null) return undefined;
  const parsed = workflowNotificationMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function isLegacyCompactMaintenanceInput(
  message: MessageWithParts,
  nextMessage: MessageWithParts | undefined,
): boolean {
  if (message.info.role !== "user") return false;
  // 只修复缺 canonical policy 的旧数据；显式 user-visible `/compact` 必须原样下发，
  // UI 不得再靠文本覆盖 CLI visibility authority。
  if (message.info.visibility !== undefined || message.info.semantics !== undefined) return false;
  const text = textOfMessage(message.parts).trim();
  if (text !== "/compact" && !text.startsWith("/compact ")) return false;
  if (!nextMessage || nextMessage.info.role !== "assistant") return false;
  return nextMessage.parts.some(
    (part) =>
      part.type === "compaction" ||
      (part.type === "timeline" && part.timelineType === "context_compaction"),
  );
}

export interface TurnOutputCollection {
  failure?: {
    type: string;
    message: string;
    attribution?: ErrorAttribution;
    retryable?: boolean;
    data?: unknown;
  };
  nextIndex: number;
  resultType: TurnResultForHydration;
  toolCallCount: number;
  historyRoundCount: number;
  turnEndedAtMs: number;
}

/** 收集一轮的 assistant 输出（直到下一个轮边界）；普通轮与 preface 轮共用。 */
export function collectTurnOutput(options: {
  messages: readonly MessageWithParts[];
  startIndex: number;
  turnId: string;
  turnStartedAtMs: number;
  emittedCompactOperations: Set<string>;
  durableCompactPartsByOperation: ReadonlyMap<string, Extract<MessagePart, { type: "compaction" }>>;
  emittedGoalVerifications: Set<string>;
  goalVerificationsByAnchor: ReadonlyMap<string, GoalVerificationFact[]>;
  onModelChange: (selection: HydratedTimelineModel) => void;
  push: PushEvent;
}): TurnOutputCollection {
  const { messages, turnId, push } = options;
  let index = options.startIndex;
  let resultType: TurnResultForHydration = "success";
  let failure: TurnOutputCollection["failure"];
  // 被 stream recovery 作废的 tail 若是本轮最后一条 assistant，说明恢复请求没有落盘
  //（进程在重发前退出），本轮按 interrupted 收口；后续 assistant 出现则由它决定结果。
  let awaitingStreamRecovery = false;
  let toolCallCount = 0;
  let historyRoundCount = 0;
  let turnEndedAtMs = options.turnStartedAtMs;
  while (index < messages.length && !isTurnBoundaryStarter(messages[index]!)) {
    const message = messages[index]!;
    if (isProviderContextOnlyAssistant(message)) {
      // selection side chat 会把继承的 assistant 历史标成 model-only，
      // 旧 cold hydration 却只隐藏 user carrier，随后把 assistant 当作 preface/上一轮输出合成，
      // 导致副屏首次打开和冷恢复都泄漏父时间线。统一服从 projection policy，整条跳过。
      index += 1;
      continue;
    }
    if (isForkTimelineMessage(message)) {
      const forkContext = forkContextOfMessage(message);
      if (forkContext) {
        push(
          SessionEventType.SessionForked,
          {
            forkPoint: 0,
            originalSessionId: forkContext.parentSessionId,
            restoredFileCount: forkContext.restoredFileCount,
            targetCheckpointId: forkContext.targetCheckpointId,
            targetMessageId: forkContext.targetMessageId,
          },
          turnId,
        );
      }
      index += 1;
      continue;
    }
    // guide steer：内联进当前轮——合成 TurnSteerDrained（带 drainedInputs），
    // 投影按 delivery=guide 走内联 userInput 行，与 live 同一归约入口。
    if (message.info.role === "user" && steerDeliveryOfMessage(message) === "guide") {
      const intent = inputIntentOfMessage(message);
      // cold guide 过去只凭 messageId 临时拼 pendingInputId，且没有把
      // transcript 中已持久化的 ConversationInputIntent 带回事件；恢复后 row 会丢
      // sourceCommandId/clientId/attachments，命令去重与展示也不再和 live 等价。
      // 新数据优先复用原 queueItemId，legacy 才使用可诊断的 hydration fallback。
      const pendingInputId = intent?.queueItemId ?? `hydrate-steer-${String(message.info.id)}`;
      push(
        SessionEventType.TurnSteerDrained,
        {
          pendingInputIds: [pendingInputId],
          injectedMessageIds: [String(message.info.id)],
          drainedInputs: [
            {
              pendingInputId,
              messageId: String(message.info.id),
              text: textOfMessage(message.parts),
              delivery: "guide",
              ...(intent ? { intent } : {}),
            },
          ],
          targetTurnId: turnId,
        },
        turnId,
        messageCreatedAtMs(message),
      );
      index += 1;
      continue;
    }
    if (message.info.role !== "assistant") {
      index += 1;
      continue;
    }
    awaitingStreamRecovery =
      message.info.error !== undefined && isPersistedStreamRecoveryDiscard(message.info.error);
    if (
      message.info.error &&
      !isPersistedAssistantCancellation(message.info.error) &&
      !awaitingStreamRecovery
    ) {
      const data = assistantErrorData(message.info.error);
      const attribution = persistedErrorAttribution(data);
      failure = {
        type: message.info.error.name,
        message: (typeof data?.message === "string" && data.message) || message.info.error.name,
        // 旧 cold hydration 只把归因留在 data 内，TurnError 投影无法读取，重启后退化成 runtime。
        ...(attribution ? { attribution } : {}),
        ...(typeof data?.retryable === "boolean" ? { retryable: data.retryable } : {}),
        ...(message.info.error.data !== undefined ? { data: message.info.error.data } : {}),
      };
    }
    const timelineModel = modelChangeToModelOf(message);
    if (timelineModel) {
      options.onModelChange(timelineModel);
      index += 1;
      continue;
    }
    // Host 不能从 toolCallCount 或裁剪后的 history 长度反推模型轮次。
    // 新 transcript 在最终 assistant anchor 固化精确值；旧 transcript 才按独立
    // assistant history 条目做兼容计数。
    historyRoundCount = message.info.anchor?.historyRoundCount ?? historyRoundCount + 1;
    const messageEnd = messageEndAtMs(message);
    if (messageEnd !== undefined) {
      turnEndedAtMs = Math.max(turnEndedAtMs, messageEnd);
    }
    const synthesized = synthesizeAssistantParts(
      message,
      options.emittedCompactOperations,
      options.durableCompactPartsByOperation,
      options.emittedGoalVerifications,
      push,
      turnId,
    );
    resultType = normalizeTurnResult(resultType, synthesized.resultType);
    toolCallCount += synthesized.toolCallCount;
    if (
      message.info.role === "assistant" &&
      message.info.finish?.trim().toLowerCase() === "length" &&
      synthesized.toolCallCount === 0
    ) {
      // live ProductProjection 能从逐请求 ModelComplete 识别 output-token
      // Continue，但 cold transcript 过去只在整轮末尾合成一次 end_turn，导致刷新后
      // 同一句又退化成多条 assistant row。持久化 finish 是请求终止事实；用零 usage
      // 的 hydration-only ModelComplete 恢复资格，不重复累计 token 或注入 Continue user。
      push(
        SessionEventType.ModelComplete,
        {
          content: "",
          stopReason: "length",
          querySource: "main_turn",
          toolCallCount: 0,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        },
        turnId,
        messageEnd,
      );
    }
    // session_entry 源的 goal verify：锚定本条 assistant 的事实紧随其后落位
    //（与 timeline part 同 key 去重，先到先得）。
    const anchored = options.goalVerificationsByAnchor.get(String(message.info.id));
    if (anchored) {
      for (const fact of anchored) {
        pushGoalVerificationFact(fact, options.emittedGoalVerifications, push, turnId);
      }
    }
    index += 1;
  }
  if (awaitingStreamRecovery) {
    resultType = normalizeTurnResult(resultType, "cancelled");
  }
  return {
    ...(failure ? { failure } : {}),
    nextIndex: index,
    resultType,
    toolCallCount,
    historyRoundCount,
    turnEndedAtMs,
  };
}

/**
 * 把 transcript（按时间/parentID 顺序的 MessageWithParts）合成为归约等价的 SessionEvent 序列。
 * 轮次分组：user message 开一轮，紧随其后的 assistant message（同轮输出）直到下一个 user message。
 */
export function synthesizeEventsFromMessages(
  messages: readonly MessageWithParts[],
  options: SynthesizeOptions,
): SessionEvent[] {
  const sessionId = options.sessionId as SessionId;
  const traceId = HYDRATION_TRACE_ID as TraceId;
  let seq = 0;
  const baseMs = options.baseTimestampMs ?? messages[0]?.info.time.created ?? 0;
  const events: SessionEvent[] = [];

  const push = (
    type: SessionEventType,
    payload: unknown,
    turnId?: string,
    sourceTimestampMs?: number,
  ): void => {
    seq += 1;
    events.push({
      id: `hydrate-${seq}` as EventId,
      sessionId,
      turnId: turnId as TurnId | undefined,
      type,
      // source timestamp 仅恢复 row.createdAt 等展示事实；事件全序始终由 sequenceNumber 裁决。
      timestamp: new Date(sourceTimestampMs ?? baseMs + seq),
      traceId,
      sequenceNumber: seq,
      payload,
    });
  };

  // 历史消息不声明模型容量；调用方未知时保持未知，不能合成默认分母。
  const contextWindow = options.contextWindow;
  push(SessionEventType.SessionCreated, {
    mode: "default",
    contextWindow,
  });

  let turnNumber = 0;
  let index = 0;
  const emittedCompactOperations = new Set<string>();
  const durableCompactPartsByOperation = new Map<
    string,
    Extract<MessagePart, { type: "compaction" }>
  >();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "compaction") continue;
      if (!part.timelineStatus && !part.tail_start_id && !part.compactBoundary) continue;
      const operationId = String(
        part.operationId ?? part.boundaryId ?? `legacy-compact-${String(part.id)}`,
      );
      const existing = durableCompactPartsByOperation.get(operationId);
      if (!existing || (!existing.tail_start_id && part.tail_start_id)) {
        durableCompactPartsByOperation.set(operationId, part);
      }
    }
  }
  const emittedGoalVerifications = new Set<string>();
  let lastTurnId: string | undefined;

  const entryFacts = mergeGoalVerificationEntryFacts(options.goalVerificationEntries ?? []);
  const goalVerificationsByAnchor = new Map<string, GoalVerificationFact[]>();
  for (const fact of entryFacts) {
    if (!fact.anchorAssistantMessageId) continue;
    const list = goalVerificationsByAnchor.get(fact.anchorAssistantMessageId) ?? [];
    list.push(fact);
    goalVerificationsByAnchor.set(fact.anchorAssistantMessageId, list);
  }

  // MC-cold：modelChange marker 由投影在 TurnStarted 时
  // 对比 lastTurnModel 与 config 生成；冷恢复按每轮持久化选型事实在 TurnStarted 前
  // 合成 ModelSelected——普通首轮静默，显式 source-less 与后续 A→B 边界恒重建。
  // 该合成事件带 HYDRATION_TRACE_ID，不声明 种子权威（见 onModelSelected）。
  let lastSelectedModelKey: string | null = null;
  let pendingTimelineModel: HydratedTimelineModel | null = null;
  const selectTurnModel = (selection: HydratedTimelineModel | null): void => {
    if (!selection) return;
    const key = hydratedModelKey(selection.modelSelection);
    if (key === lastSelectedModelKey) return;
    lastSelectedModelKey = key;
    push(SessionEventType.ModelSelected, {
      modelSelection: selection.modelSelection,
      ...(selection.previousModelSelection !== undefined
        ? {
            previousModelSelection: selection.previousModelSelection
              ? selection.previousModelSelection
              : null,
          }
        : {}),
    });
  };
  const selectAcceptedTurnModel = (fallback: ModelSelection | null): void => {
    const selected = pendingTimelineModel ?? (fallback ? { modelSelection: fallback } : null);
    pendingTimelineModel = null;
    selectTurnModel(selected);
  };
  const recordTimelineModel = (selection: HydratedTimelineModel): void => {
    pendingTimelineModel = selection;
    selectTurnModel(selection);
  };

  const finishTurn = (input: {
    failure?: TurnOutputCollection["failure"];
    fileChanges?: TurnFileChangeSummary;
    turnId: string;
    resultType: TurnResultForHydration;
    toolCallCount: number;
    historyRoundCount: number;
    turnStartedAtMs: number;
    turnEndedAtMs: number;
  }): void => {
    if (input.failure) {
      // provider 首字前失败只持久化在 assistant.info.error，旧 cold 路径
      // 折成 TurnComplete(error_during_execution)，导致 lastError 的 code/message 全丢。
      // 这里复用 live 的 TurnError 状态机，避免另建 cold-only 错误 reducer。
      push(
        SessionEventType.TurnError,
        { error: input.failure, turnPhase: "model" },
        input.turnId,
        input.turnEndedAtMs,
      );
      return;
    }
    push(
      SessionEventType.ModelComplete,
      {
        content: "",
        stopReason: "end_turn",
        querySource: "main_turn",
        // 冷恢复曾把合成事件的窗口固定成 20 万，覆盖同一模型在
        // workspace provider registry 中的 1M 能力；这里沿用调用方解析出的当前模型真值。
        contextWindow,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        ...(input.fileChanges ? { fileChanges: input.fileChanges } : {}),
      },
      input.turnId,
      input.turnEndedAtMs,
    );
    push(
      SessionEventType.TurnComplete,
      {
        response: "",
        tokenCount: 0,
        toolCallCount: input.toolCallCount,
        historyRoundCount: input.historyRoundCount,
        // 冷恢复是从 message transcript 反向合成事件，不能像 live
        // 事件一样依赖运行时 startedAt；固定 0 会让历史轮次显示成 1 秒。
        duration: Math.max(0, input.turnEndedAtMs - input.turnStartedAtMs),
        resultType: input.resultType,
      },
      input.turnId,
      input.turnEndedAtMs,
    );
  };

  while (index < messages.length) {
    const message = messages[index]!;
    if (isProviderContextOnlyAssistant(message)) {
      index += 1;
      continue;
    }
    if (isLegacyCompactMaintenanceInput(message, messages[index + 1])) {
      // 旧手动 compact 的 user 宿主只是维护命令，不是 real-user intent；跳过宿主后，
      // 下一条 assistant compact fact 会走 preface model-only 轮并生成 canonical marker。
      index += 1;
      continue;
    }
    if (isForkTimelineMessage(message)) {
      const forkContext = forkContextOfMessage(message);
      if (forkContext) {
        push(SessionEventType.SessionForked, {
          forkPoint: 0,
          originalSessionId: forkContext.parentSessionId,
          restoredFileCount: forkContext.restoredFileCount,
          targetCheckpointId: forkContext.targetCheckpointId,
          targetMessageId: forkContext.targetMessageId,
        });
      }
      index += 1;
      continue;
    }
    const timelineModel = modelChangeToModelOf(message);
    if (timelineModel) {
      // model_change timeline part 是已接受轮的持久边界事实；
      // 宿主消息不能完全跳过、只靠后续 user message model 快照碰巧重建：
      // 快照缺失/滞后时 marker 就会消失，所以先消费显式 toModel，
      // 下一个 TurnStarted 仅使用该权威选型，不再被滞后快照覆盖。
      recordTimelineModel(timelineModel);
      index += 1;
      continue;
    }
    const workflowLaunch = workflowLaunchOfMessage(message);
    if (workflowLaunch) {
      // 中枢直接启动的启动轮：可见 controlOnly 用户轮，冷恢复须与活投影同形——同一 messageId、
      // origin workflowLaunch（由 inputSource 映射）、同一份 workflowLaunch 元数据、无助手输出。
      // 放在 real-user 分支之前，避免这条 synthetic user 被 hiddenSynthetic 跳过。
      turnNumber += 1;
      const turnId = `hydrate-turn-${turnNumber}`;
      lastTurnId = turnId;
      const launchText = textOfMessage(message.parts);
      const turnStartedAtMs = messageCreatedAtMs(message) ?? baseMs + seq;
      selectAcceptedTurnModel(turnModelSelectionOfUserMessage(message));
      push(
        SessionEventType.TurnStarted,
        {
          turnNumber,
          // 文本仍进 userInput.text（旧客户端 / TUI 的降级呈现）；GUI 用元数据画启动卡。
          input: launchText,
          // 持久 messageId 是该轮权威 target，与活投影同用，否则 productTurn 身份冷热分叉。
          messageId: String(message.info.id),
          // 启动轮不执行 Agent（controlOnly，无工时）；source 驱动 origin=workflowLaunch。
          executionKind: "controlOnly",
          inputSource: "workflow_launch",
          workflowLaunch,
        },
        turnId,
        turnStartedAtMs,
      );
      index += 1;
      const collected = collectTurnOutput({
        messages,
        startIndex: index,
        turnId,
        turnStartedAtMs,
        emittedCompactOperations,
        durableCompactPartsByOperation,
        emittedGoalVerifications,
        goalVerificationsByAnchor,
        onModelChange: recordTimelineModel,
        push,
      });
      index = collected.nextIndex;
      finishTurn({
        failure: collected.failure,
        turnId,
        resultType: collected.resultType,
        toolCallCount: collected.toolCallCount,
        historyRoundCount: collected.historyRoundCount,
        turnStartedAtMs,
        turnEndedAtMs: collected.turnEndedAtMs,
      });
      continue;
    }
    if (!isRealUserTurnStarter(message)) {
      // model-only 唤醒轮：background wake /
      // goal continuation 触发的 synthetic user 开独立 model-only 轮（无可见气泡，
      // 通知文本不进 rows），其后 assistant 归本轮——与 live 的 TurnStarted
      // (inputVisibility=model-only) 结构一致，不再并进上一轮。
      const wakeSource = getConversationModelOnlyTurnTriggerSource(message);
      if (wakeSource) {
        turnNumber += 1;
        const turnId = `hydrate-turn-${turnNumber}`;
        lastTurnId = turnId;
        const turnStartedAtMs = messageCreatedAtMs(message) ?? baseMs + seq;
        selectAcceptedTurnModel(turnModelSelectionOfUserMessage(message));
        push(
          SessionEventType.TurnStarted,
          {
            turnNumber,
            // cold hydration 曾把 model-only background wake 的原文清空，
            // 导致 ProductProjection 即使能消费 task-notification，恢复时也拿不到
            // tool-use-id 与失败详情。输入仍是 model-only，不会生成用户气泡。
            input: wakeSource === "background_task" ? textOfMessage(message.parts) : "",
            inputVisibility: "model-only",
            inputSource: wakeSource,
            ...(wakeSource === "background_task"
              ? { originMeta: backgroundResultOriginMetaOfMessage(message) }
              : {}),
            // model-only trigger 同样是持久 user 实体；若不传 messageId，
            // cold 会退化到 hydrate-turn-N，live/cold productTurn 身份再次分叉。
            messageId: String(message.info.id),
          },
          turnId,
          turnStartedAtMs,
        );
        index += 1;
        const collected = collectTurnOutput({
          messages,
          startIndex: index,
          turnId,
          turnStartedAtMs,
          emittedCompactOperations,
          durableCompactPartsByOperation,
          emittedGoalVerifications,
          goalVerificationsByAnchor,
          onModelChange: recordTimelineModel,
          push,
        });
        index = collected.nextIndex;
        finishTurn({
          failure: collected.failure,
          fileChanges: options.fileChangeSummariesByMessageId?.get(String(message.info.id)),
          turnId,
          resultType: collected.resultType,
          toolCallCount: collected.toolCallCount,
          historyRoundCount: collected.historyRoundCount,
          turnStartedAtMs,
          turnEndedAtMs: collected.turnEndedAtMs,
        });
        continue;
      }
      // assistant-head-skip 修复（「assistant 回复整段消失」冷路径向量）：
      // 首条真实用户消息之前的消息不能一律跳过——会话头部是 rewind notice /
      // compact summary 等非真实用户消息时，其后 assistant 回复刷新后会整段消失。
      // 因此为头部 assistant 输出合成 preface model-only 轮（无可见 user 气泡，
      // 内容照常渲染）。user 角色的非触发型 synthetic context 仍按设计不可见，照旧跳过。
      if (message.info.role !== "assistant" || !assistantMessageHasSynthesizableContent(message)) {
        index += 1;
        continue;
      }
      turnNumber += 1;
      const turnId = `hydrate-turn-${turnNumber}`;
      lastTurnId = turnId;
      const turnStartedAtMs = messageCreatedAtMs(message) ?? baseMs + seq;
      selectAcceptedTurnModel(assistantModelSelectionOf(message));
      push(
        SessionEventType.TurnStarted,
        { turnNumber, input: "", inputVisibility: "model-only" },
        turnId,
        turnStartedAtMs,
      );
      const collected = collectTurnOutput({
        messages,
        startIndex: index,
        turnId,
        turnStartedAtMs,
        emittedCompactOperations,
        durableCompactPartsByOperation,
        emittedGoalVerifications,
        goalVerificationsByAnchor,
        onModelChange: recordTimelineModel,
        push,
      });
      index = collected.nextIndex;
      finishTurn({
        failure: collected.failure,
        turnId,
        resultType: collected.resultType,
        toolCallCount: collected.toolCallCount,
        historyRoundCount: collected.historyRoundCount,
        turnStartedAtMs,
        turnEndedAtMs: collected.turnEndedAtMs,
      });
      continue;
    }

    turnNumber += 1;
    const turnId = `hydrate-turn-${turnNumber}`;
    lastTurnId = turnId;
    const userText = textOfMessage(message.parts);
    const attachments = attachmentMetasOfMessage(message.parts);
    const intent = inputIntentOfMessage(message);
    const executionKind = executionKindOfMessage(message);
    const epilogueStart = epilogueStartOfMessage(message);
    const turnStartedAtMs = messageCreatedAtMs(message) ?? baseMs + seq;
    // timeline part 与下一个 accepted turn 之间可以夹着 legacy synthetic
    // context，不能靠「紧邻前一条」猜测；持有显式边界直到真正开轮。
    selectAcceptedTurnModel(turnModelSelectionOfUserMessage(message));
    push(
      SessionEventType.TurnStarted,
      {
        turnNumber,
        input: userText,
        ...(epilogueStart === undefined ? {} : { epilogueStart }),
        // 根因：cold hydration 过去只重建可见 user row，遗漏持久 messageId，导致
        // 同一条历史消息在 UI 中可见却无法被 edit/rewind 命令寻址。真实 user
        // transcript message 就是该 row 的权威 target，必须与 live TurnStarted
        // 使用同一个 messageId 字段进入 ProductProjection。
        messageId: String(message.info.id),
        ...(executionKind ? { executionKind } : {}),
        ...(message.info.anchor?.sourceCommandId
          ? { inputId: message.info.anchor.sourceCommandId }
          : {}),
        ...(intent ? { intent } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      },
      turnId,
      turnStartedAtMs,
    );
    index += 1;

    const collected = collectTurnOutput({
      messages,
      startIndex: index,
      turnId,
      turnStartedAtMs,
      emittedCompactOperations,
      durableCompactPartsByOperation,
      emittedGoalVerifications,
      goalVerificationsByAnchor,
      onModelChange: recordTimelineModel,
      push,
    });
    index = collected.nextIndex;
    finishTurn({
      failure: collected.failure,
      fileChanges: options.fileChangeSummariesByMessageId?.get(String(message.info.id)),
      turnId,
      resultType: collected.resultType,
      toolCallCount: collected.toolCallCount,
      historyRoundCount: collected.historyRoundCount,
      turnStartedAtMs,
      turnEndedAtMs: collected.turnEndedAtMs,
    });
  }

  // anchor 缺失或指向未在 transcript 中出现的消息的 entry 事实：落到已知时间线末尾
  //（已按 key 去重，锚定成功的在上面循环里已发射；不猜 timestamp，不静默丢）。
  for (const fact of entryFacts) {
    pushGoalVerificationFact(fact, emittedGoalVerifications, push, lastTurnId);
  }

  return events;
}
