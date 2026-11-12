import { Buffer } from "node:buffer";
import {createSessionId, SESSION_ENTRY_HOST_ACCEPTANCE_RECEIPT, SESSION_ENTRY_HOST_ACCEPTANCE_CONTRACT, SESSION_ENTRY_HOST_ACCEPTANCE_TERMINAL, SessionEventType, selectActiveConversationBranch, type BackgroundTaskInfo, type MessageWithParts, type SessionEvent, type SessionId, type SessionInfo, type SessionStorePort, type SessionProjection, type ToolPart, type TurnId, STREAM_RECOVERY_DISCARDED_ERROR_NAME} from "@zcode/contracts";
import {
  createPrismHistoricalAcceptanceIndex,
  projectPrismHistoricalAcceptanceForTask,
} from "@zcode/core";
import type { ZCodeSessionEndedSubagent, ZCodeSessionRunningSubagent } from "@zcode/shared";

const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task", "subagent"]);
const CANCELLATION_PATTERN = /abort|cancel|interrupt|stop/i;

interface SubagentCandidate {
  agentId?: string;
  childSessionId: string;
  runInBackground: boolean;
  output: Record<string, unknown> | null;
  part: ToolPart;
  subagentType: string;
  summary?: string;
  startedAt?: number;
  stoppedAt?: number;
  stoppedStatus?: "success" | "failed" | "cancelled";
  title: string;
  turnId?: TurnId;
}

interface SubagentEventRelation {
  agentId?: string;
  childSessionId?: string;
  description?: string;
  startedAt?: number;
  stoppedAt?: number;
  stoppedStatus?: "success" | "failed" | "cancelled";
  subagentType?: string;
  summary?: string;
}

interface SessionSubagentProjection {
  revision: number;
  running: ZCodeSessionRunningSubagent[];
  ended: ZCodeSessionEndedSubagent[];
}

interface ProjectSessionSubagentsInput {
  revision: number;
  parentSession: SessionInfo;
  messages: readonly MessageWithParts[];
  childSessionsById: ReadonlyMap<string, SessionInfo>;
  childMessagesById: ReadonlyMap<string, readonly MessageWithParts[]>;
  childProjectionsById: ReadonlyMap<string, SessionProjection>;
  parentProjection?: SessionProjection;
  parentEvents?: readonly SessionEvent[];
  prismAcceptanceByChildSessionId?: ReadonlyMap<string, PrismSubagentAcceptanceSummary>;
}

interface PrismSubagentAcceptanceSummary {
  status: "unknown" | "verified" | "rejected";
  passedCriteria: number;
  totalCriteria: number;
}

