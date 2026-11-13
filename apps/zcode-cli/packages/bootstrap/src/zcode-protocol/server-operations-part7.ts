
/* eslint-disable max-lines -- ZCode Protocol 的 session/workspace 方法共享同一个 server context 与 snapshot helpers，迁移期先集中维护。 */







import { createMessageId, createPartId, type MessageId, type ModelId, type ModelProviderId, type SessionId, type WorkspaceId } from "@zcode/contracts";
import { type ZCodeSessionCreateParams } from "@zcode/shared";

import { optionalModelSelectionFromString } from "./model-mapper.js";
import { ProtocolRequestError, type ZCodeProtocolAgentServerContext, type ZCodeProtocolSessionRecord } from "./server-types.js";










import { projectIdFromDirectory } from "../app/paths.js";





import {
  slugifyImportedSession,
} from "./server-operations-part1.js";
import {
  removePreviousImportedSessionHistory,
} from "./server-operations-part3.js";


// Часть 7/7 модуля server-operations: вынесено по лимиту строк.

export async function persistImportedSessionHistory(params: {
  context: ZCodeProtocolAgentServerContext;
  record: ZCodeProtocolSessionRecord;
  sessionId: SessionId;
  createParams: ZCodeSessionCreateParams;
}): Promise<void> {
  const importedHistory = params.createParams.importedHistory;
  const sessionStore = params.context.deps.sessionStore;
  if (!importedHistory) return;
  if (!sessionStore) {
    throw new ProtocolRequestError(-32003, "Cannot import session history without session store");
  }

  const workspace = params.record.workspace;
  const workspaceIdentity = workspace.workspaceIdentity?.trim();
  const now = Date.now();
  const createdAt =
    importedHistory.createdAt ??
    (importedHistory.source === "claudeCode"
      ? importedHistory.messages[0]?.timestamp
      : undefined) ??
    now;
  const updatedAt =
    importedHistory.source === "claudeCode"
      ? (importedHistory.updatedAt ?? importedHistory.messages.at(-1)?.timestamp ?? createdAt)
      : createdAt;
  // 历史导入不执行模型；未绑定时保留消息内容，不能要求当前选择或伪造消息来源。
  const currentModel = optionalModelSelectionFromString(params.record.app.getModel());
  const providerId = currentModel?.providerId as ModelProviderId | undefined;
  const modelId = currentModel?.modelId as ModelId | undefined;

  if (importedHistory.source === "sharedContext") {
    if (!sessionStore.commitSharedContextImportBundle) {
      throw new ProtocolRequestError(
        -32003,
        "Shared context import requires atomic session storage",
      );
    }
    const messageId = createMessageId(`${params.sessionId}_shared_context`);
    const importedAt = importedHistory.createdAt ?? now;
    const contextId =
      importedHistory.provenance.contextId ?? `legacy-shared-context-${params.sessionId}`;
    const contextStatus = importedHistory.provenance.status ?? "pending";
    await sessionStore.commitSharedContextImportBundle({
      session: {
        id: params.sessionId,
        projectID: projectIdFromDirectory(workspace.workspacePath),
        workspaceID: workspaceIdentity as WorkspaceId | undefined,
        traceID: params.record.traceContext.traceId,
        slug: slugifyImportedSession(params.sessionId),
        directory: workspace.workspacePath,
        path: workspace.workspacePath,
        title: importedHistory.title,
        titleSource: "custom",
        version: params.context.deps.version ?? "0.0.0",
        permission: { mode: params.record.app.getMode() },
        time: { created: importedAt, updated: importedAt },
      },
      contextMessage: {
        info: {
          id: messageId,
          sessionID: params.sessionId,
          role: "user",
          time: { created: importedAt },
          agent: "zcode-agent",
          // 合并新增分享导入时仍沿用旧 model 字段，既引用了失效变量，也会丢失未绑定语义。
          // 与普通导入共用结构化选择合同；导入不要求模型可执行。
          ...(currentModel ? { modelSelection: currentModel } : {}),
          synthetic: true,
          source: "shared_context",
          visibility: "model-only",
          semantics: {
            origin: "import",
            kind: "shared_context",
            source: "conversation_share",
            uiVisibility: "hidden",
            providerVisibility: "visible",
            transcriptVisibility: "visible",
          },
          metadata: {
            shareId: importedHistory.provenance.shareId,
            contextId,
            sharedContextStatus: contextStatus,
          },
        },
        parts: [
          {
            id: createPartId(`${params.sessionId}_shared_context_text`),
            sessionID: params.sessionId,
            messageID: messageId,
            type: "text",
            text: importedHistory.markdown,
            time: { start: importedAt, end: importedAt },
            metadata: { sharedContext: true },
          },
        ],
      },
      provenance: {
        // session_entry.id 是全库主键（同类修复见 sqlite-session-store.ts
        // 的 fork command fact），旧模板只含 shareId。同一个 share 导入到第二个
        // workspace 时按 (shareCode, workspaceKey) 的去重不命中、marker 也各在自己
        // workspace 下不冲突，saveSessionEntry 的 on conflict(id) 就把第一个会话的
        // provenance 改绑到新会话，旧会话的 shared context 记录静默消失。
        // 校验：所有读取都走 (session_id, type) + data.contextId，没有一处按 id 反查，
        // 因此新旧 id 共存安全，不需要数据迁移。
        id: `v4_shared_context_import:${params.sessionId}:${importedHistory.provenance.shareId}`,
        sessionID: params.sessionId,
        type: "v4/shared_context_import",
        time: { created: importedAt, updated: importedAt },
        data: {
          ...importedHistory.provenance,
          contextId,
          status: contextStatus,
        },
      },
    });
    return;
  }

  await sessionStore.createSession({
    id: params.sessionId,
    projectID: projectIdFromDirectory(workspace.workspacePath),
    // 导入会话创建后会立即 resume；必须先落盘当前 identity，避免恢复时退化为路径隔离。
    workspaceID: workspaceIdentity as WorkspaceId | undefined,
    traceID: params.record.traceContext.traceId,
    slug: slugifyImportedSession(params.sessionId),
    directory: workspace.workspacePath,
    path: workspace.workspacePath,
    title: importedHistory.title?.trim() || "Imported session",
    titleSource: "custom",
    version: params.context.deps.version ?? "0.0.0",
    permission: {
      mode: params.record.app.getMode(),
    },
    time: {
      created: createdAt,
      updated: Math.max(createdAt, updatedAt),
    },
  });

  const removedMessageCount = await removePreviousImportedSessionHistory({
    sessionStore,
    sessionId: params.sessionId,
    source: importedHistory.source,
  });
  let lastUserMessageId: MessageId | undefined;
  let lastImportedMessageTimestamp = createdAt - 1;
  for (const [index, message] of importedHistory.messages.entries()) {
    const rawTimestamp = message.timestamp ?? createdAt + index;

    // sessionStore 按 time_created 排序读取消息，如果 assistant 时间早于 user，
    // UI 会把导入会话显示成 assistant 在上、user 在下。导入边界以数组顺序为准，
    // 只在写库前把时间戳收敛为单调递增，保留消息内容和角色不变。
    const timestamp =
      rawTimestamp > lastImportedMessageTimestamp ? rawTimestamp : lastImportedMessageTimestamp + 1;
    lastImportedMessageTimestamp = timestamp;
    const messageId = createMessageId(`${params.sessionId}_import_${index}`);
    if (message.role === "user") {
      lastUserMessageId = messageId;
      await sessionStore.saveMessage({
        id: messageId,
        sessionID: params.sessionId,
        role: "user",
        time: { created: timestamp },
        agent: "zcode-agent",
        ...(currentModel ? { modelSelection: currentModel } : {}),
        metadata: { migrationSource: importedHistory.source },
      });
    } else {
      await sessionStore.saveMessage({
        id: messageId,
        sessionID: params.sessionId,
        role: "assistant",
        time: { created: timestamp, completed: timestamp },
        parentID:
          lastUserMessageId ?? createMessageId(`${params.sessionId}_import_parent_${index}`),
        ...(currentModel ? { modelId, providerId } : {}),
        mode: params.record.app.getMode(),
        agent: "zcode-agent",
        path: {
          cwd: workspace.workspacePath,
          root: workspace.workspacePath,
        },
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        finish: "stop",
      });
    }
    await sessionStore.savePart({
      id: createPartId(`${params.sessionId}_import_${index}_text`),
      sessionID: params.sessionId,
      messageID: messageId,
      type: "text",
      text: message.content,
      time: { start: timestamp, end: timestamp },
      metadata: { migrationSource: importedHistory.source },
    });
  }

  params.context.logger?.info("ZCode Protocol imported history persisted", {
    event: "zcode_protocol.session_import.persisted",
    messageCount: importedHistory.messages.length,
    module: "bootstrap.zcode_protocol",
    removedMessageCount,
    sessionId: params.sessionId,
    source: importedHistory.source,
    workspaceKey: workspace.workspaceKey,
    workspacePath: workspace.workspacePath,
  });
}
