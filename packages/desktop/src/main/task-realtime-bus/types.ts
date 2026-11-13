import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import type {
  TaskRealtimeHostDeliveryKind,
  TaskStreamMirrorBatchEvent,
  TaskStreamMirrorPublishOp,
} from "@zcode/shared";

export const STREAM_MIRROR_FLUSH_INTERVAL_MS = 1000;
export const STREAM_MIRROR_MAX_REPLAY_BATCHES = 60;
export const STREAM_MIRROR_MAX_REPLAY_BYTES = 512 * 1024;
export const STREAM_MIRROR_MAX_BATCH_BYTES = 512 * 1024;
export const STREAM_MIRROR_TEXT_OP_MAX_CHARS = 128 * 1024;
export const OWNER_COMMAND_TIMEOUT_MS = 30_000;
export const SESSION_MESSAGE_DELIVERY_TIMEOUT_MS = 30_000;

export type HostMessageListener = (message: unknown) => void;
export type HostExitListener = () => void;

export interface RegisteredRealtimeHost {
  hostId: string;
  windowId: number;
  child: ElectronUtilityProcess;
  workspaceKeys: Set<string>;
  deliveryKind: TaskRealtimeHostDeliveryKind;
  onMessage: HostMessageListener;
  onExit: HostExitListener;
}

export interface TaskRunLease {
  key: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  runId: string;
  traceId: string;
  ownerClientId?: string;
  ownerDeviceLabel?: string;
  ownerHostId: string;
  acquiredAt: number;
  updatedAt: number;
}

export interface PendingStreamBatch {
  batchKey: string;
  workspaceKey: string;
  taskId: string;
  runId: string;
  traceId: string;
  ownerClientId?: string;
  ownerDeviceLabel?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  ownerHostId: string;
  nextBatchSeq: number;
  nextOpSeq: number;
  pendingOps: TaskStreamMirrorPublishOp[];
  replay: TaskStreamMirrorBatchEvent[];
  replayUnavailable: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  replayInitializedHostIds: Set<string>;
}

export interface PendingOwnerCommandRoute {
  commandRequestId: string;
  requesterHostId: string;
  ownerHostId: string;
  createdAt: number;
  timeout: ReturnType<typeof setTimeout>;
}

export interface SessionMessageRequest {
  content: string;
  createdAt: string;
  fromSessionId: string;
  messageId: string;
  requestId: string;
  toSessionId: string;
}

export interface SessionMessageDeliveryResult {
  error?: string;
  messageId: string;
  requestId: string;
  sessionId: string;
  status: "success" | "failed";
}

export interface PendingSessionMessageDelivery {
  request: SessionMessageRequest;
  sourceHostId: string;
  targetHostId: string;
  timeout: ReturnType<typeof setTimeout>;
}

export interface TaskRealtimeBusLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export interface TaskRealtimeBusOptions {
  logger?: TaskRealtimeBusLogger;
  seenEventLimit?: number;
}
