import {
  normalizeAvailableZCodeMode,
  normalizeZCodeApiRetryStatus,
  mergeZCodeBackgroundTaskControlItems,
  parseZCodeBackgroundTaskControlItems,
  zcodeApiRetryFromModelNetworkStatusPayload,
  zcodeApiRetryFromStreamRecoveryPayload,
  zcodeTaskNetworkDebugStatusFromPayload,
  type ZCodeApiRetryStatus,
  type ZCodeBackgroundTaskControlItem,
  type ZCodeTaskTargetChangedAction,
  type ZCodeStreamEvent,
  type InputId,
  type TraceId,
  type ZCodeSessionMode,
} from "@zcode/shared";
import { getZCodeAgentAvailableModes } from "./config.js";
import { fromZCodeGoal } from "./goal.js";
import {
  asRecord,
  stringValue,
  type ZCodeSessionEventProjectionState,
} from "./primitives.js";
import { contextUsageFromPayload, usageFromPayload } from "./usage.js";

function ensureProjectionBackgroundTaskControlsCache(
  state: ZCodeSessionEventProjectionState | undefined,
): Map<string, ZCodeBackgroundTaskControlItem[]> | null {
  if (!state) {
    return null;
  }
  state.backgroundTaskControlsBySession ??= new Map();
  return state.backgroundTaskControlsBySession;
}

function setProjectionBackgroundTaskControls(
  state: ZCodeSessionEventProjectionState | undefined,
  taskId: string,
  jobs: ZCodeBackgroundTaskControlItem[],
) {
  ensureProjectionBackgroundTaskControlsCache(state)?.set(taskId, jobs);
}

function updateProjectionBackgroundTaskControlsFromPayload(
  state: ZCodeSessionEventProjectionState | undefined,
  taskId: string,
  payload: Record<string, unknown>,
): ZCodeBackgroundTaskControlItem[] | null {
  const parsedJobs = parseZCodeBackgroundTaskControlItems([payload]);
  if (parsedJobs.length === 0) {
    return null;
  }
  const cache = ensureProjectionBackgroundTaskControlsCache(state);
  if (!cache) {
    return parsedJobs;
  }
  const nextJobs = mergeZCodeBackgroundTaskControlItems(
    cache.get(taskId) ?? [],
    parsedJobs,
  );
  cache.set(taskId, nextJobs);
  return nextJobs;
}

export function mapSessionInfoLikePayload(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  eventId: string | undefined,
  payload: Record<string, unknown>,
  state: ZCodeSessionEventProjectionState | undefined,
): ZCodeStreamEvent[] {
  const events: ZCodeStreamEvent[] = [];
  const goalVerification = goalVerificationFromPayload(payload);
  if (goalVerification) {
    events.push({
      type: "goal_verification_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      verification: goalVerification,
    });
  }
  const tokenUsageDelta = taskTokenUsageDeltaFromPayload(
    taskId,
    traceId,
    inputId,
    eventId,
    payload,
  );
  if (tokenUsageDelta) {
    events.push(tokenUsageDelta);
  }
  const networkDebugStatus = zcodeTaskNetworkDebugStatusFromPayload({
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    ...(eventId ? { eventId } : {}),
    payload,
  });
  if (networkDebugStatus) {
    events.push(networkDebugStatus);
  }
  const contextUsage = contextUsageFromPayload(payload);
  if (contextUsage) {
    events.push({
      type: "usage_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      used: contextUsage.used,
      size: contextUsage.size,
      cost: contextUsage.cost ?? null,
      ...(contextUsage.cache ? { cache: contextUsage.cache } : {}),
      ...(contextUsage.breakdown ? { breakdown: contextUsage.breakdown } : {}),
    });
  }
  const title = stringValue(payload.title);
  if (title) {
    events.push({
      type: "session_info_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      title,
    });
  }
  const apiRetry = apiRetryFromSessionInfoPayload(payload);
  if (apiRetry !== undefined) {
    events.push({
      type: "session_info_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      apiRetry,
    });
  }
  const mode = stringValue(payload.mode);
  if (mode) {
    events.push({
      type: "mode_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      // Bugfix: EnterPlanMode 写入的 SessionModeChanged 会经 bootstrap 投影成 session.updated；
      // 这里把 mode payload 转成 UI 现有事件，避免菜单仍显示进入 plan 前的模式。
      currentModeId: normalizeAvailableZCodeMode(mode as ZCodeSessionMode),
      availableModes: getZCodeAgentAvailableModes(),
    });
  }
  if ("target" in payload && ("action" in payload || "source" in payload)) {
    const targetAction = normalizeTargetChangedAction(
      stringValue(payload.action),
    );
    events.push({
      type: "session_info_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      target: {
        action: targetAction,
        source: stringValue(payload.source) === "tool" ? "tool" : "runtime",
        target: payload.target ? fromZCodeGoal(payload.target as never) : null,
        previousTarget: payload.previousTarget
          ? fromZCodeGoal(payload.previousTarget as never)
          : undefined,
      },
    });
  }
  const projection = asRecord(payload.projection);
  if (Array.isArray(projection.backgroundJobs)) {
    const jobs = parseZCodeBackgroundTaskControlItems(
      projection.backgroundJobs,
    );
    setProjectionBackgroundTaskControls(state, taskId, jobs);
    events.push({
      type: "background_bash_jobs_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      jobs,
    });
  }
  const backgroundJobUpdate = updateProjectionBackgroundTaskControlsFromPayload(
    state,
    taskId,
    payload,
  );
  if (backgroundJobUpdate) {
    events.push({
      type: "background_bash_jobs_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      jobs: backgroundJobUpdate,
    });
  }
  return events;
}

