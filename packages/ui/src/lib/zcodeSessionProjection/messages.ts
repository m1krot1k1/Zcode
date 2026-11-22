import {
  getConversationMessageProjectionPolicy,
  textFromZCodeMessageParts,
  type ZCodeBackgroundTaskNotificationInfo,
  type ZCodePersistedMessage,
  type ZCodePersistedMessagePart,
  type ZCodePersistedToolCall,
  type ZCodeMessagePart,
  type ZCodeMessageWithParts,
  type ZCodeTimelineMeta,
} from "@zcode/shared";
import { formatModelPickerValue } from "./config.js";
import { mapPromptAttachmentsFromParts } from "./attachments.js";
import {
  extractSyntheticTimelineFromTextPart,
  synthesizeCompactionTimeline,
  synthesizeTimelineFromTimelinePart,
} from "./timelines.js";
import { mapToolPart } from "./tools.js";

export function zcodeMessageToZCodePersistedMessage(
  message: ZCodeMessageWithParts,
  goalIteration?: number,
  backgroundTaskNotifications?: ReadonlyMap<
    string,
    ZCodeBackgroundTaskNotificationInfo
  >,
): ZCodePersistedMessage {
  const tools: ZCodePersistedToolCall[] = [];
  const parts: ZCodePersistedMessagePart[] = [];
  const attachments = mapPromptAttachmentsFromParts(message.parts);
  const projectionPolicy =
    message.info.role === "user"
      ? getConversationMessageProjectionPolicy(message)
      : "realUserInput";
  let syntheticTimeline: ZCodeTimelineMeta | undefined;
  for (const part of message.parts) {
    if (part.type === "text") {
      if (!syntheticTimeline) {
        const fromText = extractSyntheticTimelineFromTextPart(part);
        if (fromText) {
          syntheticTimeline = fromText;
        }
      }
    } else if (part.type === "compaction" && !syntheticTimeline) {
      syntheticTimeline = synthesizeCompactionTimeline(part);
    } else if (part.type === "timeline" && !syntheticTimeline) {
      syntheticTimeline = synthesizeTimelineFromTimelinePart(part);
    }
  }
  for (const part of message.parts) {
    if (part.type === "text") {
      if (projectionPolicy !== "timelineOnly") {
        parts.push({ type: "content", content: part.text });
      }
    } else if (part.type === "reasoning") {
      parts.push({ type: "thought", content: part.text });
    } else if (part.type === "tool") {
      const toolIndex = tools.length;
      tools.push(mapToolPart(part, backgroundTaskNotifications));
      parts.push({ type: "tool-call", toolIndex });
    }
  }
  return {
    id: message.info.messageId,
    role: message.info.role,
    content:
      projectionPolicy === "timelineOnly" ? "" : textFromParts(message.parts),
    timestamp: message.info.time.created,
    // 未绑定恢复的历史消息可以没有模型来源；展示消息不能依赖可执行选型。
    model: message.info.model
      ? formatModelPickerValue(message.info.model)
      : undefined,
    ...(syntheticTimeline ? { syntheticTimeline } : {}),
    ...(attachments ? { attachments } : {}),
    ...(message.info.role === "assistant"
      ? {
          ...(goalIteration ? { goalIteration } : {}),
          durationMs: message.info.time.completed
            ? message.info.time.completed - message.info.time.created
            : undefined,
          thought: reasoningFromParts(message.parts),
          tools: tools.length > 0 ? tools : undefined,
          parts: parts.length > 0 ? parts : undefined,
        }
      : {}),
  };
}

function textFromParts(parts: readonly ZCodeMessagePart[]): string {
  return textFromZCodeMessageParts(parts);
}

function reasoningFromParts(
  parts: readonly ZCodeMessagePart[],
): string | undefined {
  const text = parts
    .filter(
      (part): part is Extract<ZCodeMessagePart, { type: "reasoning" }> =>
        part.type === "reasoning",
    )
    .map((part) => part.text)
    .join("");
  return text || undefined;
}
