import type {
  ConversationOpenTiming,
  ConversationSnapshot,
  ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";

export type ConversationStoreStatus =
  // subscribe 在途（首连或断档重订阅）。
  | "connecting"
  // 已订阅且帧连续。
  | "live"
  // subscribe 失败，等待 retry()。
  | "error"
  // 已释放（SessionDataLayer 退订后），不再接受任何操作。
  | "closed";

/** optimistic overlay 条目：命令已上行、服务端尚未在投影中确认。 */
export interface OptimisticCommand {
  commandId: string;
  type: string;
  issuedAt: number;
}

export interface ConversationStoreState {
  status: ConversationStoreStatus;
  snapshot: ConversationSnapshot | null;
  subscriptionId: string | null;
  lastError: string | null;
  /** 首次 conversation subscribe 的低频 Host/CLI timing；不进入 snapshot 事实。 */
  openTiming?: ConversationOpenTiming;
  /** Renderer 首帧 timing；与 snapshot 一起通知，避免 UI 读取到半更新的诊断状态。 */
  rendererTiming?: SessionOpenRendererTiming;
  optimisticCommands: readonly OptimisticCommand[];
  /** loadOlder 在途标记（自动预取防重入）。 */
  loadingOlder: boolean;
  /** CLI 完整有效 projection 返回的终态计划目录。 */
  sessionPlans: readonly ToolCallRow[];
  /** 只用于触发计划目录只读 query，不属于 conversation 协议事实。 */
  planDirectoryRevision: number;
  plansLoading: boolean;
  /**
   * 问题导航目录（turn navigator）的失效代际。
   * not-enough-queries 终态过去只以 logEpoch 判定有效，但
   * "是否已有 ≥2 条可导航 query"是随增量变化的派生条件，logEpoch 表示日志代际而非
   * 内容静止。real-user query 增删（row.appended/row.upserted 命中 realUser userInput，
   * 或 row.removed 截断分支）与 snapshot 整体替换时递增此 revision，使终态缓存失效。
   */
  turnNavigatorDirectoryRevision: number;
}

export interface SessionOpenRendererTiming {
  rendererPrepareMs?: number;
  initialFrameTransportMs?: number;
  rendererSnapshotApplyMs?: number;
  snapshotAppliedAt?: number;
}

export const INITIAL_STATE: ConversationStoreState = {
  status: "connecting",
  snapshot: null,
  subscriptionId: null,
  lastError: null,
  rendererTiming: undefined,
  optimisticCommands: [],
  loadingOlder: false,
  sessionPlans: [],
  planDirectoryRevision: 0,
  plansLoading: false,
  turnNavigatorDirectoryRevision: 0,
};

/** 单飞 recovery flight 的可变字段；store 实例是唯一的写入方。 */
export interface RecoveryFlight {
  subscriptionId: string;
  requestInFlight: boolean;
  ackReceived: boolean;
  validFrameSeen: boolean;
  upgradePending: boolean;
  ackMode: "snapshot" | "resume" | null;
  forceSnapshot: boolean;
  postRecoveryGapPending: boolean;
  frameDeadline: ReturnType<typeof setTimeout> | null;
  /** 本次 flight 是为内容确定性失败发起的：终态用 contentRejected，不混进瞬态统计。 */
  contentFault: boolean;
}
