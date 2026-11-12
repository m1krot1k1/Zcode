import { z } from "zod";
import { redactTelemetryText } from "./telemetryRedaction.js";

const pluginDimensionEnums: Record<string, readonly string[]> = {
  schema_version: ["1"],
  result: ["success", "failure", "cancelled", "noop", "partial"],
  source_type: ["builtin", "official_cdn", "personal", "unknown"],
  publisher_type: ["official", "community", "unknown"],
  entry: [
    "store_list",
    "store_detail",
    "side_pane_market",
    "recommended_prompt",
    "recommended_ui",
    "component_settings",
    "unknown",
  ],
  trigger: ["user", "dependency", "automatic", "restore", "sync"],
  scope: ["user", "workspace", "unknown"],
  client_kind: ["desktop", "mobile", "unknown"],
  workspace_kind: ["local", "remote"],
  remote_kind: ["", "ssh", "wsl", "docker", "server"],
  error_category: ["diagnostic", "transport", "timeout", "cancelled", "unknown"],
  plugin_component: ["skill", "mcp", "agent", "command", "hook", "lsp", "ui"],
  remove_cache: ["true", "false", "unknown"],
  action: [
    "install",
    "uninstall",
    "update",
    "restore",
    "enable",
    "disable",
    "configure",
    "reset_config",
    "source_add",
    "source_remove",
    "source_refresh",
    "sync",
    "store_view",
    "detail_view",
    "search",
    "ui_open_request",
    "ui_ready",
    "ui_close",
    "ui_tool_call",
  ],
};
const pluginIdentifierKeys = new Set([
  "plugin_id",
  "marketplace",
  "version_before",
  "version_after",
  "batch_id",
]);
const pluginNumericKeys = new Set(["duration_ms", "target_count", "result_count"]);
export const PLUGIN_TELEMETRY_EVENTS = [
  "plugin_lifecycle",
  "plugin_discovery",
  "plugin_usage",
  "plugin_runtime_error",
] as const;

/** 只清洗上报副本；拒绝任意配置/URL/路径和自由错误文本。 */
export function sanitizePluginTelemetryDetail(
  detail: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(detail).filter(([key, value]) => {
      if (pluginDimensionEnums[key]) return pluginDimensionEnums[key].includes(value);
      if (pluginNumericKeys.has(key)) return /^\d{1,15}$/.test(value);
      return (
        pluginIdentifierKeys.has(key) &&
        value.length <= 256 &&
        /^[A-Za-z0-9@._+:-]+$/.test(value) &&
        redactTelemetryText(value) === value
      );
    }),
  );
}

/** 手机只转发发现行为；管理结果由同一个 Desktop Host 产生。 */
export const mobilePluginDiscoveryTelemetrySchema = z
  .object({
    elementName: z.literal("plugin_discovery"),
    eventRegion: z.literal("app"),
    eventType: z.literal("view"),
    context: z
      .object({
        clientTimezone: z.string().max(128),
        clientLanguage: z.string().max(128),
        screenResolution: z.string().max(64),
      })
      .strict(),
    eventExtraDetail: z
      .object({
        schema_version: z.literal("1"),
        action: z.enum(["store_view", "detail_view", "search"]),
        entry: z.enum(["store_list", "store_detail", "side_pane_market"]),
        client_kind: z.literal("mobile"),
        plugin_id: z
          .string()
          .regex(/^[A-Za-z0-9@._+:-]+$/)
          .max(256)
          .optional(),
        result_count: z
          .string()
          .regex(/^\d{1,15}$/)
          .optional(),
      })
      .strict(),
  })
  .strict();
export type MobilePluginDiscoveryTelemetry = z.infer<typeof mobilePluginDiscoveryTelemetrySchema>;

export interface TelemetryRendererContext {
  clientTimezone: string;
  clientLanguage: string;
  screenResolution: string;
}

export interface TelemetryEventPayload {
  elementName: string;
  eventRegion: string;
  eventType: string;
  eventText?: string;
  eventExtraDetail: Record<string, string>;
  userId?: string;
  talkId?: string;
  messageId?: string;
}

export interface RendererTelemetryEventPayload extends TelemetryEventPayload {
  context: TelemetryRendererContext;
}

export interface ArmsCustomEventPayload {
  name: string;
  group: string;
  value?: number;
  properties?: Record<string, string | number | boolean | undefined>;
}

/** desktop main 实际传给 armsRum.sendCustom 的最终参数。 */
export interface FinalArmsCustomEventPayload {
  name: string;
  type: "custom";
  group: string;
  value: number;
  properties: Record<string, string>;
}

/** 仅 E2E test bridge 可读取的 main-process 内存记录。 */
export interface FinalArmsCustomEventE2EEntry {
  sequence: number;
  recordedAt: number;
  payload: FinalArmsCustomEventPayload;
}

