import type { BackgroundWorkSummary } from "@zcode/shared/zcode-protocol-v4";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  ConversationStatusPanelWorkflowRun,
  ConversationStatusPanelWorkflowRunWords,
} from "@/v4/conversationStatusPanelModel.js";

export function formatDurationUnits(
  totalSeconds: number,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const restSeconds = seconds % 60;
  const hourUnit = formatMessage({ id: "chat.summaryPanel.duration.hours" });
  const minuteUnit = formatMessage({ id: "chat.summaryPanel.duration.minutes" });
  const secondUnit = formatMessage({ id: "chat.summaryPanel.duration.seconds" });
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours}${hourUnit}`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}${minuteUnit}`);
  }
  if (restSeconds > 0 || parts.length === 0) {
    parts.push(`${restSeconds}${secondUnit}`);
  }
  return parts.join(" ");
}

export function getBackgroundWorkElapsedMs(work: BackgroundWorkSummary, now: number) {
  return Math.max(0, now - work.startedAt);
}

export function getLongestRunningWorkElapsedMs(
  works: readonly BackgroundWorkSummary[],
  now: number,
) {
  return works.reduce(
    (longestElapsedMs, work) => Math.max(longestElapsedMs, getBackgroundWorkElapsedMs(work, now)),
    0,
  );
}

export function formatRunningCount(
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
  count: number,
) {
  return formatMessage(
    {
      id:
        count === 1
          ? "chat.summaryPanel.runningBackgroundTasksMiniValue"
          : "chat.summaryPanel.runningBackgroundTasksMiniValuePlural",
    },
    { count: String(count) },
  );
}

export function formatRunningSubagentCount(
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
  count: number,
) {
  return formatMessage(
    {
      // 这里的计数至少包含 running 投影中的 subagent（可能是 mixed 胶囊总数）；
      // subagent 又包含 foreground、background、blocked 和 waiting，复用后台任务文案
      // 会把计数语义错误地缩窄成“后台”。
      id:
        count === 1
          ? "chat.statusPanel.runningAgentsValue"
          : "chat.statusPanel.runningAgentsValuePlural",
    },
    { count: String(count) },
  );
}

/**
 * run 行的时长：沿用分区头部的时长单位（formatDurationUnits），但不带「已运行」前缀，且超过
 * 一小时去掉秒——一条跑了一小时的 run 上逐秒跳动的数字只是噪音（`1小时 2分` / `1h 2m`）。
 */
export function formatWorkflowRunElapsed(
  elapsedMs: number,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
) {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return formatDurationUnits(seconds >= 3600 ? seconds - (seconds % 60) : seconds, formatMessage);
}

/** run 「此刻在做什么」的词，按 i18n 拼成一句（规则在模型层的 `workflowRunWords`）。 */
export function formatWorkflowRunWords(
  words: ConversationStatusPanelWorkflowRunWords,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
) {
  switch (words.kind) {
    case "status":
      return formatMessage({ id: `chat.toolCall.workflow.run.status.${words.status}` });
    case "steps":
      return formatMessage(
        { id: "chat.toolCall.workflow.card.steps" },
        { done: String(words.done), total: String(words.total) },
      );
    case "phases":
      return words.text;
  }
}

/** 未命名的判定：`title ≡ runId`（见 `ConversationStatusPanelWorkflowRun.title`）。 */
export function workflowRunDisplayName(run: ConversationStatusPanelWorkflowRun): string | null {
  return run.title && run.title !== run.runId ? run.title : null;
}
