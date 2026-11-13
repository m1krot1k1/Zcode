import { toolCallDisplaySchema } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";

import { throwProjectionError } from "./errors.js";
import { requiredMappedId, type PublicIdMaps } from "./ids.js";
import { isPublicArtifactRef } from "./safety.js";

// display 的闭集独立于 row.kind 演进；复用正式 schema，避免浅拷贝把未知嵌套字段送到 confirm。
export function projectToolDisplay(row: ToolCallRow) {
  const parsed = toolCallDisplaySchema.safeParse(row.display);
  if (!parsed.success) {
    throwProjectionError("invalid_conversation", "Invalid tool display in shared conversation", {
      rowKind: row.kind,
      rowId: row.rowId,
      field: ["display", ...(parsed.error.issues[0]?.path ?? [])].join("."),
    });
  }
  // 插件交互资源属于宿主能力，公开卡片只保留 MCP 的静态描述。
  if (parsed.data.kind === "mcp_tool") {
    const { ui: _ui, ...display } = parsed.data;
    return display;
  }
  return parsed.data;
}

export function projectBase(row: ConversationRow, index: number, ids: PublicIdMaps) {
  if (!row.productTurnId) {
    throwProjectionError(
      "invalid_conversation",
      "Conversation row is missing its product turn identity",
    );
  }
  return {
    rowId: index + 1,
    turnId: requiredMappedId(ids.turnIds, row.turnId, "turn"),
    ...(row.entityId
      ? {
          entityId: requiredMappedId(ids.entityIds, row.entityId, "entity"),
        }
      : {}),
    productTurnId: requiredMappedId(ids.productTurnIds, row.productTurnId, "product turn"),
    ...(row.visibility ? { visibility: row.visibility } : {}),
    createdAt: row.createdAt,
    createdAtSeq: row.createdAtSeq,
  } as const;
}

export function projectTimelineMarker(
  row: Extract<ConversationRow, { kind: "timelineMarker" }>,
): Extract<ConversationRow, { kind: "timelineMarker" }>["marker"] {
  switch (row.marker.type) {
    case "compact":
      return {
        type: "compact",
        origin: row.marker.origin,
        status: row.marker.status,
        ...(row.marker.tokensBefore === undefined ? {} : { tokensBefore: row.marker.tokensBefore }),
        ...(row.marker.tokensAfter === undefined ? {} : { tokensAfter: row.marker.tokensAfter }),
      };
    case "modelChange":
      return { ...row.marker };
    case "goalSet":
      return { ...row.marker };
    case "goalVerify":
      return { ...row.marker };
    case "retryNotice":
      return { ...row.marker };
    case "forkNotice":
    case "forkCreated":
    case "checkpointRestored":
      throwProjectionError(
        "invalid_conversation",
        "Timeline references outside the shared projection are not supported",
      );
  }
}

/**
 * 每类 Row 用 allow-list 新建对象。
 *
 * 这个 switch 故意穷尽且**不带 default**：返回类型非可选，所以 conversationRowSchema 新增
 * 一种 kind 时这里会编译失败。那是有意的闸门——公开投影是跨版本数据交换格式，往里加一种
 * 老客户端读不了的 kind 必须是个显式决定，不能靠 default 悄悄放过去。
 */
