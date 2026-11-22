import type {
  ConversationShareContinuation,
  ConversationSharePreview,
  ConversationShareRecord,
} from "@zcode/shared";

import type {
  ConversationSharePreflightInput,
  ConversationSharePreflightResult,
  IConversationShareService,
  ImportConversationShareInput,
  ImportConversationShareResult,
  ImportedConversationShare,
  PublishTextConversationInput,
} from "./conversationShare.js";
import {
  cleanupAbandonedImports,
  getImportedConversation,
  importShare,
} from "./service/importing.js";
import { preflightShare } from "./service/preflight.js";
import { publishShare, publishShareWithAgent } from "./service/publishing.js";
import {
  conversationShareConnectionScopeFactory,
  createConversationShareRuntime,
  type ConversationShareAgentService,
  type ConversationShareServiceOptions,
  type ConversationShareServiceRuntime,
} from "./service/runtime.js";

export { conversationShareConnectionScopeFactory };
export type { ConversationShareServiceOptions };

/**
 * 会话分享的对外服务：只做装配与委托，不再承载领域流程。
 *
 * 领域模块（同一 service/ 目录）：
 * - preflight：行读取后的结构降级、附件/预览候选统计与预检结果；
 * - shareRows：行选择、结构校验与公开投影前的 sanitize 规则；
 * - projection：artifact 清单校验、公开投影与 confirm DTO 组装；
 * - http：上传回执核对与安全检查轮询；
 * - publishing / importing：发布与导入的 attempt 生命周期；
 * - artifacts：单 artifact 下载、落盘文件名与目录名净化；
 * - runtime / keys / progress / preflightSnapshots / importIndex：共享依赖与状态 owner。
 *
 * 所有状态仍由本实例持有的 runtime 管理：预检快照、进度 emitter 与导入索引各自
 * 只有一个 owner，领域函数只读取或通过 owner 的方法写入。
 */
export class ConversationShareService implements IConversationShareService {
  private readonly runtime: ConversationShareServiceRuntime;

  constructor(options: ConversationShareServiceOptions) {
    this.runtime = createConversationShareRuntime(options);
    if (this.runtime.zcodeSessionService) {
      void cleanupAbandonedImports(this.runtime).catch(() => undefined);
    }
  }

  getCapabilities() {
    return this.runtime.client.getCapabilities();
  }

  async preflight(
    input: ConversationSharePreflightInput,
  ): Promise<ConversationSharePreflightResult> {
    return preflightShare(this.runtime, input, this.runtime.zcodeAgentService);
  }

  getPreview(shareCode: string): Promise<ConversationSharePreview> {
    return this.runtime.client.getPreview(shareCode);
  }

  getContinuation(input: {
    shareCode: string;
    clientRequestId: string;
  }): Promise<ConversationShareContinuation> {
    return this.runtime.client.getContinuation(input.shareCode, {
      schema_version: 1,
      client_request_id: input.clientRequestId,
    });
  }

  /** Host attachment 内部 facade：复用同一业务 service，只替换 V4 Rows/File 查询的可信 Agent scope。 */
  [conversationShareConnectionScopeFactory](
    agentService: ConversationShareAgentService,
  ): IConversationShareService {
    return {
      getCapabilities: () => this.getCapabilities(),
      preflight: (input) => preflightShare(this.runtime, input, agentService),
      publish: (input, operationId) =>
        publishShareWithAgent(this.runtime, input, operationId, agentService),
      onDynamicPublishProgress: (operationId) =>
        this.onDynamicPublishProgress(operationId),
      importShare: (input, operationId) => this.importShare(input, operationId),
      onDynamicImportProgress: (operationId) =>
        this.onDynamicImportProgress(operationId),
      getImportedConversation: (input) => this.getImportedConversation(input),
      getPreview: (shareCode) => this.getPreview(shareCode),
      getContinuation: (input) => this.getContinuation(input),
    };
  }

  onDynamicPublishProgress(operationId: string) {
    return this.runtime.progress.onPublishProgress(operationId);
  }

  onDynamicImportProgress(operationId: string) {
    return this.runtime.progress.onImportProgress(operationId);
  }

  async importShare(
    input: ImportConversationShareInput,
    operationId: string,
  ): Promise<ImportConversationShareResult> {
    return importShare(this.runtime, input, operationId);
  }

  async getImportedConversation(input: {
    workspacePath: string;
    contextId: string;
  }): Promise<ImportedConversationShare | null> {
    return getImportedConversation(this.runtime, input);
  }

  async publish(
    input: PublishTextConversationInput,
    operationId: string,
  ): Promise<ConversationShareRecord> {
    return publishShare(this.runtime, input, operationId);
  }
}
