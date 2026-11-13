import type { AssistantTextRow } from "@zcode/shared/zcode-protocol-v4";
import type { AssistantMessageFeedback } from "@/v4/conversation-row-view/types.js";

export function readAssistantFeedback(row: AssistantTextRow): AssistantMessageFeedback | null {
  // feedback 是 additive V4 row 字段；兼容旧 CLI 的 row 时缺省为 null。
  const feedback = row.feedback;
  return feedback === "like" || feedback === "dislike" ? feedback : null;
}