export function projectRow(
  row: ConversationRow,
  index: number,
  ids: PublicIdMaps,
): ConversationRow {
  const base = projectBase(row, index, ids);
  switch (row.kind) {
    case "turnHeader":
      return {
        ...base,
        kind: "turnHeader",
        origin: row.origin,
        ...(row.executionKind ? { executionKind: row.executionKind } : {}),
        state: row.state,
        startedAt: row.startedAt,
        ...(row.endedAt === undefined ? {} : { endedAt: row.endedAt }),
        ...(row.activeMs === undefined ? {} : { activeMs: row.activeMs }),
        ...(row.workSegments
          ? {
              workSegments: row.workSegments.map((segment) => ({
                segmentId: segment.segmentId,
                ...(segment.triggerEntityId
                  ? {
                      triggerEntityId: requiredMappedId(
                        ids.entityIds,
                        segment.triggerEntityId,
                        "work segment entity",
                      ),
                    }
                  : {}),
                startedAt: segment.startedAt,
                ...(segment.endedAt === undefined ? {} : { endedAt: segment.endedAt }),
                ...(segment.activeMs === undefined ? {} : { activeMs: segment.activeMs }),
              })),
            }
          : {}),
        ...(row.fileChanges ? { fileChanges: { ...row.fileChanges } } : {}),
      };
    case "userInput": {
      const originMeta = row.originMeta
        ? {
            ...(row.originMeta.backgroundSource
              ? { backgroundSource: row.originMeta.backgroundSource }
              : {}),
            ...(row.originMeta.senderLabel ? { senderLabel: row.originMeta.senderLabel } : {}),
          }
        : undefined;
      const attachments = row.attachments?.flatMap((attachment) => {
        if (!isPublicArtifactRef(attachment.ref)) return [];
        if (attachment.previewRef !== undefined && !isPublicArtifactRef(attachment.previewRef)) {
          return [];
        }
        return [
          {
            ref: attachment.ref,
            fileName: attachment.fileName,
            mime: attachment.mime,
            bytes: attachment.bytes,
            ...(attachment.previewRef ? { previewRef: attachment.previewRef } : {}),
          },
        ];
      });
      return {
        ...base,
        kind: "userInput",
        text: row.text,
        origin: row.origin,
        ...(originMeta && Object.keys(originMeta).length > 0 ? { originMeta } : {}),
        ...(row.guided ? { guided: row.guided } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      };
    }
    case "assistantText":
      return {
        ...base,
        kind: "assistantText",
        text: row.text,
        state: row.state,
        ...(row.model ? { model: row.model } : {}),
      };
    case "reasoning":
      return {
        ...base,
        kind: "reasoning",
        text: row.text,
        state: row.state,
        ...(row.durationMs === undefined ? {} : { durationMs: row.durationMs }),
      };
    case "toolCall":
      return {
        ...base,
        kind: "toolCall",
        toolCallId: requiredMappedId(ids.toolCallIds, row.toolCallId, "tool call"),
        toolName: row.toolName,
        status: row.status,
        inputText: row.inputText,
        ...(row.input === undefined ? {} : { input: row.input }),
        ...(row.output ? { output: { text: row.output.text } } : {}),
        ...(row.display ? { display: projectToolDisplay(row) } : {}),
        ...(row.error ? { error: { ...row.error } } : {}),
        ...(row.backgrounded ? { backgrounded: row.backgrounded } : {}),
        ...(row.startedAt === undefined ? {} : { startedAt: row.startedAt }),
        ...(row.endedAt === undefined ? {} : { endedAt: row.endedAt }),
      };
    case "artifact": {
      const artifactVersionId = requiredMappedId(
        ids.artifactIds,
        row.artifactVersionId,
        "artifact",
      );
      return {
        ...base,
        kind: "artifact",
        artifactVersionId,
        logicalArtifactKey: requiredMappedId(
          ids.artifactKeys,
          row.logicalArtifactKey,
          "artifact key",
        ),
        displayName: row.displayName,
        artifactType: row.artifactType,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        sha256: row.sha256,
        ref: `zcode-artifact://share/${artifactVersionId}`,
        state: row.state,
      };
    }
    case "timelineMarker":
      return {
        ...base,
        kind: "timelineMarker",
        ...(row.lane ? { lane: row.lane } : {}),
        marker: projectTimelineMarker(row),
      };
    case "swarmRun":
      throwProjectionError(
        "invalid_conversation",
        "Swarm lifecycle rows contain local child-session identities and cannot be shared",
      );
    case "externalAgentRun":
      return {
        ...base,
        kind: "externalAgentRun",
        runId: `share-external-run-${index + 1}`,
        commandId: `share-external-command-${index + 1}`,
        provider: "opencode-cli",
        ...(row.modelId ? { modelId: row.modelId } : {}),
        promptText: row.promptText,
        output: { text: row.output.text },
        tools: row.tools.map(({ title, status }, toolIndex) => ({
          toolCallId: `share-external-tool-${index + 1}-${toolIndex + 1}`,
          title,
          status,
        })),
        status: row.status,
        ...(row.startedAt === undefined ? {} : { startedAt: row.startedAt }),
        ...(row.endedAt === undefined ? {} : { endedAt: row.endedAt }),
      };
    case "subagent":
      throwProjectionError(
        "invalid_conversation",
        "Subagent detail rows must be filtered before public projection",
      );
    case "hookInvocation":
      throwProjectionError(
        "invalid_conversation",
        "Hook invocation rows are not part of the V1 public projection",
      );
  }
}
