import {
  type ConversationRow,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";

/**
 * runtime 换代打断 subscribe 后的退避节奏。
 *
 * CUA Helper 冷启动就绪会 recycleUntilStable → disposeWorkspace 回收 agent
 * runtime，在途 subscribe 被 rejectAll 打断。若把这次瞬态失败定格成 status="error"，
 * 懒启动的 agent 在 dispose 后可能无人拉起，onRuntimeRestart 就不会到达，面板只能靠用户
 * 手点「重新连接」。subscribeConversationV4 走 start-if-needed，重订阅自身会拉起 runtime，
 * 所以这里按 sessionsIndexStore 的既定模式做有界退避。
 */
export const RUNTIME_RECYCLE_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;

/**
 * accepted ACK 后等待权威输入投影的宽限期。
 *
 * Core admission 的 ACK 不等待 TurnStarted/QueueItem/userInput 投影；正常情况下这两条
 * 路径只相差一个 renderer/network round-trip。把窗口设为 2s 可以覆盖正常 desktop/mobile
 * 延迟，又能尽快从“CLI 继续工作、订阅完全静默”的半开通道自愈。超时只恢复订阅，不重放命令。
 */
export const ACCEPTED_INPUT_PROJECTION_GRACE_MS = 2_000;
const ACCEPTED_INPUT_COMMAND_TYPES = new Set(["sendText", "editUserQuery"]);

export function requiresAcceptedInputProjection(type: string): boolean {
  return ACCEPTED_INPUT_COMMAND_TYPES.has(type);
}

/** 退避耗尽时展示给用户的 lastError（无底层 error 对象可引用的换代路径）。 */
export const RUNTIME_RECYCLED_ERROR = "ZCode agent runtime 已被回收，重连未成功";

export function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function roundedDuration(startedAt: number, endedAt: number): number {
  return Math.max(0, Math.round(endedAt - startedAt));
}

/**
 * 是否为 runtime 换代/回收导致的瞬态 subscribe 失败。
 *
 * 已知文案都来自同一次回收：transport 关闭时 ZCodeProtocolClient.rejectAll 打断在途请求
 * （transport closed），复用已回收 client 时 assertNotDisposed 早退（client disposed），
 * 以及 runtime 尚未重新拉起时的 fail-fast（runtime is not running）。
 */
export function isRuntimeRecycleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    // 冷订阅可能亲自拉起新 runtime；restart 令在途 ACK 失效后仍须有界重订，不能停在 error。
    message.includes("fault.subscription.runtimeRestarted") ||
    message.includes("ZCode agent transport closed") ||
    message.includes("ZCode Protocol client disposed") ||
    message.includes("ZCode Protocol client is disposed") ||
    message.includes("ZCode Agent runtime is not running")
  );
}

export function hasAcceptedInputProjection(
  snapshot: ConversationSnapshot | null,
  commandId: string,
): boolean {
  if (!snapshot) return false;
  if (snapshot.queue.items.some((item) => item.sourceCommandId === commandId)) return true;
  return snapshot.rows.window.some(
    (row) =>
      row.kind === "userInput" && row.origin === "realUser" && row.sourceCommandId === commandId,
  );
}

const TERMINAL_PLAN_STATUSES: ReadonlySet<ToolCallRow["status"]> = new Set([
  "success",
  "error",
  "cancelled",
]);

export function shouldInvalidatePlanDirectory(frame: ConversationTopicFrame): boolean {
  if (frame.payload.kind === "snapshot") return true;
  return frame.payload.deltas.some((delta) => {
    if (delta.op === "row.removed") return true;
    if (delta.op !== "row.appended" && delta.op !== "row.upserted") return false;
    const row = delta.row;
    return (
      row.kind === "toolCall" &&
      row.toolName === "ExitPlanMode" &&
      TERMINAL_PLAN_STATUSES.has(row.status)
    );
  });
}

