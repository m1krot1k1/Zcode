import type {
  ConversationSharePreflightInput,
  PublishTextConversationInput,
} from "../conversationShare.js";

/**
 * 身份 key 的唯一构造点：workspaceIdentity 优先，缺省退回本地路径。
 *
 * 去重、预检快照、导入索引和队列都用同一规则，避免同一 workspace 在不同调用点
 * 生成不同 key（远程 identity 与本地路径共享同一份状态）。
 */
export function workspaceKeyOf(
  path: string | undefined,
  identity: string | undefined,
): string {
  return (
    identity?.trim() || path?.trim() || "__default_conversation_workspace__"
  );
}

export function importDedupeKey(
  shareCode: string,
  workspaceKey: string,
): string {
  return `${shareCode}\u0000${workspaceKey}`;
}

export function previewPreflightKey(
  input: Pick<
    PublishTextConversationInput | ConversationSharePreflightInput,
    "workspacePath" | "workspaceIdentity" | "remoteSessionId" | "sessionId"
  >,
  productTurnId: string,
): string {
  return [
    workspaceKeyOf(input.workspacePath, input.workspaceIdentity),
    input.remoteSessionId ?? "",
    input.sessionId,
    productTurnId,
  ].join("\u0000");
}
