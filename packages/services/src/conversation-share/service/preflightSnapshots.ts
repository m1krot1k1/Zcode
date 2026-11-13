import type {
  ConversationSharePreflightInput,
  PublishTextConversationInput,
} from "../conversationShare.js";
import type { ConversationSharePreviewPreflightSnapshot } from "../conversationShareArtifactDiscovery.js";

import { previewPreflightKey } from "./keys.js";

// 预检快照的兜底上限：单次分享最多写入所选轮次数量的条目，200 足够覆盖正常会话，
// 又能保证长驻 host 不会因为「一直预检、从不发布」而无限增长。
const PREVIEW_PREFLIGHT_SNAPSHOT_MAX_ENTRIES = 200;

type PreviewPreflightInput = Pick<
  PublishTextConversationInput | ConversationSharePreflightInput,
  "workspacePath" | "workspaceIdentity" | "remoteSessionId" | "sessionId"
>;

/**
 * 选择阶段与发布阶段共享的“最终可见卡片”边界快照。
 *
 * desktop host 是长驻进程，生命周期有两道回收：发布终态按 session 前缀清理，
 * 以及写入时的 FIFO 上限兜底（覆盖用户中途放弃分享、永远不发布的路径）。
 */
export class ConversationSharePreviewSnapshots {
  private readonly snapshots = new Map<
    string,
    ConversationSharePreviewPreflightSnapshot
  >();

  /** 写入快照，并在超过上限时按插入序淘汰最旧条目（Map 保持插入序）。 */
  set(key: string, snapshot: ConversationSharePreviewPreflightSnapshot): void {
    // 重新写同一 key 时先删再插，让它回到插入序末尾，淘汰才是真正的「最久未更新」。
    this.snapshots.delete(key);
    this.snapshots.set(key, snapshot);
    while (this.snapshots.size > PREVIEW_PREFLIGHT_SNAPSHOT_MAX_ENTRIES) {
      const oldestKey = this.snapshots.keys().next().value;
      if (oldestKey === undefined) break;
      this.snapshots.delete(oldestKey);
    }
  }

  get(key: string): ConversationSharePreviewPreflightSnapshot | undefined {
    return this.snapshots.get(key);
  }

  delete(key: string): void {
    this.snapshots.delete(key);
  }

  /** 分享结束后回收该 workspace+session 的全部预检快照。 */
  clearBySession(input: PreviewPreflightInput): void {
    const prefix = previewPreflightKey(input, "");
    for (const key of this.snapshots.keys()) {
      if (key.startsWith(prefix)) this.snapshots.delete(key);
    }
  }

  /** 发布时按选中轮次取出快照，不在发布路径上重新扫描整张表。 */
  collect(
    input: PreviewPreflightInput,
    productTurnIds: readonly string[],
  ): Map<string, ConversationSharePreviewPreflightSnapshot> {
    const collected = new Map<
      string,
      ConversationSharePreviewPreflightSnapshot
    >();
    for (const productTurnId of productTurnIds) {
      const snapshot = this.snapshots.get(
        previewPreflightKey(input, productTurnId),
      );
      if (snapshot) collected.set(productTurnId, snapshot);
    }
    return collected;
  }
}
