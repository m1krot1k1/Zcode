import type { AgentTelemetryErrorCategory } from "@zcode/contracts/telemetry";
import {
  isAbortLike,
  type ActiveWriterContext,
  type WriterLifecycleKeys,
} from "../agent-trace-support.js";

export function positiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

export function inheritedMetadata(
  parent: ActiveWriterContext | undefined,
  spanName: string,
): Omit<ActiveWriterContext, "activeContext" | "span"> {
  return {
    correlation: parent?.correlation,
    parent,
    spanName,
    toolCallId: parent?.toolCallId,
  };
}

export function lifecycleKeys(spanName: string): WriterLifecycleKeys {
  const prefix = `zcode.${spanName}`;
  return {
    abandonReason: `${prefix}.abandon_reason`,
    cancelReason: `${prefix}.cancel_reason`,
    errorCategory: `${prefix}.error_category`,
    errorCode: `${prefix}.error_code`,
    errorMessage: `${prefix}.error_message`,
    errorType: `${prefix}.error_type`,
    failureStage: `${prefix}.failure_stage`,
    outcome: `${prefix}.outcome`,
  };
}

export function classifyErrorCategory(error: unknown): AgentTelemetryErrorCategory {
  if (isAbortLike(error)) return "cancelled";
  if (!error || typeof error !== "object") return "unknown";
  const record = error as Record<string, unknown>;
  const status = typeof record.status === "number" ? record.status : record.statusCode;
  if (status === 401 || status === 403) return "authentication";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_limit";
  const code = String(record.code ?? "").toLowerCase();
  if (code.includes("timeout")) return "timeout";
  if (
    code.includes("network") ||
    code.includes("econn") ||
    code.includes("enotfound") ||
    code.includes("tls")
  ) {
    return "network";
  }
  return "unknown";
}
