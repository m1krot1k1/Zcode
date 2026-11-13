// V4 connection-scoped service facade 的共享类型与限额。
import type { Emitter, IDisposable } from "@zcode/rpc";
import type {
  ConversationTopicWireCandidate,
  SessionsIndexTopicWireCandidate,
  WorkspaceConfigTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeAgentWorkspaceTarget } from "../zcodeAgent.js";

export type ZCodeAgentV4ClientMode = "desktop-continuous" | "web-remote-replayable";

export interface ZCodeAgentV4ConnectionContext {
  connectionId: string;
  clientMode: ZCodeAgentV4ClientMode;
  role?: "terminal-client" | "trusted-host-relay";
  /**
   * 这条连接的 clientHello 声明了认得 `workflowRun.*` 键级增量。与 `clientMode` 同族：
   * 由本 facade 从握手事实写出，订阅入参里的同名字段一律被清掉——一个客户端认不认得增量
   * 是**连接**的事实，不是某一次订阅可以自选的口味。缺席 = 按旧消费者处理。
   */
  workflowRunDeltas?: boolean;
  historyFirst?: boolean;
}

export interface TrustedZCodeAgentV4UnsubscribeRoute {
  topic: string;
  connectionId: string;
}

export type SubscriptionKind = "conversation" | "sessions-index" | "workspace-config";

export interface OwnedSubscription {
  kind: SubscriptionKind;
  ownershipKey: string;
  subscriptionId: string;
  topic: string;
  connectionId: string;
  clientMode: ZCodeAgentV4ClientMode;
  target: ZCodeAgentWorkspaceTarget;
}

export interface ConnectionFlowRoute {
  key: string;
  target: ZCodeAgentWorkspaceTarget;
  connection: ZCodeAgentV4ConnectionContext;
}

export type RoutedTopicFrame =
  | ConversationTopicWireCandidate
  | SessionsIndexTopicWireCandidate
  | WorkspaceConfigTopicWireCandidate;

export interface PendingOwnership {
  kind: SubscriptionKind;
  target: ZCodeAgentWorkspaceTarget;
  topic: string;
  frames: RoutedTopicFrame[];
  stagedBytes: number;
  overflowReason: string | null;
  runtimeGeneration: number;
  invalidatedByRuntimeRestart: boolean;
}

export interface RoutedFrameEvent {
  emitter: Emitter<RoutedTopicFrame>;
  upstream: IDisposable;
}

// ACK 窗口只覆盖控制面竞态，不替代 subscriber buffer/resync。这里按帧数和
// JSON 字节双限额暂存，避免异常 peer 在 subscribe pending 期间无限占用 host 内存。
export const MAX_PENDING_OWNERSHIP_FRAMES = 1_024;
export const MAX_PENDING_OWNERSHIP_BYTES = 32 * 1024 * 1024;
export const MAX_DOWNSTREAM_CONNECTION_ID_LENGTH = 256;
