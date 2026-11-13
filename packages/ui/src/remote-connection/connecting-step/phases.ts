import type { SourceServerOperationLog, RemoteTarget } from "@zcode/shared";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";

/** 连接向导与侧栏详情共用的用户阶段；原始 phase 的归并规则只在这里维护一份。 */
const REMOTE_CONNECTION_PHASES = [
  ["channel", "remote.phase.channel"],
  ["identify", "remote.phase.identify"],
  ["deploy", "remote.phase.deploy"],
  ["handshake", "remote.phase.handshake"],
] as const;

export type RemoteConnectionPhaseStatus = "pending" | "active" | "complete" | "failed";

export function normalizeRemoteConnectionPhase(rawPhase: string): string | null {
  if (rawPhase === "probe") return "channel";
  if (rawPhase === "directory-record") return "identify";
  if (rawPhase === "publish-online") return "handshake";
  if (rawPhase === "daemon" || rawPhase === "protocol-handshake" || rawPhase === "restart")
    return "handshake";
  if (
    rawPhase === "download" ||
    rawPhase === "preflight" ||
    rawPhase === "upload" ||
    rawPhase === "extract" ||
    rawPhase === "verify-archive" ||
    rawPhase === "verify" ||
    rawPhase === "install"
  ) {
    return "deploy";
  }
  if (rawPhase === "channel") return "channel";
  return REMOTE_CONNECTION_PHASES.some(([key]) => key === rawPhase) ? rawPhase : null;
}

export function resolveRemoteConnectionPhases(
  logs: ReadonlyArray<Pick<RemoteConnectionLogEntry, "message" | "level">>,
  options: { connectionReady?: boolean } = {},
) {
  let activeIndex = -1;
  let failedIndex = -1;
  for (const log of logs) {
    const match = /^\[source-server:([^\]]+)\]/u.exec(log.message);
    if (!match) continue;
    const phaseIndex = REMOTE_CONNECTION_PHASES.findIndex(
      ([key]) => key === normalizeRemoteConnectionPhase(match[1]!),
    );
    if (phaseIndex < 0) continue;
    activeIndex = Math.max(activeIndex, phaseIndex);
    if (log.level === "error") failedIndex = phaseIndex;
  }
  // 修复原因：成功连接后 publish-online 不是 Renderer 日志流的可靠终结事件，
  // 仅按日志推断会出现顶部已连接但阶段轨永久停在握手中的状态。连接 session ready
  // 是同一条连接流程的权威终态；没有错误阶段时用它完成最终阶段，不改变连接中的日志进度。
  const connectionReady =
    (options.connectionReady === true ||
      logs.some((log) => log.message.startsWith("[source-server:publish-online]"))) &&
    failedIndex < 0;
  return REMOTE_CONNECTION_PHASES.map(([key, titleId], index) => ({
    key,
    titleId,
    status: (failedIndex === index
      ? "failed"
      : connectionReady
        ? "complete"
        : index < activeIndex
          ? "complete"
          : index === activeIndex
            ? "active"
            : "pending") as RemoteConnectionPhaseStatus,
  }));
}

interface RemoteOperationProgress {
  index: number;
  total: number;
  titleId: string;
  /** 仅最新一条是上传/下载进度时存在，0-100 整数。 */
  percent?: number;
  /** 本次操作首条日志时间；Host 每次新操作都会替换旧日志。 */
  startedAt?: number;
}

/** 侧栏详情只投影阶段与进度，不展示原始日志文本。 */
export function resolveRemoteOperationProgress(
  allLogs: ReadonlyArray<
    Pick<SourceServerOperationLog, "phase" | "progress" | "timestamp" | "level">
  >,
): RemoteOperationProgress {
  // 修复原因：Host 保留的是“最近一次操作”而非“进行中的操作”；断线后首次重试前、两次重试之间
  // 读到的是已结束的上一次操作，曾显示“第 4/4 步 · 已用 120 分”。终态（ready / error）
  // 说明该操作已结束，按尚无日志展示，等下一次尝试由 Host 替换日志。
  const tail = allLogs.at(-1);
  const logs = tail && (tail.phase === "ready" || tail.level === "error") ? [] : allLogs;
  let index = 0;
  for (const log of logs) {
    const key = normalizeRemoteConnectionPhase(log.phase);
    const found = REMOTE_CONNECTION_PHASES.findIndex(([phase]) => phase === key);
    if (found > index) index = found;
  }
  const latest = logs.at(-1);
  const transfer =
    latest?.progress !== undefined && (latest.phase === "upload" || latest.phase === "download");
  return {
    index,
    total: REMOTE_CONNECTION_PHASES.length,
    titleId: REMOTE_CONNECTION_PHASES[index]![1],
    ...(transfer ? { percent: Math.floor(latest.progress! * 100) } : {}),
    ...(logs[0] ? { startedAt: logs[0].timestamp } : {}),
  };
}

/**
 * 阶段子说明（原型 s-sub）：只映射有结构化数据源的场景，映射不到时留空。
 * 原始英文日志不再直接透传，避免与原型中文说明混排。
 */
export function resolveRemoteConnectionPhaseSub(
  phase: { key: string; status: RemoteConnectionPhaseStatus },
  context: {
    kind?: RemoteTarget["kind"];
    recognizedDeviceName?: string;
    installConfirmationPending?: boolean;
    deployErrorReason?: string;
    rawPhase?: string;
  },
): { id: string; values?: Record<string, string> } | null {
  switch (phase.key) {
    case "channel":
      return phase.status === "complete"
        ? {
            id:
              context.kind && context.kind !== "server"
                ? `remote.phaseSub.channelEstablished.${context.kind}`
                : "remote.phaseSub.channelEstablished",
          }
        : null;
    case "identify":
      if (context.recognizedDeviceName) {
        return {
          id: "remote.phaseSub.identifyExisting",
          values: { device: context.recognizedDeviceName },
        };
      }
      if (context.installConfirmationPending) {
        return { id: "remote.phaseSub.identifyNew" };
      }
      return null;
    case "deploy":
      if (phase.status === "failed" && context.deployErrorReason) {
        return {
          id: "remote.phaseSub.uploadFailed",
          values: { reason: context.deployErrorReason },
        };
      }
      if (context.installConfirmationPending) {
        return { id: "remote.phaseSub.deployWaitingConfirm" };
      }
      if (phase.status === "active") {
        const descriptions: Record<string, string> = {
          extract: "remote.phaseSub.extracting",
          "verify-archive": "remote.phaseSub.verifyingArchive",
          verify: "remote.phaseSub.verifyingFiles",
          install: "remote.phaseSub.installed",
        };
        const id = context.rawPhase && descriptions[context.rawPhase];
        if (id) return { id };
      }
      return null;
    case "handshake":
      return phase.status === "active" && context.rawPhase === "restart"
        ? { id: "remote.phaseSub.restarting" }
        : null;
    case "ready":
      return phase.status === "complete" || phase.status === "active"
        ? { id: "remote.phaseSub.readyOnline" }
        : null;
    default:
      return null;
  }
}