/** One ownership predicate for server and local observation; task type alone is not enough. */
export function isOwnedSubagentChild(parentSessionId: string, child: SessionInfo): boolean {
  return child.taskType === "subagent_child" && child.parentID === parentSessionId;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringField(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = nonEmptyString(source[key]);
    if (value) return value;
  }
  return undefined;
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function agentIdFromLaunchAcknowledgement(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return nonEmptyString(value.match(/(?:^|\n)agentId:\s*([^\s(]+)/)?.[1]);
}

function contentBlocksToText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map((block) => nonEmptyString(asRecord(block).text))
    .filter((item): item is string => Boolean(item))
    .join("\n\n");
  return text || undefined;
}

function subagentEventRelations(
  events: readonly SessionEvent[] | undefined,
): ReadonlyMap<string, SubagentEventRelation> {
  const relations = new Map<string, SubagentEventRelation>();
  for (const event of events ?? []) {
    if (
      event.type !== SessionEventType.SubagentSpawned &&
      event.type !== SessionEventType.SubagentStopped
    ) {
      continue;
    }
    const payload = asRecord(event.payload);
    const parentToolCallId = stringField(payload, "parentToolCallId");
    if (!parentToolCallId) continue;
    const current = relations.get(parentToolCallId) ?? {};
    if (event.type === SessionEventType.SubagentSpawned) {
      relations.set(parentToolCallId, {
        ...current,
        agentId: stringField(payload, "agentId") ?? current.agentId,
        childSessionId: stringField(payload, "childSessionId") ?? current.childSessionId,
        description: stringField(payload, "description", "prompt") ?? current.description,
        startedAt: event.timestamp.getTime(),
        subagentType: stringField(payload, "agentType") ?? current.subagentType,
      });
      continue;
    }
    const status = stringField(payload, "status");
    relations.set(parentToolCallId, {
      ...current,
      agentId: stringField(payload, "agentId") ?? current.agentId,
      childSessionId: stringField(payload, "childSessionId") ?? current.childSessionId,
      stoppedAt: event.timestamp.getTime(),
      stoppedStatus:
        status === "cancelled" || status === "stopped"
          ? "cancelled"
          : status === "failed" || status === "error"
            ? "failed"
            : "success",
      summary:
        stringField(payload, "summaryText", "result", "error", "description") ?? current.summary,
    });
  }
  return relations;
}

function activeBranchMessages(
  session: SessionInfo,
  messages: readonly MessageWithParts[],
): MessageWithParts[] {
  return selectActiveConversationBranch(messages, {
    branchCutAfterMessageId: session.revert?.branchCutAfterMessageID,
    rewindCreatedMessageId: session.revert?.createdMessageID,
    rewindKeptMessageIds: session.revert?.keptMessageIDs,
    rewindTargetMessageId: session.revert?.targetMessageID,
  });
}

function candidateFromToolPart(
  part: ToolPart,
  relation?: SubagentEventRelation,
  turnId?: TurnId,
): SubagentCandidate | null {
  if (!SUBAGENT_TOOL_NAMES.has(part.tool)) return null;
  const completedOutput =
    part.state.status === "completed" ? nonEmptyString(part.state.output) : undefined;
  const output = parseJsonObject(completedOutput);
  const input = asRecord(part.state.input);
  const stateMetadata = "metadata" in part.state ? asRecord(part.state.metadata) : {};
  const metadata = { ...asRecord(part.metadata), ...stateMetadata };
  const agentId =
    stringField(output ?? {}, "agentId") ??
    // 后台 Agent 的持久化 launch ACK 是纯文本，cold query 未携带
    // 临时 spawn event 时无法恢复 childSessionId，导致真实 running Agent 被整条跳过。
    // 标准 ACK 自带 agentId，按该稳定字段恢复，与 runtime 的 session id 规则对齐。
    agentIdFromLaunchAcknowledgement(completedOutput) ??
    stringField(metadata, "agentId") ??
    relation?.agentId;
  const childSessionId =
    stringField(output ?? {}, "childSessionId") ??
    stringField(metadata, "childSessionId") ??
    relation?.childSessionId ??
    (agentId ? createSessionId(`subagent_${agentId}`) : undefined);
  if (!childSessionId) return null;
  const title =
    stringField(output ?? {}, "description") ??
    stringField(input, "description") ??
    stringField(metadata, "description") ??
    relation?.description ??
    stringField(input, "prompt") ??
    "Subagent";
  return {
    childSessionId,
    runInBackground: input.run_in_background === true,
    part,
    output,
    agentId: agentId ?? part.callID,
    subagentType:
      stringField(output ?? {}, "agentType") ??
      stringField(metadata, "agentType") ??
      relation?.subagentType ??
      stringField(input, "subagent_type", "agent", "agentType") ??
      "subagent",
    title,
    ...(turnId ? { turnId } : {}),
    summary:
      contentBlocksToText(output?.content) ??
      stringField(output ?? {}, "result", "summary") ??
      (part.state.status === "error" ? nonEmptyString(part.state.error) : undefined) ??
      relation?.summary,
    ...(relation?.startedAt !== undefined ? { startedAt: relation.startedAt } : {}),
    ...(relation?.stoppedAt !== undefined ? { stoppedAt: relation.stoppedAt } : {}),
    ...(relation?.stoppedStatus ? { stoppedStatus: relation.stoppedStatus } : {}),
  };
}

function collectCandidates(
  session: SessionInfo,
  messages: readonly MessageWithParts[],
  parentEvents?: readonly SessionEvent[],
): SubagentCandidate[] {
  const candidates = new Map<string, SubagentCandidate>();
  const relations = subagentEventRelations(parentEvents);
  for (const message of activeBranchMessages(session, messages)) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue;
      const candidate = candidateFromToolPart(
        part,
        relations.get(part.callID),
        message.info.anchor?.turnId,
      );
      if (candidate) candidates.set(candidate.childSessionId, candidate);
    }
  }
  return [...candidates.values()];
}

