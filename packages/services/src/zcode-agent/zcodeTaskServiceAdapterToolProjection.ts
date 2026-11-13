/**
 * zcodeTaskServiceAdapterToolProjection.ts: Live-проекция инструментов и слияние незавершённых tool-вызовов в snapshot.
 */
import type {
  CoreHelpers,
  LiveToolProjection,
  TaskAdapterState,
  TaskTarget,
} from "./zcodeTaskServiceAdapterCore.js";
import type {
  ZCodePersistedMessage,
  ZCodePersistedMessagePart,
  ZCodePersistedToolCall,
  ZCodeStreamEvent,
  ZCodeTaskMeta,
} from "@zcode/shared";
import { logger } from "./zcodeTaskServiceAdapterCore.js";
import { asRecord, stringValue } from "./zcodeTaskServiceAdapterRuntimePayloads.js";

const MAX_LIVE_TOOL_PROJECTION_TASKS = 128;
const MAX_LIVE_TOOL_PROJECTION_TOOLS_PER_TASK = 2000;

export type ToolProjectionHelpers = ReturnType<typeof createToolProjectionHelpers>;

export function createToolProjectionHelpers(
  deps: Pick<TaskAdapterState, "liveToolProjectionsByTaskKey"> & Pick<CoreHelpers, "taskKey">,
) {
  const { liveToolProjectionsByTaskKey, taskKey } = deps;
  let liveToolProjectionOrder = 0;

  function getLiveToolProjectionMap(params: TaskTarget): Map<string, LiveToolProjection> {
    const key = taskKey(params);
    let projection = liveToolProjectionsByTaskKey.get(key);
    if (!projection) {
      projection = new Map<string, LiveToolProjection>();
      liveToolProjectionsByTaskKey.set(key, projection);
      while (liveToolProjectionsByTaskKey.size > MAX_LIVE_TOOL_PROJECTION_TASKS) {
        const oldestKey = liveToolProjectionsByTaskKey.keys().next().value;
        if (typeof oldestKey !== "string") break;
        liveToolProjectionsByTaskKey.delete(oldestKey);
      }
    }
    return projection;
  }

  function trimLiveToolProjectionMap(projection: Map<string, LiveToolProjection>): void {
    while (projection.size > MAX_LIVE_TOOL_PROJECTION_TOOLS_PER_TASK) {
      let oldestKey: string | undefined;
      let oldestOrder = Number.POSITIVE_INFINITY;
      for (const [toolId, item] of projection) {
        if (item.order < oldestOrder) {
          oldestOrder = item.order;
          oldestKey = toolId;
        }
      }
      if (!oldestKey) return;
      projection.delete(oldestKey);
    }
  }

  function clearLiveToolProjection(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): void {
    liveToolProjectionsByTaskKey.delete(taskKey(params));
  }

  function normalizeLiveToolRaw(
    raw: unknown,
    toolId: string,
    parentToolUseId: string | null | undefined,
  ): unknown {
    const rawRecord = asRecord(raw);
    const rawBase =
      Object.keys(rawRecord).length > 0 ? rawRecord : raw === undefined ? {} : { raw };
    const parentFromRaw =
      stringValue(rawRecord.parentToolUseId) ??
      stringValue(rawRecord.parentToolCallId) ??
      parentToolUseId ??
      null;
    return {
      ...rawBase,
      toolCallId: stringValue(rawRecord.toolCallId) ?? toolId,
      ...(parentFromRaw
        ? {
            parentToolCallId: stringValue(rawRecord.parentToolCallId) ?? parentFromRaw,
          }
        : {}),
    };
  }

  function persistedStatusFromToolUpdate(
    status: Extract<ZCodeStreamEvent, { type: "tool_call_update" }>["status"],
  ): ZCodePersistedToolCall["status"] | undefined {
    return status === "completed" ||
      status === "failed" ||
      status === "denied" ||
      status === "stopped"
      ? status
      : undefined;
  }

  function rememberLiveToolProjection(params: TaskTarget, event: ZCodeStreamEvent): void {
    if (event.type !== "tool_call" && event.type !== "tool_call_update") {
      return;
    }

    const projection = getLiveToolProjectionMap(params);
    const existing = projection.get(event.toolId);
    const parentToolUseId = event.parentToolUseId ?? existing?.parentToolUseId ?? null;
    const raw = normalizeLiveToolRaw(event.raw, event.toolId, parentToolUseId);
    const nextTool: ZCodePersistedToolCall =
      event.type === "tool_call"
        ? {
            ...existing?.tool,
            toolName: event.toolName ?? existing?.tool.toolName,
            title: event.title ?? existing?.tool.title ?? event.toolName,
            kind: event.kind ?? existing?.tool.kind ?? event.toolName,
            input: event.input,
            raw,
          }
        : {
            ...existing?.tool,
            toolName: event.toolName ?? existing?.tool.toolName,
            title: event.title ?? existing?.tool.title ?? event.toolName ?? event.kind,
            kind: event.kind ?? existing?.tool.kind ?? event.toolName ?? existing?.tool.toolName,
            input: event.input !== undefined ? event.input : existing?.tool.input,
            output: event.content !== undefined ? event.content : existing?.tool.output,
            error: event.error ?? existing?.tool.error,
            raw,
            status: persistedStatusFromToolUpdate(event.status) ?? existing?.tool.status,
          };
    projection.set(event.toolId, {
      order: existing?.order ?? ++liveToolProjectionOrder,
      parentToolUseId,
      tool: nextTool,
      toolId: event.toolId,
    });
    trimLiveToolProjectionMap(projection);
  }

  function persistedToolId(tool: ZCodePersistedToolCall): string | undefined {
    return stringValue(asRecord(tool.raw).toolCallId);
  }

  function mergeToolRaw(snapshotRaw: unknown, liveRaw: unknown): unknown {
    const snapshotRecord = asRecord(snapshotRaw);
    const liveRecord = asRecord(liveRaw);
    if (Object.keys(snapshotRecord).length === 0) {
      return liveRaw;
    }
    if (Object.keys(liveRecord).length === 0) {
      return snapshotRaw;
    }
    return {
      ...liveRecord,
      ...snapshotRecord,
      parentToolCallId:
        stringValue(snapshotRecord.parentToolCallId) ?? stringValue(liveRecord.parentToolCallId),
      toolCallId: stringValue(snapshotRecord.toolCallId) ?? stringValue(liveRecord.toolCallId),
    };
  }

  function mergePersistedToolCall(
    snapshotTool: ZCodePersistedToolCall | undefined,
    liveTool: ZCodePersistedToolCall,
  ): ZCodePersistedToolCall {
    if (!snapshotTool) {
      return liveTool;
    }
    return {
      ...liveTool,
      ...snapshotTool,
      // 终态 snapshot 来自父 session message parts，可能没有 live mirror 的
      // subagent parentToolCallId/raw/output。这里把 snapshot 作为终态事实源，同时保留
      // live 协议事件已经提供的父子归属和大字段，避免 task_complete 后工具树被覆盖丢失。
      input: snapshotTool.input ?? liveTool.input,
      output: snapshotTool.output ?? liveTool.output,
      raw: mergeToolRaw(snapshotTool.raw, liveTool.raw),
      error: snapshotTool.error ?? liveTool.error,
      status: snapshotTool.status ?? liveTool.status,
      snapshotRefs: snapshotTool.snapshotRefs ?? liveTool.snapshotRefs,
    };
  }

  function findToolLocation(
    messages: readonly ZCodePersistedMessage[],
    toolId: string,
  ): { messageIndex: number; toolIndex: number } | null {
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      const message = messages[messageIndex];
      if (!message?.tools) continue;
      const toolIndex = message.tools.findIndex((tool) => persistedToolId(tool) === toolId);
      if (toolIndex >= 0) {
        return { messageIndex, toolIndex };
      }
    }
    return null;
  }

  function latestAssistantMessageIndex(messages: readonly ZCodePersistedMessage[]): number {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "assistant") {
        return index;
      }
    }
    return -1;
  }

  function upsertPersistedToolPart(
    parts: readonly ZCodePersistedMessagePart[] | undefined,
    toolIndex: number,
  ): ZCodePersistedMessagePart[] {
    if (parts?.some((part) => part.type === "tool-call" && part.toolIndex === toolIndex)) {
      return [...parts];
    }
    return [...(parts ?? []), { type: "tool-call", toolIndex }];
  }

  function updateSnapshotMessageTool(
    message: ZCodePersistedMessage,
    toolIndex: number,
    tool: ZCodePersistedToolCall,
  ): ZCodePersistedMessage {
    const tools = [...(message.tools ?? [])];
    tools[toolIndex] = mergePersistedToolCall(tools[toolIndex], tool);
    return {
      ...message,
      tools,
      parts:
        message.role === "assistant"
          ? upsertPersistedToolPart(message.parts, toolIndex)
          : message.parts,
    };
  }

  function appendSnapshotMessageTool(
    message: ZCodePersistedMessage,
    tool: ZCodePersistedToolCall,
  ): ZCodePersistedMessage {
    const tools = [...(message.tools ?? []), tool];
    const toolIndex = tools.length - 1;
    return {
      ...message,
      tools,
      parts:
        message.role === "assistant"
          ? upsertPersistedToolPart(message.parts, toolIndex)
          : message.parts,
    };
  }

  function mergeLiveToolProjectionIntoSnapshotMessages(
    meta: ZCodeTaskMeta,
    messages: ZCodePersistedMessage[],
  ): ZCodePersistedMessage[] {
    const projection = liveToolProjectionsByTaskKey.get(taskKey(meta));
    if (!projection || projection.size === 0 || messages.length === 0) {
      return messages;
    }

    let nextMessages = messages;
    let changed = false;
    let mergedToolCount = 0;
    const liveTools = [...projection.values()].sort((a, b) => a.order - b.order);
    for (const liveTool of liveTools) {
      const existingLocation = findToolLocation(nextMessages, liveTool.toolId);
      if (existingLocation) {
        nextMessages = nextMessages.map((message, index) =>
          index === existingLocation.messageIndex
            ? updateSnapshotMessageTool(message, existingLocation.toolIndex, liveTool.tool)
            : message,
        );
        changed = true;
        mergedToolCount += 1;
        continue;
      }

      const parentLocation = liveTool.parentToolUseId
        ? findToolLocation(nextMessages, liveTool.parentToolUseId)
        : null;
      const targetMessageIndex =
        parentLocation?.messageIndex ?? latestAssistantMessageIndex(nextMessages);
      if (targetMessageIndex < 0) {
        continue;
      }

      nextMessages = nextMessages.map((message, index) =>
        index === targetMessageIndex ? appendSnapshotMessageTool(message, liveTool.tool) : message,
      );
      changed = true;
      mergedToolCount += 1;
    }

    if (changed) {
      logger.debug(undefined, "ZCode snapshot 合并 live tool projection", {
        event: "zcode_task.snapshot.live_tool_projection.merged",
        liveToolCount: liveTools.length,
        mergedToolCount,
        taskId: meta.taskId,
        workspaceIdentity: meta.workspaceIdentity,
        workspacePath: meta.workspacePath,
      });
    }
    return changed ? nextMessages : messages;
  }

  return {
    getLiveToolProjectionMap,
    trimLiveToolProjectionMap,
    clearLiveToolProjection,
    normalizeLiveToolRaw,
    persistedStatusFromToolUpdate,
    rememberLiveToolProjection,
    persistedToolId,
    mergeToolRaw,
    mergePersistedToolCall,
    findToolLocation,
    latestAssistantMessageIndex,
    upsertPersistedToolPart,
    updateSnapshotMessageTool,
    appendSnapshotMessageTool,
    mergeLiveToolProjectionIntoSnapshotMessages,
  };
}