function normalizeTargetChangedAction(
  action: string | undefined,
): ZCodeTaskTargetChangedAction {
  switch (action) {
    case "status_updated":
    case "cleared":
    case "usage_accounted":
    case "run_started":
    case "run_finished":
    case "summary_updated":
      return action;
    case "set":
    default:
      return "set";
  }
}

function goalVerificationFromPayload(
  payload: Record<string, unknown>,
):
  | Extract<
      ZCodeStreamEvent,
      { type: "goal_verification_update" }
    >["verification"]
  | null {
  if (stringValue(payload.querySource) !== "target_completion_verification") {
    return null;
  }
  const content = stringValue(payload.content);
  if (!content) {
    return null;
  }
  const parsed = parseJsonObjectFromText(content);
  if (!parsed) {
    // 修复原因：历史/实时投影可能只拿到 verifier 的原始模型文本；格式错误属于裁判链路故障，
    // 与 contracts 层保持 fail-open，避免恢复后又把已完成 goal 显示成未完成。
    return {
      passed: true,
      reason: "The completion verifier did not return valid JSON.",
    };
  }
  const reason =
    stringValue(parsed.reason)?.trim() ||
    "The completion verifier could not confirm that every goal requirement is complete.";
  const nextAction = stringValue(parsed.nextAction)?.trim();
  return {
    ...(nextAction ? { nextAction } : {}),
    passed: parsed.passed === true,
    reason,
  };
}

function parseJsonObjectFromText(text: string): Record<string, unknown> | null {
  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end < start) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(unfenced.slice(start, end + 1));
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function taskTokenUsageDeltaFromPayload(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  eventId: string | undefined,
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "task_token_usage_delta" }> | null {
  if (!isModelCompleteUsagePayload(payload)) {
    return null;
  }
  const usage = usageFromPayload(payload.usage);
  if (!usage || usage.totalTokens <= 0) {
    return null;
  }
  const querySource = stringValue(payload.querySource);
  const queryId = stringValue(payload.queryId);
  // 修复原因：累计 Token 要跟随每次模型完成实时更新，而不是等 task_complete 的整轮汇总；
  // eventId 是 protocol 流的稳定单事件标识，用它去重可避免前后台 monitor 重复记账。
  const eventKey =
    eventId ??
    `${traceId}:${inputId ?? "no-input"}:${queryId ?? "no-query"}:${querySource ?? "unknown"}:${usage.inputTokens}:` +
      `${usage.outputTokens}:${usage.totalTokens}`;
  return {
    type: "task_token_usage_delta",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    ...(queryId ? { queryId } : {}),
    eventKey,
    ...(eventId ? { eventId } : {}),
    ...(querySource ? { querySource } : {}),
    usage,
  };
}

function isModelCompleteUsagePayload(
  payload: Record<string, unknown>,
): boolean {
  if (!("usage" in payload)) {
    return false;
  }
  return (
    stringValue(payload.stopReason) !== undefined ||
    "contextWindow" in payload ||
    stringValue(payload.querySource) !== undefined
  );
}

function apiRetryFromSessionInfoPayload(
  payload: Record<string, unknown>,
): ZCodeApiRetryStatus | null | undefined {
  if ("apiRetry" in payload) {
    return normalizeZCodeApiRetryStatus(payload.apiRetry);
  }

  const runtimeRetry = normalizeZCodeApiRetryStatus(
    asRecord(payload.runtime).apiRetry,
  );
  if (runtimeRetry !== undefined) {
    return runtimeRetry;
  }

  const metaRetry = normalizeZCodeApiRetryStatus(
    asRecord(asRecord(payload._meta).zcode).apiRetry,
  );
  if (metaRetry !== undefined) {
    return metaRetry;
  }

  return (
    zcodeApiRetryFromStreamRecoveryPayload(payload) ??
    zcodeApiRetryFromModelNetworkStatusPayload(payload)
  );
}
