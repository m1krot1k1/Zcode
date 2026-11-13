import { legacyTelemetryModelFields } from "@/lib/providerTelemetryIdentity.js";

import { settleAllPermissionWaits } from "./permissionWaits.js";
import { activePromptTelemetryByTask, agentStepTelemetryByTask } from "./state.js";
import type { FinalizedPromptTelemetry, FinalizePromptTelemetryInput } from "./types.js";
import { buildPromptUsageTelemetryExtraDetail, collectFileChangeMetrics } from "./usage.js";

export function finalizePromptTelemetry(
  input: FinalizePromptTelemetryInput,
): FinalizedPromptTelemetry | null {
  const active = activePromptTelemetryByTask.get(input.taskId);
  if (!active) {
    return null;
  }

  settleAllPermissionWaits(active, agentStepTelemetryByTask.get(input.taskId), input.finishedAt);
  activePromptTelemetryByTask.delete(input.taskId);
  agentStepTelemetryByTask.delete(input.taskId);

  const { changedFileCount, generatedCodeLines } = collectFileChangeMetrics(input.fileChanges);
  const isSuccess = input.status === "success";
  // V4 live fact 的 usage 以低频 delta 到达，terminal 不重复携带整包累计值；
  // 旧链路仍可在 terminal 直接传 usage。成功态优先显式 terminal usage，缺省回落已聚合 delta。
  const usageForTelemetry = isSuccess
    ? (input.usage ?? active.usage ?? undefined)
    : (active.usage ?? undefined);
  const tokenSource = !isSuccess && active.usage ? "usage_delta" : undefined;
  const errorType = isSuccess
    ? ""
    : input.errorType?.trim() || (active.toolCallFailed > 0 ? "TOOL_CALL_FAILED" : "UNKNOWN");
  const errorMsg = isSuccess ? "" : input.errorMsg?.trim() || active.firstToolCallError;

  return {
    taskId: input.taskId,
    messageId: active.messageId,
    eventExtraDetail: {
      ...legacyTelemetryModelFields(active.baseEventExtraDetail),
      ...(usageForTelemetry
        ? buildPromptUsageTelemetryExtraDetail(usageForTelemetry, tokenSource)
        : {}),
      duration_ms: String(Math.max(input.finishedAt - active.sendTime, 0)),
      waiting_ms: String(active.waitingMs),
      generated_code_lines: String(generatedCodeLines),
      file_change_cnt: String(changedFileCount),
      time_to_first_token:
        active.firstTokenAt === null
          ? "-1"
          : String(Math.max(active.firstTokenAt - active.sendTime, 0)),
      request_time: String(active.sendTime),
      status: input.status,
      ...(input.messageSource ? { message_source: input.messageSource } : {}),
      agent_composition: input.agentComposition ?? "main_only",
      agent_step_cnt: String(active.finalizedAgentStepCount),
      retry_cnt: "0",
      tool_call_total: String(active.toolCallTotal),
      tool_call_failed: String(active.toolCallFailed),
      error_type: errorType,
      error_msg: errorMsg,
    },
  };
}