export function collectSubagentChildSessionIds(
  session: SessionInfo,
  messages: readonly MessageWithParts[],
  parentEvents?: readonly SessionEvent[],
): string[] {
  return collectCandidates(session, messages, parentEvents).map(
    (candidate) => candidate.childSessionId,
  );
}

function lastChildOutcome(messages: readonly MessageWithParts[] | undefined): {
  endedAt?: number;
  status?: "success" | "failed" | "cancelled";
  summary?: string;
} {
  if (!messages || messages.length === 0) return {};
  const assistantMessages = messages.filter((message) => message.info.role === "assistant");
  const last = assistantMessages.at(-1);
  if (!last || last.info.role !== "assistant") return {};
  // stream recovery 作废的半截 assistant 带 error 落盘，但子会话紧接着会从锚点
  // 重发；它是最后一条只说明恢复仍在进行或进程已退出，都不是「子会话失败」的终态。
  if (last.info.error && last.info.error.name === STREAM_RECOVERY_DISCARDED_ERROR_NAME) {
    return {};
  }
  const text = last.parts
    .flatMap((part) => (part.type === "text" && part.ignored !== true ? [part.text.trim()] : []))
    .filter(Boolean)
    .join("\n\n");
  const errorName = last.info.error?.name;
  const errorSummary = last.info.error
    ? (stringField(last.info.error.data ?? {}, "message", "error", "detail") ?? errorName)
    : undefined;
  const hasToolRound = last.parts.some((part) => part.type === "tool");
  return {
    ...(last.info.time.completed ? { endedAt: last.info.time.completed } : {}),
    ...(text || errorSummary ? { summary: text || errorSummary } : {}),
    ...(errorName
      ? { status: CANCELLATION_PATTERN.test(errorName) ? "cancelled" : "failed" }
      : // Bug 根因：assistant 发出 tool call 后，该 model step 也会写 completed/finish；
        // 但 child session 仍在执行 Bash 等工具，不能把“本轮结束”当成“子会话终态”。
        // 只有不含 tool part 的最终 assistant message 才能提供成功 outcome。
        !hasToolRound && (last.info.time.completed || last.info.finish)
        ? { status: "success" }
        : {}),
  };
}

function findBackgroundTask(
  projection: SessionProjection | undefined,
  candidate: SubagentCandidate,
): BackgroundTaskInfo | undefined {
  return projection?.backgroundTasks.find(
    (task) =>
      task.taskKind === "subagent" &&
      (task.childSessionId === candidate.childSessionId ||
        task.toolCallId === candidate.part.callID ||
        task.taskId === candidate.agentId),
  );
}

function runningStatus(input: {
  background?: BackgroundTaskInfo;
  candidate: SubagentCandidate;
  childOutcome: ReturnType<typeof lastChildOutcome>;
  childProjection?: SessionProjection;
  parentProjection?: SessionProjection;
}): ZCodeSessionRunningSubagent["status"] | undefined {
  if (input.background?.status === "running") {
    return input.background.blocked ? "blocked" : "running";
  }
  if (input.childProjection?.status === "waiting") return "waiting";
  if (input.childProjection?.status === "running") return "running";
  // async Agent 的父 tool part 在 launch ACK 后立即标成 completed，
  // partial parent projection 又可能暂时不带仍运行的 background task。此时仅按
  // tool part 会把 child 误判为 ended，并在 cold seed 时清空 V4 running 行。
  // child 还没有终态输出、spawn relation 也没有 stop 时，background input 本身
  // 是可恢复的 running 事实；真实终态仍由 background/child projection/outcome 优先。
  if (
    input.candidate.runInBackground &&
    input.background === undefined &&
    input.childProjection === undefined &&
    input.candidate.stoppedStatus === undefined &&
    input.childOutcome.status === undefined
  ) {
    return "running";
  }
  if (
    input.parentProjection?.activeToolCalls.some(
      (tool) =>
        tool.toolCallId === input.candidate.part.callID &&
        (tool.status === "pending" || tool.status === "running"),
    )
  ) {
    return "running";
  }
  return input.parentProjection &&
    (input.candidate.part.state.status === "pending" ||
      input.candidate.part.state.status === "running")
    ? "running"
    : undefined;
}

