import { z } from "zod";
import {
  AUTOMATION_CREATE_LIMIT,
  AUTOMATION_CREATE_LIMIT_ERROR_CODE,
  modelSelectionSchema,
  zcodeTaskModeSchema,
  type ModelSelection,
  type ZCodeAutomation,
  type ZCodeAutomationDispatchStatus,
  type ZCodeAutomationLifecycleStatus,
  type ZCodeAutomationRun,
  type ZCodeAutomationRunDispatchStatus,
  type ZCodeAutomationRunOutcome,
  type ZCodeAutomationTrigger,
} from "@zcode/shared";

/** 派发失败退避常量。 */
export const DISPATCH_RETRY_BASE_MS = 30_000;
export const DISPATCH_RETRY_CAP_MS = 15 * 60_000;
export const DISPATCH_MAX_ATTEMPTS = 5;
/** 认领超时回收：running=1 超过该时长仍未结算，视为持有者已崩溃，允许重新认领。 */
export const CLAIM_STALE_MS = 10 * 60_000;

/** 创建总数超过产品上限；错误码会跨 RPC 保留在 message 中供 UI 识别。 */
export class AutomationCreateLimitError extends Error {
  readonly code = AUTOMATION_CREATE_LIMIT_ERROR_CODE;

  constructor() {
    super(
      `[${AUTOMATION_CREATE_LIMIT_ERROR_CODE}] At most ${AUTOMATION_CREATE_LIMIT} automations may be retained. Delete an existing automation before creating another.`,
    );
    this.name = "AutomationCreateLimitError";
  }
}

export interface AutomationRow {
  automation_id: string;
  title: string;
  cron_expr: string;
  prompt: string;
  model: string | null;
  provider: string | null;
  mode: string | null;
  thought_level: string | null;
  model_selection: string | null;
  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  project_id?: string | null;
  host_id?: string | null;
  additional_directories?: string | null;
  target_task_id: string | null;
  bot_delivery_target: string | null;
  location_kind: string;
  recurring: number;
  max_runs: number | null;
  end_at: number | null;
  schedule_rule: string | null;
  schedule_edited_by_user: number;
  run_count: number;
  scheduled_run_count: number;
  enabled: number;
  lifecycle_status: string;
  next_run_at: number | null;
  last_run_at: number | null;
  running: number;
  claimed_at: number | null;
  dispatch_status: string;
  dispatch_attempts: number;
  retry_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface AutomationRunRow {
  run_id: string;
  automation_id: string;
  workspace_key: string;
  scheduled_at: number | null;
  trigger: string;
  model_selection: string | null;
  dispatch_status: string;
  outcome: string | null;
  session_id: string | null;
  error: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
}

export interface ClaimedManualAutomationRun {
  automation: ZCodeAutomation;
  run: ZCodeAutomationRun;
}

export function rowToAutomation(row: AutomationRow): ZCodeAutomation {
  const modelSelection = readAutomationModelSelection(row);
  return {
    automationId: row.automation_id,
    title: row.title,
    cronExpr: row.cron_expr,
    prompt: row.prompt,
    ...(modelSelection ? { modelSelection } : {}),
    // 历史版本曾把空字符串写进 mode，旧读取逻辑又直接强转为枚举，导致
    // automation/list 在协议层校验整个数组时被单条脏数据拖垮。历史非法值按未设置兼容。
    mode: normalizeAutomationMode(row.mode),
    workspaceKey: row.workspace_key,
    workspacePath: row.workspace_path,
    workspaceIdentity: row.workspace_identity ?? undefined,
    ...(row.project_id == null ? {} : { projectId: row.project_id }),
    ...(row.host_id == null ? {} : { hostId: row.host_id }),
    ...(row.additional_directories == null
      ? {}
      : {
          additionalDirectories: z
            .array(z.string().min(1))
            .max(256)
            .parse(JSON.parse(row.additional_directories)),
        }),
    targetTaskId: row.target_task_id ?? undefined,
    locationKind: row.location_kind === "remote" ? "remote" : "local",
    recurring: row.recurring === 1,
    maxRuns: row.max_runs ?? undefined,
    endAt: row.end_at ?? undefined,
    scheduleRule: row.schedule_rule
      ? (JSON.parse(row.schedule_rule) as ZCodeAutomation["scheduleRule"])
      : undefined,
    ...(row.schedule_edited_by_user === 1 ? { scheduleEditedByUser: true } : {}),
    runCount: row.run_count,
    enabled: row.enabled === 1,
    lifecycleStatus: row.lifecycle_status as ZCodeAutomationLifecycleStatus,
    nextRunAt: row.next_run_at ?? undefined,
    lastRunAt: row.last_run_at ?? undefined,
    dispatchStatus: row.dispatch_status as ZCodeAutomationDispatchStatus,
    dispatchAttempts: row.dispatch_attempts,
    retryAt: row.retry_at ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function readAutomationModelSelection(row: AutomationRow): ZCodeAutomation["modelSelection"] {
  // 旧字段只能经过独立 importer；新字段损坏或明确清空时不能复活旧选择。
  return readSerializedModelSelection(row.model_selection);
}

export function serializeAutomationModelSelection(
  selection: ZCodeAutomation["modelSelection"],
): string | null {
  if (!selection) return null;
  const options = selection.options;
  const parsed = modelSelectionSchema.parse({
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(options && Object.keys(options).length > 0 ? { options } : {}),
  });
  return JSON.stringify(parsed);
}

function normalizeAutomationMode(mode: string | null): ZCodeAutomation["mode"] | undefined {
  const parsed = zcodeTaskModeSchema.safeParse(mode);
  return parsed.success ? parsed.data : undefined;
}

export function assertValidAutomationMode(mode: unknown): void {
  if (mode === undefined || mode === null) return;
  if (!zcodeTaskModeSchema.safeParse(mode).success) {
    // 读取兼容历史脏数据不代表允许继续写脏数据；Repo 是绕过 RPC 时的最终持久化边界。
    throw new Error(`Invalid automation mode: ${String(mode)}`);
  }
}

export function rowToRun(row: AutomationRunRow): ZCodeAutomationRun {
  const modelSelection = readSerializedModelSelection(row.model_selection);
  return {
    runId: row.run_id,
    automationId: row.automation_id,
    workspaceKey: row.workspace_key,
    scheduledAt: row.scheduled_at ?? undefined,
    trigger: row.trigger as ZCodeAutomationTrigger,
    ...(modelSelection ? { modelSelection } : {}),
    dispatchStatus: row.dispatch_status as ZCodeAutomationRunDispatchStatus,
    outcome: (row.outcome as ZCodeAutomationRunOutcome | null) ?? undefined,
    sessionId: row.session_id ?? undefined,
    error: row.error ?? undefined,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function readSerializedModelSelection(value: string | null): ModelSelection | undefined {
  if (!value) return undefined;
  try {
    const parsed = modelSelectionSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** 退避重试时间：now + min(BASE * 2^(attempts-1), CAP)。 */
export function computeRetryAt(now: number, attempts: number): number {
  const backoff = Math.min(
    DISPATCH_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
    DISPATCH_RETRY_CAP_MS,
  );
  return now + backoff;
}
