import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

import { throwProjectionError } from "./errors.js";

const ACTIVE_TOOL_STATUSES = new Set(["inputStreaming", "pendingApproval", "running"]);

export function visitStrings(value: unknown, visitor: (value: string) => void): void {
  if (typeof value === "string") {
    visitor(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) visitStrings(entry, visitor);
    return;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      visitStrings(entry, visitor);
    }
  }
}

export function assertSafeString(value: string): void {
  if (/^zcode-artifact:\/\//iu.test(value)) {
    throwProjectionError(
      "artifact_protocol_not_ready",
      "Artifact references must be represented by formal conversation artifact rows",
    );
  }
  if (/^(?:data|file):/iu.test(value)) {
    throwProjectionError("unsafe_structure", "Local and inline URLs cannot be shared");
  }
}

export function isPublicArtifactRef(value: string): boolean {
  return /^zcode-artifact:\/\/share\/[A-Za-z0-9._~-]+$/u.test(value);
}

export function assertTerminalAndSafe(rows: ConversationRow[]): void {
  for (const row of rows) {
    if (row.productTurnId === undefined) {
      throwProjectionError(
        "invalid_conversation",
        "Conversation row is missing its product turn identity",
      );
    }
    if (row.kind === "turnHeader" && row.state === "running") {
      throwProjectionError("invalid_conversation", "Running turns cannot be shared", {
        rowKind: row.kind,
        rowId: row.rowId,
      });
    }
    if ((row.kind === "assistantText" || row.kind === "reasoning") && row.state === "streaming") {
      throwProjectionError("invalid_conversation", "Streaming rows cannot be shared", {
        rowKind: row.kind,
        rowId: row.rowId,
      });
    }
    if (row.kind === "toolCall" && ACTIVE_TOOL_STATUSES.has(row.status)) {
      throwProjectionError("invalid_conversation", "Active tool calls cannot be shared", {
        rowKind: row.kind,
        rowId: row.rowId,
      });
    }
    if (row.kind === "subagent" && row.status === "running") {
      throwProjectionError("invalid_conversation", "Active subagents cannot be shared", {
        rowKind: row.kind,
        rowId: row.rowId,
      });
    }
    if (
      row.kind === "externalAgentRun" &&
      (row.status === "starting" || row.status === "running")
    ) {
      throwProjectionError("invalid_conversation", "Active external agent runs cannot be shared", {
        rowKind: row.kind,
        rowId: row.rowId,
      });
    }
    if (
      row.kind === "timelineMarker" &&
      ((row.marker.type === "compact" && row.marker.status === "running") ||
        (row.marker.type === "goalVerify" && row.marker.outcome === "running"))
    ) {
      throwProjectionError("invalid_conversation", "Active timeline operations cannot be shared");
    }
    if (row.kind === "toolCall") {
      if (row.display?.kind === "node_repl_images") {
        throwProjectionError("unsafe_structure", "Inline tool images cannot be shared", {
          rowKind: row.kind,
          rowId: row.rowId,
        });
      }
    }
    if (row.kind === "timelineMarker") {
      if (
        row.marker.type === "forkNotice" ||
        row.marker.type === "forkCreated" ||
        row.marker.type === "checkpointRestored"
      ) {
        throwProjectionError(
          "invalid_conversation",
          "Timeline references outside the shared projection are not supported",
        );
      }
      if (row.marker.type === "compact" && row.marker.summaryRef !== undefined) {
        throwProjectionError(
          "artifact_protocol_not_ready",
          "Conversation summary references require the artifact row protocol",
        );
      }
    }
    // artifact.ref 是 Host 内部授权的读取引用，公开投影会替换；它不能参与通用 URL 泄漏检查。
    if (row.kind === "artifact") {
      const { ref: _localRef, ...safeFields } = row;
      visitStrings(safeFields, assertSafeString);
    } else if (row.kind === "toolCall" && row.output) {
      // truncated.ref 只用于本地按需读取大工具输出，公开投影本来就只保留 output.text；
      // 对不会出现在请求里的内部 ref 做安全校验会误阻断同一轮正式结果物上传。
      visitStrings({ ...row, output: { text: row.output.text } }, assertSafeString);
    } else if (row.kind === "userInput") {
      const { attachments: _attachments, ...safeFields } = row;
      visitStrings(safeFields, assertSafeString);
    } else {
      visitStrings(row, assertSafeString);
    }
  }
}
