import type {
  PlanIdentitySnapshot,
  ZCodeContextCompactionTimelineMeta,
  ZCodeProvider,
  ZCodeTimelineStatus,
} from "@zcode/shared";

import {
  legacyTelemetryModelValue,
  legacyTelemetryProviderId,
} from "@/lib/providerTelemetryIdentity.js";
import { resolvePromptTelemetryModelProvider, resolveProviderHostname } from "./modelIdentity.js";

export function buildPromptTelemetryExtraDetail(params: {
  askMode?: string | null;
  modelName?: string | null;
  provider?: ZCodeProvider;
  selectedSupplierKey?: string | null;
  providerBaseURL?: string | null;
  planIdentitySnapshot?: PlanIdentitySnapshot | null;
}): Record<string, string> {
  const modelProvider = resolvePromptTelemetryModelProvider({
    modelName: params.modelName,
    provider: params.provider,
    selectedSupplierKey: params.selectedSupplierKey,
  });
  const providerHostname = resolveProviderHostname(params.providerBaseURL);

  return {
    ask_mode: params.askMode ?? "",
    model_name: legacyTelemetryModelValue(params.modelName ?? ""),
    model_provider: legacyTelemetryProviderId(modelProvider),
    // 修复原因：custom provider 的 model_provider 经常是内部 uuid，数仓分析真实后端时没有意义。
    // provider_name 当前承载 provider hostname；不改 model_provider，避免影响既有 uuid/provider id 数仓口径。
    // 这里只从 URL 解析 hostname，不上报完整 endpoint，避免泄漏路径或 query。
    ...(providerHostname ? { provider_name: providerHostname } : {}),
    // agent 字段取 ZCode Agent provider；本仓库没有独立 session.agentId。
    agent: params.provider ?? "",
    plan_status: params.planIdentitySnapshot?.planStatus ?? "unknown",
    plan_product_id: params.planIdentitySnapshot?.planProductId ?? "",
  };
}

const COMPACTION_TERMINAL_STATUSES: readonly ZCodeTimelineStatus[] = [
  "completed",
  "failed",
  "interrupted",
];

function isCompactionTerminalStatus(status: ZCodeTimelineStatus): boolean {
  return COMPACTION_TERMINAL_STATUSES.includes(status);
}

/**
 * 构建压缩（context compaction）结果埋点字段。
 * 仅在终态（completed/failed/interrupted）返回字段对象，运行态（started/retrying/skipped）返回 null，
 * 调用方据此决定是否上报。成功率由数仓按 status 聚合：completed / (completed + failed + interrupted)。
 * provider/model 维度复用 buildPromptTelemetryExtraDetail，version 由后端 reportEvent 注入。
 */
export function buildCompactionTelemetryExtraDetail(params: {
  timeline: ZCodeContextCompactionTimelineMeta;
  provider?: ZCodeProvider;
  /** V4 fact 已从真实模型请求归一化出的 provider；优先于旧 UI supplier 推导。 */
  modelProvider?: string | null;
  modelName?: string | null;
  selectedSupplierKey?: string | null;
}): Record<string, string> | null {
  const { timeline } = params;
  if (!isCompactionTerminalStatus(timeline.status)) {
    return null;
  }

  const modelFields = params.provider
    ? buildPromptTelemetryExtraDetail({
        modelName: params.modelName,
        provider: params.provider,
        selectedSupplierKey: params.selectedSupplierKey,
      })
    : { model_name: params.modelName ?? "", model_provider: "" };

  const preCompactTokens = timeline.preCompactTokenCount ?? 0;
  const postCompactTokens = timeline.postCompactTokenCount ?? 0;
  // 压缩率用供应商口径 post/pre；pre 为 0（缺数据）时留空，避免除零污染分布。
  const compactRatio =
    preCompactTokens > 0 ? (postCompactTokens / preCompactTokens).toFixed(4) : "";
  const durationMs =
    timeline.startedAt !== undefined && timeline.endedAt !== undefined
      ? String(Math.max(timeline.endedAt - timeline.startedAt, 0))
      : "";

  return {
    status: timeline.status,
    trigger: timeline.trigger,
    reason: timeline.reason ?? "",
    attempt: String(timeline.attempt ?? 0),
    duration_ms: durationMs,
    pre_compact_tokens: String(preCompactTokens),
    post_compact_tokens: String(postCompactTokens),
    true_post_compact_tokens: String(timeline.truePostCompactTokenCount ?? 0),
    compact_ratio: compactRatio,
    model_name: legacyTelemetryModelValue(modelFields.model_name ?? ""),
    model_provider: legacyTelemetryProviderId(
      params.modelProvider?.trim() || modelFields.model_provider || "",
    ),
  };
}
