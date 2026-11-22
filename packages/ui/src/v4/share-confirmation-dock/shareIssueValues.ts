import type { ConversationShareFailureIssue } from "./contract.ts";
import {
  formatConversationShareAllowedArtifacts,
  formatConversationShareArtifactType,
} from "@/lib/conversationShareError.js";

/** 大小类指标按 B / KB / MB 归一，其余指标保持原值字符串。 */
export function formatShareMetricValue(value: number | undefined, code: string): string {
  if (value === undefined) return "—";
  if (code.includes("size") || code === "payload_size_limit") {
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    if (value >= 1024) return `${Math.round(value / 1024)} KB`;
    return `${value} B`;
  }
  return String(value);
}

/**
 * 失败明细与跳过提示共用同一套占位符：两个区块的文案参数曾各自拼装，
 * 抽出后避免键名或回退符号漂移。
 */
export function buildShareIssueValues(
  issue: ConversationShareFailureIssue,
  locale: string,
): Record<string, string | number> {
  return {
    turnOrdinal: issue.turnOrdinal ?? "—",
    artifactDisplayName: issue.artifactDisplayName ?? "—",
    artifactType: formatConversationShareArtifactType(issue, locale),
    extension: issue.extension ?? "—",
    mimeType: issue.mimeType ?? "—",
    allowedFormats: formatConversationShareAllowedArtifacts(issue, locale),
    actual: formatShareMetricValue(issue.actual, issue.code),
    limit: formatShareMetricValue(issue.limit, issue.code),
    phase: issue.phase ?? "—",
  };
}
