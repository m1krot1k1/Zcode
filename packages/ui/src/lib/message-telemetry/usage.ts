import type { ZCodePersistedFileChange, ZCodeUsage } from "@zcode/shared";
import { computeLineChangeStat } from "@zcode/shared";

export function buildPromptUsageTelemetryExtraDetail(
  usage: ZCodeUsage | undefined,
  tokenSource?: string,
): Record<string, string> {
  if (!usage) {
    return {};
  }

  return {
    input_tokens: String(usage.inputTokens),
    output_tokens: String(usage.outputTokens),
    reasoning_tokens: String(usage.reasoningTokens ?? 0),
    cached_input_tokens: String(usage.cachedInputTokens ?? 0),
    cache_write_input_tokens: String(usage.cachedWriteInputTokens ?? 0),
    // ZCode Agent 链路未透出 tool use prompt token，成功态显式补 0 保持 extraDetail 字段集合完整。
    tool_use_prompt_tokens: "0",
    total_tokens: String(usage.totalTokens),
    ...(tokenSource ? { token_source: tokenSource } : {}),
  };
}

export function mergePromptUsage(left: ZCodeUsage | null, right: ZCodeUsage): ZCodeUsage {
  if (!left) {
    return {
      inputTokens: right.inputTokens,
      outputTokens: right.outputTokens,
      totalTokens: right.totalTokens,
      reasoningTokens: right.reasoningTokens ?? 0,
      cachedInputTokens: right.cachedInputTokens ?? 0,
      cachedWriteInputTokens: right.cachedWriteInputTokens ?? 0,
    };
  }

  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0),
    cachedInputTokens: (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0),
    cachedWriteInputTokens:
      (left.cachedWriteInputTokens ?? 0) + (right.cachedWriteInputTokens ?? 0),
  };
}

export function collectFileChangeMetrics(
  fileChanges: readonly ZCodePersistedFileChange[] | undefined,
) {
  if (!fileChanges || fileChanges.length === 0) {
    return {
      changedFileCount: 0,
      generatedCodeLines: 0,
    };
  }

  const changedFileMap = new Map<string, { beforeContent: string | null; afterContent: string }>();

  for (const turn of fileChanges) {
    for (const snapshot of turn.snapshots) {
      const existing = changedFileMap.get(snapshot.path);
      if (existing) {
        existing.afterContent = snapshot.afterContent;
      } else {
        changedFileMap.set(snapshot.path, {
          beforeContent: snapshot.beforeContent,
          afterContent: snapshot.afterContent,
        });
      }
    }
  }

  let generatedCodeLines = 0;
  for (const file of changedFileMap.values()) {
    generatedCodeLines += computeLineChangeStat(file.beforeContent, file.afterContent).added;
  }

  return {
    changedFileCount: changedFileMap.size,
    generatedCodeLines,
  };
}