export interface ConfigureFinalArmsCustomEventE2ERequest {
  /** 命中后仍进入 ring，但不调用真实 armsRum.sendCustom。 */
  suppressedEventNames: string[];
}

/**
 * URL 配置进入业务埋点前只允许提取 hostname。
 * 无效值和非 HTTP(S) 协议返回空串，避免误把完整 URL、userinfo 或任意文本带入 payload。
 */
export function resolveSafeTelemetryHostname(value: string | null | undefined): string {
  const normalized = value?.trim();
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    return parsed.hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** 错误原文可能带任意格式密钥；整体丢弃，不用正则猜测秘密边界。 */
export function sanitizeTelemetryErrorMessage(value: string | null | undefined): string {
  return value ? "[redacted]" : "";
}

const MAX_TELEMETRY_SKILL_NAME_LENGTH = 64;
const TELEMETRY_SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

/** 自由文本字段只允许短标签；超出部分截断，避免整段 prompt/文件内容出网。 */
export const MAX_TELEMETRY_EVENT_TEXT_LENGTH = 256;
/** detail 值的上限；键名必须是已知维度，避免任意 JSON 被塞进上报体。 */
export const MAX_TELEMETRY_EVENT_DETAIL_VALUE_LENGTH = 1024;
export const MAX_TELEMETRY_EVENT_DETAIL_ENTRIES = 64;

/**
 * 允许出网的 detail 维度白名单。新增埋点字段时必须同时在这里登记，
 * 这样 Host/Main 或旧 Renderer 绕过 UI 清洗时也不会把任意字段带到数仓。
 */
export const TELEMETRY_EVENT_DETAIL_ALLOWLIST: ReadonlySet<string> = new Set([
  "ack_cost_ms",
  "ack_status",
  "action",
  "action_source",
  "admission_result",
  "affected_session_count",
  "agent",
  "agent_composition",
  "agent_id",
  "agent_role",
  "agent_step_cnt",
  "ask_mode",
  "attempt",
  "automation_id",
  "automation_kind",
  "cache_write_input_tokens",
  "cached_input_tokens",
  "cached_tokens",
  "channel",
  "child_session_id",
  "child_tool_call_id",
  "claude_code_history_migration_selected",
  "client_kind",
  "command_category",
  "command_count",
  "command_name",
  "command_run_ms",
  "command_status",
  "compact_auto",
  "compact_ratio",
  "compact_reason",
  "completed_stage",
  "component",
  "connect_trigger",
  "create_source",
  "cron_expr",
  "directories_scanned",
  "disconnect_reason",
  "duration_ms",
  "entry",
  "entry_kind",
  "entry_plan_level",
  "entry_plan_list",
  "entry_plan_status",
  "error_category",
  "error_code",
  "error_detail_message",
  "error_fingerprint",
  "error_id",
  "error_key",
  "error_message",
  "error_msg",
  "error_name",
  "error_phase",
  "error_source",
  "error_type",
  "event_id",
  "exit_action",
  "exit_code",
  "exit_kind",
  "exit_reason",
  "exit_step",
  "fail_count",
  "failed_count",
  "failure_exception_kind",
  "failure_phase",
  "failure_reason",
  "failure_retryable",
  "failure_stage",
  "file_change_cnt",
  "file_count",
  "files_scanned",
  "first_output_ms",
  "focus_time",
  "generated_code_lines",
  "generation_tail_finalize_ms",
  "hunk_count",
  "idle_ms",
  "incident_kind",
  "input_tokens",
  "input_id",
  "input_first_char_time",
  "input_send_time",
  "input_start_time",
  "is_tftt_cached",
  "is_tool_call",
  "kind",
  "lag_ms",
  "lane",
  "login_default",
  "login_provider",
  "login_url",
  "loop_index",
  "marketplace",
  "memory_enabled",
  "message_source",
  "model_name",
  "model_provider",
  "model_request_count",
  "model_request_id",
  "off_peak_run_type",
  "off_peak_task_id",
  "output_tokens",
  "pair_kind",
  "parent_tool_call_id",
  "plan_product_id",
  "plan_status",
  "plugin_component",
  "plugin_id",
  "post_compact_tokens",
  "pre_compact_tokens",
  "proactive_task_recommendations_enabled",
  "provider_family",
  "provider_name",
  "purchase_audience",
  "purchase_funnel_id",
  "queue_position",
  "reaction",
  "reason",
  "reasoning_tokens",
  "remote_kind",
  "request_time",
  "result",
  "result_count",
  "retry_cnt",
  "schema_version",
  "schedule_lag_ms",
  "scheduled_at",
  "scope",
  "send_time",
  "skill_name",
  "started_at",
  "status",
  "step_id",
  "step_type",
  "task_id",
  "task_trigger",
  "template_id",
  "template_name",
  "template_prompt_hash",
  "template_prompt_length",
  "ticket_initial_state",
  "time_to_first_token",
  "token_source",
  "token_usage_scope",
  "tool_call_failed",
  "tool_call_id",
  "tool_call_total",
  "tool_name",
  "tool_use_prompt_tokens",
  "total_tokens",
  "trigger",
  "true_post_compact_tokens",
  "ui_mode",
  "upgrade_source",
  "waiting_ms",
  "workflow_run_id",
  "workflow_tool_call_id",
  "workspace_kind",
  "workspace_memory_enabled",
  "work_direction",
]);

/** 只截断、脱敏自由文本；不改变调用方对象。 */
export function sanitizeTelemetryEventText(value: string | null | undefined): string {
  if (!value) return "";
  return redactTelemetryText(value, { maxLength: MAX_TELEMETRY_EVENT_TEXT_LENGTH });
}

function sanitizeTelemetryEventDetailValue(key: string, value: string): string {
  if (!TELEMETRY_EVENT_DETAIL_ALLOWLIST.has(key)) {
    return "";
  }
  if (key === "error_msg") {
    return sanitizeTelemetryErrorMessage(value);
  }
  if (key === "skill_name") {
    return sanitizeTelemetrySkillName(value);
  }
  if (key === "login_url") {
    return sanitizeLoginHostname(value);
  }
  return redactTelemetryText(value, {
    maxLength: MAX_TELEMETRY_EVENT_DETAIL_VALUE_LENGTH,
  });
}

/**
 * 只用于已解析的 Skill 名称，不能据此信任模型请求参数。
 * 不 trim 或截断，以免把敏感文本残片变成看似合法的标识；出网时再次检查同一规则。
 */
export function sanitizeTelemetrySkillName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TELEMETRY_SKILL_NAME_LENGTH ||
    !TELEMETRY_SKILL_NAME_PATTERN.test(value) ||
    redactTelemetryText(value) !== value
  ) {
    return "unknown";
  }
  return value;
}

