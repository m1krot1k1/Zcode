import type { MessageWithParts } from "@zcode/contracts";

export const SESSION_ENTRY_AUTO_RESUME = "session-auto-resume";
export const AUTO_RESUME_PROMPT_PREFIX = "[auto-resume]";

export interface InterruptedUserMessage {
  messageId: string;
  text: string;
  /** A tool without a durable result: its side effect outcome is unknown. */
  hasPendingTool: boolean;
}

/**
 * Finds the last real user submission and whether any tool was still running when
 * the process died. A pending tool is the safety boundary: auto-resume must not
 * blindly repeat an operation whose outcome was never persisted.
 */
export function findInterruptedUserMessage(
  messages: readonly MessageWithParts[],
): InterruptedUserMessage | undefined {
  let userIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.info.role !== "user" || message.info.summary) continue;
    const text = message.parts
      .flatMap((part) => (part.type === "text" ? [part.text.trim()] : []))
      .filter(Boolean)
      .join("\n\n");
    if (!text) continue;
    userIndex = index;
    break;
  }
  if (userIndex < 0) return undefined;
  const user = messages[userIndex]!;
  const text = user.parts
    .flatMap((part) => (part.type === "text" ? [part.text.trim()] : []))
    .filter(Boolean)
    .join("\n\n");
  if (text.startsWith(AUTO_RESUME_PROMPT_PREFIX)) return undefined;

  let hasPendingTool = false;
  for (let index = userIndex + 1; index < messages.length && !hasPendingTool; index += 1) {
    for (const part of messages[index]!.parts) {
      if (part.type !== "tool") continue;
      const status = part.state.status;
      if (status === "running" || status === "pending") {
        hasPendingTool = true;
        break;
      }
    }
  }
  return { messageId: user.info.id, text, hasPendingTool };
}

export function buildAutoResumePrompt(): string {
  return [
    `${AUTO_RESUME_PROMPT_PREFIX} Continue the interrupted task from the last saved state.`,
    "Use the transcript above as the source of truth. Do not repeat a tool call whose result is already present.",
    "If a previous side effect has an unknown outcome, verify it before acting; otherwise continue from the first unresolved step.",
    "Do not restart completed work and do not ask the user to repeat the request.",
  ].join(" ");
}
