import type {
  PendingOwnerCommandRoute,
  PendingSessionMessageDelivery,
  PendingStreamBatch,
  RegisteredRealtimeHost,
  TaskRealtimeBusLogger,
  TaskRunLease,
} from "./types.js";

/**
 * 总线唯一的可变状态所有者。所有模块只通过该对象读写状态，
 * 因此租约、stream batch、命令路由与去重集合不会出现第二条写入路径。
 */
export class TaskRealtimeBusState {
  readonly hosts = new Map<string, RegisteredRealtimeHost>();
  readonly seenEventIds = new Set<string>();
  readonly seenEventOrder: string[] = [];
  readonly leases = new Map<string, TaskRunLease>();
  readonly streamBatches = new Map<string, PendingStreamBatch>();
  readonly pendingOwnerCommands = new Map<string, PendingOwnerCommandRoute>();
  readonly sessionRoutes = new Map<string, string>();
  readonly pendingSessionMessageDeliveries = new Map<string, PendingSessionMessageDelivery>();

  constructor(
    readonly logger: TaskRealtimeBusLogger,
    readonly seenEventLimit: number,
  ) {}
}