function terminalBackgroundStatus(
  task: BackgroundTaskInfo | undefined,
): ZCodeSessionEndedSubagent["status"] | undefined {
  switch (task?.status) {
    case "completed":
      return "success";
    case "cancelled":
      return "cancelled";
    case "failed":
    case "timed_out":
    case "spawn_error":
      return "failed";
    case "lost":
      return "lost";
    default:
      return undefined;
  }
}

function endedStatus(input: {
  background?: BackgroundTaskInfo;
  candidate: SubagentCandidate;
  childOutcome: ReturnType<typeof lastChildOutcome>;
  childProjection?: SessionProjection;
}): ZCodeSessionEndedSubagent["status"] {
  const backgroundStatus = terminalBackgroundStatus(input.background);
  if (backgroundStatus) return backgroundStatus;
  if (input.childProjection?.status === "error") return "failed";
  if (input.childProjection?.status === "completed") return "success";
  if (input.candidate.part.state.status === "error") {
    return CANCELLATION_PATTERN.test(input.candidate.part.state.error) ? "cancelled" : "failed";
  }
  if (input.candidate.stoppedStatus) return input.candidate.stoppedStatus;
  const outputStatus = stringField(input.candidate.output ?? {}, "status");
  if (outputStatus === "cancelled" || outputStatus === "stopped") return "cancelled";
  if (outputStatus === "failed" || outputStatus === "error") return "failed";
  if (outputStatus === "async_launched") return input.childOutcome.status ?? "lost";
  if (input.candidate.part.state.status === "completed") return "success";
  return input.childOutcome.status ?? "lost";
}

function startedAt(
  candidate: SubagentCandidate,
  background?: BackgroundTaskInfo,
): number | undefined {
  if (background?.startedAt) return background.startedAt.getTime();
  if (candidate.startedAt !== undefined) return candidate.startedAt;
  return "time" in candidate.part.state ? candidate.part.state.time.start : undefined;
}

export function projectSessionSubagents(
  input: ProjectSessionSubagentsInput,
): SessionSubagentProjection {
  const running: ZCodeSessionRunningSubagent[] = [];
  const ended: ZCodeSessionEndedSubagent[] = [];
  for (const candidate of collectCandidates(
    input.parentSession,
    input.messages,
    input.parentEvents,
  )) {
    const childSession = input.childSessionsById.get(candidate.childSessionId);
    if (!childSession || childSession.taskType !== "subagent_child") continue;
    const childProjection = input.childProjectionsById.get(candidate.childSessionId);
    const background = findBackgroundTask(input.parentProjection, candidate);
    const childOutcome = lastChildOutcome(input.childMessagesById.get(candidate.childSessionId));
    const liveStatus = runningStatus({
      background,
      candidate,
      childOutcome,
      childProjection,
      parentProjection: input.parentProjection,
    });
    const common = {
      childSessionId: candidate.childSessionId,
      ...(candidate.agentId ? { agentId: candidate.agentId } : {}),
      toolCallId: candidate.part.callID,
      subagentType: candidate.subagentType,
      title: candidate.title,
      ...(startedAt(candidate, background) !== undefined
        ? { startedAt: startedAt(candidate, background) }
        : {}),
    };
    if (liveStatus) {
      running.push({ ...common, status: liveStatus });
      continue;
    }
    const stateEndedAt =
      "time" in candidate.part.state && "end" in candidate.part.state.time
        ? candidate.part.state.time.end
        : undefined;
    ended.push({
      ...common,
      status: endedStatus({ background, candidate, childOutcome, childProjection }),
      ...(candidate.summary || childOutcome.summary
        ? { summary: candidate.summary ?? childOutcome.summary }
        : {}),
      endedAt:
        background?.completedAt?.getTime() ??
        candidate.stoppedAt ??
        stateEndedAt ??
        childOutcome.endedAt ??
        childSession.time.updated,
      ...(input.prismAcceptanceByChildSessionId?.get(candidate.childSessionId)
        ? {
            // Каноническое имя + совместимость со старыми клиентами, читающими prismAcceptance.
            hostAcceptance: input.prismAcceptanceByChildSessionId.get(candidate.childSessionId),
            prismAcceptance: input.prismAcceptanceByChildSessionId.get(candidate.childSessionId),
          }
        : {}),
    });
  }
  running.sort(
    (left, right) =>
      (right.startedAt ?? 0) - (left.startedAt ?? 0) ||
      right.childSessionId.localeCompare(left.childSessionId),
  );
  ended.sort(
    (left, right) =>
      (right.endedAt ?? 0) - (left.endedAt ?? 0) ||
      right.childSessionId.localeCompare(left.childSessionId),
  );
  return { revision: input.revision, running, ended };
}

