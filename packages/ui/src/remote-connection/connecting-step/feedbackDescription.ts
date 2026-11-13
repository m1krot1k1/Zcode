import { redactFeedbackText } from "@zcode/shared";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";

/** 反馈入口只带脱敏后的错误摘要与最近 30 条日志，附件由用户主动选择。 */
export function buildRemoteConnectionFeedbackDescription(
  errorMessage: string,
  logs: RemoteConnectionLogEntry[],
  formatMessage: (id: string, values?: Record<string, string>) => string,
) {
  const logText = logs
    .slice(-30)
    .map((entry) => `${entry.timestamp} [${entry.level.toUpperCase()}] ${entry.message}`)
    .join("\n");
  return redactFeedbackText(
    [
      formatMessage("feedback.submit.template.section.remoteHeading"),
      "",
      formatMessage("feedback.submit.template.section.errorSummary"),
      errorMessage || formatMessage("feedback.submit.template.section.notProvided"),
      "",
      formatMessage("feedback.submit.template.section.remoteLog"),
      logText || formatMessage("feedback.submit.template.section.remoteLogEmpty"),
      "",
      formatMessage("feedback.submit.template.section.remoteEnvironment"),
      formatMessage("feedback.submit.template.section.supplement"),
    ].join("\n"),
  );
}