function sanitizeLoginHostname(value: string): string {
  const hostname = resolveSafeTelemetryHostname(value);
  if (hostname) return hostname;
  // UI 已取过 hostname 时 Core 仍需幂等；只接受精确 hostname，不放行无协议的路径或凭据。
  const normalized = value.trim().toLowerCase();
  return normalized && resolveSafeTelemetryHostname(`https://${normalized}`) === normalized
    ? normalized
    : "";
}

/** 只清洗上报副本；业务错误、授权地址和调用方持有的 detail 不得被修改。 */
export function sanitizeTelemetryEventDetail(
  elementName: string,
  detail: Readonly<Record<string, string>>,
): Record<string, string> {
  if ((PLUGIN_TELEMETRY_EVENTS as readonly string[]).includes(elementName))
    return sanitizePluginTelemetryDetail(detail);

  const entries = Object.entries(detail);
  // 先做键白名单与数量上限，再按字段做脱敏；顺序反过来会把被丢弃的原始值
  // 先交给 redactor，虽然不出网但会给调用方制造无意义的 CPU 开销。
  const allowedEntries = entries
    .filter(([key]) => TELEMETRY_EVENT_DETAIL_ALLOWLIST.has(key))
    .slice(0, MAX_TELEMETRY_EVENT_DETAIL_ENTRIES);

  return Object.fromEntries(
    allowedEntries
      .filter(
        ([key, value]) =>
          elementName !== "agent_step" ||
          (key !== "plugin_id" && key !== "plugin_component") ||
          key in sanitizePluginTelemetryDetail({ [key]: value }),
      )
      .map(([key, value]) => [key, sanitizeTelemetryEventDetailValue(key, value)]),
  );
}

interface TelemetryScreenLike {
  width: number;
  height: number;
}

interface TelemetryWindowLike {
  intlLocale?: string;
  timeZone?: string;
  screen: TelemetryScreenLike;
}

export function collectTelemetryRendererContext(
  options?: TelemetryWindowLike,
): TelemetryRendererContext {
  const resolvedIntlOptions =
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions() : undefined;
  const timeZone = options?.timeZone ?? resolvedIntlOptions?.timeZone ?? "UTC";
  const clientLanguage = options?.intlLocale ?? resolvedIntlOptions?.locale ?? "en-US";
  const runtimeScreen = (globalThis as { screen?: TelemetryScreenLike }).screen;
  const screen = options?.screen ?? runtimeScreen ?? { width: 0, height: 0 };

  return {
    clientTimezone: timeZone,
    clientLanguage,
    screenResolution: `${screen.width}x${screen.height}`,
  };
}