/**
 * Reads only append-only PRISM entries and active transcript launches. It never restores runtime
 * state; ambiguous lineage is surfaced as unknown only when durable PRISM data identifies a task.
 */
export async function resolvePrismAcceptanceByChildSessionId(input: {
  sessionStore: Pick<SessionStorePort, "getSession" | "messages" | "sessionEntries">;
  ownerSession: SessionInfo;
  ownerMessages: readonly MessageWithParts[];
  ownerEvents?: readonly SessionEvent[];
  endedSubagents: readonly ZCodeSessionEndedSubagent[];
  childSessionsById: ReadonlyMap<string, SessionInfo>;
  onReadError?: (error: unknown) => void;
}): Promise<ReadonlyMap<string, PrismSubagentAcceptanceSummary>> {
  const store = input.sessionStore;
  if (!store.sessionEntries || input.endedSubagents.length === 0) return new Map();

  try {
    const ownerPathReversed = [input.ownerSession];
    const visitedOwnerIds = new Set<SessionId>();
    let cursor = input.ownerSession;
    while (cursor.taskType === "subagent_child") {
      if (!cursor.parentID || visitedOwnerIds.has(cursor.id)) return new Map();
      visitedOwnerIds.add(cursor.id);
      const parent = await store.getSession(cursor.parentID);
      if (!parent) return new Map();
      ownerPathReversed.push(parent);
      cursor = parent;
    }
    const ownerPath = ownerPathReversed.reverse();
    const rootSession = ownerPath[0];
    if (!rootSession) return new Map();

    const transcriptByOwnerId = new Map<string, readonly MessageWithParts[]>();
    await Promise.all(
      ownerPath.map(async (owner) => {
        const messages =
          owner.id === input.ownerSession.id
            ? input.ownerMessages
            : await store.messages({ sessionID: owner.id });
        transcriptByOwnerId.set(owner.id, messages);
      }),
    );
    const ownerSessionsById = new Map<SessionId, SessionInfo>(
      ownerPath.map((owner) => [owner.id, owner]),
    );
    for (const child of input.childSessionsById.values()) ownerSessionsById.set(child.id, child);

    const [contracts, receipts, terminals] = await Promise.all([
      store.sessionEntries({
        sessionID: rootSession.id,
        type: SESSION_ENTRY_HOST_ACCEPTANCE_CONTRACT,
      }),
      store.sessionEntries({
        sessionID: rootSession.id,
        type: SESSION_ENTRY_HOST_ACCEPTANCE_RECEIPT,
      }),
      store.sessionEntries({
        sessionID: rootSession.id,
        type: SESSION_ENTRY_HOST_ACCEPTANCE_TERMINAL,
      }),
    ]);
    const acceptanceIndex = createPrismHistoricalAcceptanceIndex({
      rootSessionId: rootSession.id,
      contracts,
      receipts,
      terminals,
    });
    const results = new Map<string, PrismSubagentAcceptanceSummary>();
    const relations = subagentEventRelations(input.ownerEvents);
    const launchesByOwnerId = new Map<
      SessionId,
      ReadonlyMap<string, readonly SubagentCandidate[]>
    >();
    for (const owner of ownerPath) {
      const transcript = transcriptByOwnerId.get(owner.id) ?? [];
      const launchesByChildId = new Map<string, SubagentCandidate[]>();
      for (const message of activeBranchMessages(owner, transcript)) {
        for (const part of message.parts) {
          if (part.type !== "tool") continue;
          const launch = candidateFromToolPart(
            part,
            owner.id === input.ownerSession.id ? relations.get(part.callID) : undefined,
            message.info.anchor?.turnId,
          );
          if (!launch) continue;
          const matches = launchesByChildId.get(launch.childSessionId) ?? [];
          matches.push(launch);
          launchesByChildId.set(launch.childSessionId, matches);
        }
      }
      launchesByOwnerId.set(owner.id, launchesByChildId);
    }

    for (const ended of input.endedSubagents) {
      const taskId = ended.agentId;
      if (!taskId) continue;
      const edgeChildIds = [
        ...ownerPath.slice(1).map((owner) => owner.id),
        ended.childSessionId as SessionId,
      ];
      const launches: SubagentCandidate[] = [];
      let ambiguousLaunch = false;
      for (let index = 0; index < ownerPath.length; index += 1) {
        const owner = ownerPath[index]!;
        const childId = edgeChildIds[index];
        if (!childId) {
          ambiguousLaunch = true;
          break;
        }
        const matches = launchesByOwnerId.get(owner.id)?.get(childId) ?? [];
        if (matches.length !== 1) {
          ambiguousLaunch = true;
          break;
        }
        launches.push(matches[0]!);
      }

      const currentLaunch = launches.at(-1);
      const rootRunId =
        launches.length === ownerPath.length && currentLaunch
          ? `${rootSession.id}:${launches[0]?.turnId ?? "session"}`
          : undefined;
      const parentTaskId = launches.length > 1 ? launches.at(-2)?.agentId : undefined;
      const isRelated =
        acceptanceIndex.contractsByTaskId.has(taskId) ||
        acceptanceIndex.terminalTaskChildKeys.has(JSON.stringify([taskId, ended.childSessionId]));
      if (!isRelated) continue;

      let decision: ReturnType<typeof projectPrismHistoricalAcceptanceForTask>;
      if (
        !ambiguousLaunch &&
        currentLaunch?.agentId === taskId &&
        rootRunId &&
        (launches.length <= 1 || parentTaskId !== undefined)
      ) {
        decision = projectPrismHistoricalAcceptanceForTask({
          rootSessionId: rootSession.id,
          rootRunId,
          taskId,
          ...(parentTaskId ? { parentTaskId } : {}),
          childSessionId: ended.childSessionId as SessionId,
          ownerSessionId: input.ownerSession.id,
          ownerBranchGeneration: input.ownerSession.revert?.branchGeneration ?? 0,
          ownerSessionsById,
          contracts,
          receipts,
          terminals,
          index: acceptanceIndex,
        });
      }
      const totalCriteria = decision
        ? decision.passedCriterionIds.length +
          decision.failedCriterionIds.length +
          decision.missingCriterionIds.length
        : 0;
      results.set(ended.childSessionId, {
        status: decision?.status ?? "unknown",
        passedCriteria: decision?.passedCriterionIds.length ?? 0,
        totalCriteria,
      });
    }
    return results;
  } catch (error) {
    // PRISM history is optional metadata; a store read failure must not hide the existing directory.
    input.onReadError?.(error);
    return new Map();
  }
}