/**
 * 问题导航目录是否需要失效。
 * not-enough-queries 终态曾只以 logEpoch 判定，导致同一 epoch
 * 内追加 real-user query 后永久命中缓存。判定条件：
 * - snapshot 整体替换 → true（全新状态，终态作废）；
 * - row.removed → true（rewind/分支裁剪改变可导航 query 集合）；
 * - row.appended/row.upserted 命中 realUser userInput → true（新增/变更用户问题）；
 * - 其余 delta（assistant text、tool、reasoning 流式）→ false，不触发重探测。
 */
export function shouldInvalidateTurnNavigatorDirectory(frame: ConversationTopicFrame): boolean {
  if (frame.payload.kind === "snapshot") return true;
  return frame.payload.deltas.some((delta) => {
    if (delta.op === "row.removed") return true;
    if (delta.op !== "row.appended" && delta.op !== "row.upserted") return false;
    const row = delta.row;
    return row.kind === "userInput" && row.origin === "realUser";
  });
}

export function logSubagentProjectionTransition(
  topic: string,
  previous: ConversationSnapshot | null,
  next: ConversationSnapshot,
  delivery: "snapshot" | "deltas",
): void {
  const previousIds = previous?.subagents?.running.map((item) => item.childSessionId) ?? [];
  const nextIds = next.subagents?.running.map((item) => item.childSessionId) ?? [];
  if (
    previousIds.length === nextIds.length &&
    previousIds.every((childSessionId, index) => childSessionId === nextIds[index])
  ) {
    return;
  }
  // 交互 bug 的根因位于订阅快照交接，不在 React DOM；仅在 Agent 运行集变化时
  // 记录轻量身份与水位，使本地复现能区分合法终态和迟到快照覆盖。
  logger.info("[v4-store] running subagent projection changed", {
    delivery,
    nextBackgroundWorkIds: next.backgroundWorks
      .filter((work) => work.kind === "subagent" && work.status === "running")
      .map((work) => work.childSessionId ?? work.workId),
    nextIds,
    nextSeq: next.seq,
    previousIds,
    previousSeq: previous?.seq ?? null,
    topic,
  });
}

/**
 * 还有更早历史可拉 ⇔ 窗口首行不是全序首行（firstRowId 判定）。
 * 纯函数供 store/组件共用；快照缺失/空窗口/未知 firstRowId 一律 false。
 */
export function hasOlderRows(snapshot: ConversationSnapshot | null): boolean {
  if (!snapshot) return false;
  const first = snapshot.rows.window[0];
  if (!first || snapshot.rows.firstRowId === null) return false;
  return first.rowId > snapshot.rows.firstRowId;
}

/**
 * 冷快照尾窗是否从一个 turn 的中间截断。turnHeader 是完整 turn 的权威起点；首行允许是
 * lightBoundary，因此不能只判断首行 kind，必须检查首个 turn 在当前窗口里是否已有 header。
 */
export function shouldAutoLoadIncompleteLeadingTurn(
  snapshot: ConversationSnapshot | null,
  loadingOlder: boolean,
): boolean {
  if (loadingOlder || !hasOlderRows(snapshot) || !snapshot) return false;
  const leadingTurnId = snapshot.rows.window[0]?.turnId;
  if (!leadingTurnId) return false;
  return !snapshot.rows.window.some(
    (row) => row.turnId === leadingTurnId && row.kind === "turnHeader",
  );
}

/**
 * rows/range 结果并入本地窗口（合并规范）：按 rowId 键控、只收
 * 窗口首行之前的行、去重后前插；顺序键 = rowId 升序（全序保证）。
 * 返回 null 表示无可并入行（窗口无变化，调用方不换引用）。
 */
export function mergeOlderRows(
  window: readonly ConversationRow[],
  fetched: readonly ConversationRow[],
): ConversationRow[] | null {
  const firstRowId = window[0]?.rowId ?? Number.POSITIVE_INFINITY;
  const older = fetched.filter((row) => row.rowId < firstRowId);
  if (older.length === 0) return null;
  return [...older, ...window];
}
