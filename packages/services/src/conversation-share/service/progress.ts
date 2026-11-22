import { Emitter } from "@zcode/rpc";

import type {
  ConversationShareImportProgress,
  ConversationSharePublishProgress,
} from "../conversationShare.js";

/**
 * 发布与导入进度事件的唯一 owner。
 *
 * emitter 按 operationId 存放，最后一个订阅者离开时自动回收；发布阶段单独记录，
 * 供失败日志标注“卡在哪个阶段”。service 只通过这里发事件，不直接持有 emitter 表。
 */
export class ConversationShareProgressHub {
  private readonly publishEmitters = new Map<
    string,
    Emitter<ConversationSharePublishProgress>
  >();
  private readonly importEmitters = new Map<
    string,
    Emitter<ConversationShareImportProgress>
  >();
  private readonly publishPhases = new Map<
    string,
    ConversationSharePublishProgress["phase"]
  >();

  onPublishProgress(operationId: string) {
    return this.getPublishEmitter(operationId).event;
  }

  onImportProgress(operationId: string) {
    return this.getImportEmitter(operationId).event;
  }

  firePublish(
    operationId: string,
    progress: Omit<ConversationSharePublishProgress, "operationId">,
  ): void {
    this.getPublishEmitter(operationId).fire({ operationId, ...progress });
  }

  fireImport(
    operationId: string,
    progress: Omit<ConversationShareImportProgress, "operationId">,
  ): void {
    this.getImportEmitter(operationId).fire({ operationId, ...progress });
  }

  setPublishPhase(
    operationId: string,
    phase: ConversationSharePublishProgress["phase"],
  ): void {
    this.publishPhases.set(operationId, phase);
  }

  getPublishPhase(
    operationId: string,
  ): ConversationSharePublishProgress["phase"] | undefined {
    return this.publishPhases.get(operationId);
  }

  clearPublishPhase(operationId: string): void {
    this.publishPhases.delete(operationId);
  }

  private getPublishEmitter(
    operationId: string,
  ): Emitter<ConversationSharePublishProgress> {
    const existing = this.publishEmitters.get(operationId);
    if (existing) return existing;
    const emitter = new Emitter<ConversationSharePublishProgress>({
      onDidRemoveLastListener: () => {
        this.publishEmitters.delete(operationId);
        emitter.dispose();
      },
    });
    this.publishEmitters.set(operationId, emitter);
    return emitter;
  }

  private getImportEmitter(
    operationId: string,
  ): Emitter<ConversationShareImportProgress> {
    const existing = this.importEmitters.get(operationId);
    if (existing) return existing;
    const emitter = new Emitter<ConversationShareImportProgress>({
      onDidRemoveLastListener: () => {
        this.importEmitters.delete(operationId);
        emitter.dispose();
      },
    });
    this.importEmitters.set(operationId, emitter);
    return emitter;
  }
}