function encodeCursor(item: ZCodeSessionEndedSubagent): string {
  return Buffer.from(
    JSON.stringify({ childSessionId: item.childSessionId, endedAt: item.endedAt ?? 0 }),
  ).toString("base64url");
}

function decodeCursor(cursor: string | undefined): {
  childSessionId: string;
  endedAt: number;
} | null {
  if (!cursor) return null;
  try {
    const value = asRecord(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown,
    );
    const childSessionId = nonEmptyString(value.childSessionId);
    const endedAt = value.endedAt;
    return childSessionId && typeof endedAt === "number" ? { childSessionId, endedAt } : null;
  } catch {
    return null;
  }
}

export function paginateEndedSubagents(
  ended: readonly ZCodeSessionEndedSubagent[],
  options: { cursor?: string; limit: number },
): { items: ZCodeSessionEndedSubagent[]; nextCursor?: string } {
  const cursor = decodeCursor(options.cursor);
  const start = cursor
    ? ended.findIndex(
        (item) =>
          (item.endedAt ?? 0) < cursor.endedAt ||
          ((item.endedAt ?? 0) === cursor.endedAt &&
            item.childSessionId.localeCompare(cursor.childSessionId) < 0),
      )
    : 0;
  if (start < 0) return { items: [] };
  const items = ended.slice(start, start + options.limit);
  const last = items.at(-1);
  return {
    items,
    ...(last && start + items.length < ended.length ? { nextCursor: encodeCursor(last) } : {}),
  };
}
