// SessionPane 拆分：队列项「撤回编辑」的 Composer 恢复目标解析。
import type { ComposerRestoreRequest } from "@/v4/ConversationComposer.js";
import { v4QueuedCommandText } from "@/v4/slashCommands.js";
import type {
  AttachmentRef,
  CommandAck,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import { isHighspeedProviderId } from "@zcode/shared";

export interface QueuedComposerRestoreTarget {
  baseRevision: number;
  queueItemId: string;
  sourceCommandId: string;
  inputKind: "sendText" | "sendGoalCommand";
  text: string;
  attachments: readonly AttachmentRef[];
  config?: ComposerRestoreRequest["config"];
}

export function resolveQueuedComposerRestore(
  snapshot: ConversationSnapshot,
  queueItemId: string,
): QueuedComposerRestoreTarget | null {
  const item = snapshot.queue.items.find((candidate) => candidate.queueItemId === queueItemId);
  if (!item || item.kind === "compact") return null;
  const restoresModelSelection =
    item.modelSelection !== undefined &&
    // Bug 根因：旧版本曾把单轮 Highspeed Provider 持久化进队列；撤回编辑若恢复它，
    // Composer 与下一轮 fallback 都会被污染。新队列保存普通模型，这里只兼容旧快照。
    // 旧版本的污染重发可能留下不带卡元数据的此类项，所以只按 Provider Family 判断，
    // 与 CLI 提升迁移保持一致。
    !isHighspeedProviderId(item.modelSelection.providerId);
  const config = {
    ...(item.mode ? { mode: item.mode } : {}),
    ...(typeof item.planEnabled === "boolean" ? { planEnabled: item.planEnabled } : {}),
    ...(restoresModelSelection ? { modelSelection: item.modelSelection } : {}),
  };
  return {
    baseRevision: snapshot.revision,
    queueItemId,
    sourceCommandId: item.sourceCommandId,
    inputKind: item.kind,
    text: v4QueuedCommandText(item.kind, item.text),
    attachments: item.attachments.map((attachment) => ({ ...attachment })),
    ...(Object.keys(config).length > 0 ? { config } : {}),
  };
}

export function shouldRestoreQueuedComposerFromAck(status: CommandAck["status"]): boolean {
  return status === "accepted" || status === "duplicate";
}
