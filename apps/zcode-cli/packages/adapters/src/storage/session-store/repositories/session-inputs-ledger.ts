// session_input 账本仓库。
// 语义：admitted（已接受）→ promoted（与 user message/parts 同事务落 transcript）
// / cancelled / discarded / failed。promotion 的原子性是硬要求：杜绝
// 「queue 已消费但 transcript 无 user message」的孤儿窗口（旧 drain 跨 store 无事务）。
import type { DatabaseSync } from "node:sqlite";
import type { MessageInfo, MessagePart, SwarmNodeAttemptRecord, SwarmNodeAttemptReservation, SwarmNodeAttemptStatus, SwarmNodeAttemptTransition, SwarmRunAdmission, SwarmRunGraphCommit, SwarmRunOwnerClaim, SwarmRunRecord, SwarmRunStatus, SwarmRunTransition, SessionId, SessionInputDelivery, SessionInputRecord, SessionInputStatus } from "@zcode/contracts";
import { AgentTaskGraphSchema } from "@zcode/contracts";
import { encodeJson } from "../json.js";
import { messages as readMessages, saveMessage, savePart } from "./messages.js";
import * as sessionEntryRepository from "./session-entries.js";

import {
  SessionInputRow,
  SwarmRunRow,
  SwarmNodeAttemptRow,
  SWARM_TERMINAL_RUN_STATUSES,
  SWARM_TERMINAL_ATTEMPT_STATUSES,
  MAX_SWARM_RESULT_BYTES,
  SWARM_RUN_STATUSES,
  SWARM_ATTEMPT_STATUSES,
  assertSwarmDiagnosticSize,
  validateSwarmGraph,
  decodeSwarmRunRow,
  decodeSwarmAttemptRow,
  decodeSessionInputRow,
  decodePayload,
  type SessionInputPatch,
} from "./session-inputs.js";

/**
 * Ledger-операции session_input после admit (promote/settle/list) и swarm-run/
 * swarm-attempt API вынесены из session-inputs.ts по лимиту строк. Работают с тем же
 * `db` и разделяют декодеры строк из исходного модуля.
 */

export async function promoteSessionInput(
  db: DatabaseSync,
  input: {
    id: string;
    sessionID: SessionId;
    message: MessageInfo;
    parts: MessagePart[];
  },
): Promise<void> {
  const now = Date.now();
  db.exec("begin immediate");
  try {
    await saveMessage(db, input.message);
    for (const part of input.parts) {
      await savePart(db, part);
    }
    const refs =
      input.message.metadata && typeof input.message.metadata === "object"
        ? (input.message.metadata as Record<string, unknown>).inputIntent &&
          typeof (input.message.metadata as Record<string, unknown>).inputIntent === "object"
          ? (
              (input.message.metadata as Record<string, unknown>).inputIntent as Record<
                string,
                unknown
              >
            ).sharedContextRefs
          : undefined
        : undefined;
    if (Array.isArray(refs)) {
      for (const ref of refs) {
        if (
          !ref ||
          typeof ref !== "object" ||
          (ref as Record<string, unknown>).kind !== "shared_context_import"
        )
          continue;
        const contextId = (ref as Record<string, unknown>).context_id;
        if (typeof contextId !== "string") continue;
        const entry = sessionEntryRepository
          .sessionEntries(db, { sessionID: input.sessionID, type: "v4/shared_context_import" })
          .find((candidate) => {
            const data = candidate.data;
            return Boolean(
              data &&
              typeof data === "object" &&
              !Array.isArray(data) &&
              (data as Record<string, unknown>).contextId === contextId,
            );
          });
        if (!entry) throw new Error("shared context import is missing");
        const data = entry.data as Record<string, unknown>;
        if (!["pending", "reserved"].includes(String(data.status))) {
          throw new Error("shared context import is no longer attachable");
        }
        sessionEntryRepository.saveSessionEntry(db, {
          ...entry,
          time: { ...entry.time, updated: now },
          data: { ...data, status: "attached", attachedMessageId: String(input.message.id) },
        });
        const contextMessage = (
          await readMessages(db, {
            sessionID: input.sessionID,
          })
        ).find((candidate) => {
          const metadata = candidate.info.metadata;
          return Boolean(
            metadata &&
            typeof metadata === "object" &&
            (metadata as Record<string, unknown>).contextId === contextId,
          );
        });
        if (contextMessage) {
          await saveMessage(db, {
            ...contextMessage.info,
            metadata: {
              ...contextMessage.info.metadata,
              sharedContextStatus: "attached",
            },
          });
        }
      }
    }
    db.prepare(
      `
        update session_input
        set status = 'promoted',
            promoted_message_id = ?,
            promoted_sequence = (
              select coalesce(max(promoted_sequence), -1) + 1
              from session_input
              where session_id = ?
            ),
            time_updated = ?
        where id = ? and session_id = ?
        `,
    ).run(String(input.message.id), input.sessionID, now, input.id, input.sessionID);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

export async function markSessionInputPromoted(
  db: DatabaseSync,
  input: { id: string; sessionID: SessionId; promotedMessageID: string },
): Promise<void> {
  db.prepare(
    `
      update session_input
      set status = 'promoted',
          promoted_message_id = ?,
          promoted_sequence = (
            select coalesce(max(promoted_sequence), -1) + 1
            from session_input
            where session_id = ?
          ),
          time_updated = ?
      where id = ? and session_id = ? and status = 'admitted'
      `,
  ).run(input.promotedMessageID, input.sessionID, Date.now(), input.id, input.sessionID);
}

export async function settleSessionInput(
  db: DatabaseSync,
  input: {
    id: string;
    sessionID: SessionId;
    status: "cancelled" | "discarded" | "failed";
    reason?: string;
  },
): Promise<void> {
  // 只收口未终态的记录：promoted 后到达的迟到 discard 不得回退状态。
  db.prepare(
    `
      update session_input
      set status = ?, status_reason = ?, time_updated = ?
      where id = ? and session_id = ? and status = 'admitted'
      `,
  ).run(input.status, input.reason ?? null, Date.now(), input.id, input.sessionID);
}

export async function listSessionInputs(
  db: DatabaseSync,
  input: { sessionID: SessionId; status?: SessionInputStatus },
): Promise<SessionInputRecord[]> {
  const rows = (input.status
    ? db
        .prepare(
          `
            select * from session_input
            where session_id = ? and status = ?
            order by admitted_sequence
            `,
        )
        .all(input.sessionID, input.status)
    : db
        .prepare(
          `
            select * from session_input
            where session_id = ?
            order by admitted_sequence
            `,
        )
        .all(input.sessionID)) as unknown as SessionInputRow[];
  return rows.map(decodeSessionInputRow);
}

export async function getSessionInputById(
  db: DatabaseSync,
  id: string,
): Promise<SessionInputRecord | null> {
  const row = db.prepare("select * from session_input where id = ?").get(id) as
    | SessionInputRow
    | undefined;
  return row ? decodeSessionInputRow(row) : null;
}


export function readSwarmRun(db: DatabaseSync, rootSessionID: SessionId, runID: string): SwarmRunRecord | null {
  const row = db
    .prepare("select * from swarm_run where root_session_id = ? and run_id = ?")
    .get(rootSessionID, runID) as SwarmRunRow | undefined;
  return row ? decodeSwarmRunRow(row) : null;
}

export function readSwarmRunBySource(
  db: DatabaseSync,
  rootSessionID: SessionId,
  sourceCommandID: string,
): SwarmRunRecord | null {
  const row = db
    .prepare("select * from swarm_run where root_session_id = ? and source_command_id = ?")
    .get(rootSessionID, sourceCommandID) as SwarmRunRow | undefined;
  return row ? decodeSwarmRunRow(row) : null;
}

/** The composite key is the accepted input identity; runID is only a first-creation candidate. */
export async function admitSwarmRun(
  db: DatabaseSync,
  input: SwarmRunAdmission,
): Promise<{ run: SwarmRunRecord; created: boolean }> {
  if (
    !String(input.rootSessionID).trim() ||
    !input.sourceCommandID.trim() ||
    !input.runID.trim() ||
    !String(input.rootTurnID).trim() ||
    !Number.isSafeInteger(input.ownerEpoch) ||
    input.ownerEpoch < 0
  ) {
    throw new Error("Invalid Swarm run admission");
  }
  const now = input.now ?? Date.now();
  db.exec("begin immediate");
  try {
    const acceptedInput = db
      .prepare(`
        select 1 as found
        from session_input
        where session_id = ?
          and status in ('admitted', 'promoted')
          and coalesce(
            json_extract(payload, '$.conversationInputIntent.sourceCommandId'),
            json_extract(payload, '$.intent.sourceCommandId')
          ) = ?
        limit 1
      `)
      .get(input.rootSessionID, input.sourceCommandID);
    if (!acceptedInput) throw new Error("Swarm run admission requires a matching accepted session input");
    const existing = readSwarmRunBySource(db, input.rootSessionID, input.sourceCommandID);
    if (existing) {
      db.exec("commit");
      return { run: existing, created: false };
    }
    const runIDCollision = db.prepare("select 1 as found from swarm_run where run_id = ?").get(input.runID);
    if (runIDCollision) throw new Error("Swarm candidate run ID already belongs to another accepted input");
    db.prepare(`
      insert into swarm_run (
        schema_version, root_session_id, source_command_id, run_id, root_turn_id,
        status, owner_epoch, revision, time_created, time_updated
      ) values (1, ?, ?, ?, ?, 'planning', ?, 0, ?, ?)
    `).run(
      input.rootSessionID,
      input.sourceCommandID,
      input.runID,
      input.rootTurnID,
      input.ownerEpoch,
      now,
      now,
    );
    const run = readSwarmRun(db, input.rootSessionID, input.runID);
    if (!run) throw new Error("Swarm run admission did not persist its run");
    db.exec("commit");
    return { run, created: true };
  } catch (error) {
    try {
      db.exec("rollback");
    } catch {
      // Keep the original storage error.
    }
    throw error;
  }
}

export async function getSwarmRun(
  db: DatabaseSync,
  input: { rootSessionID: SessionId; runID: string },
): Promise<SwarmRunRecord | null> {
  return readSwarmRun(db, input.rootSessionID, input.runID);
}

export async function findSwarmRunBySourceCommand(
  db: DatabaseSync,
  input: { rootSessionID: SessionId; sourceCommandID: string },
): Promise<SwarmRunRecord | null> {
  return readSwarmRunBySource(db, input.rootSessionID, input.sourceCommandID);
}

export function boundedLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(500, Math.floor(limit ?? 100)));
}

export async function listSwarmRuns(
  db: DatabaseSync,
  input: { rootSessionID: SessionId; statuses?: SwarmRunStatus[]; limit?: number },
): Promise<SwarmRunRecord[]> {
  const limit = boundedLimit(input.limit);
  if (input.statuses && input.statuses.length === 0) return [];
  const rows = input.statuses
    ? (db
        .prepare(
          `select * from swarm_run where root_session_id = ? and status in (${input.statuses.map(() => "?").join(",")}) order by time_created desc, run_id limit ?`,
        )
        .all(input.rootSessionID, ...input.statuses, limit) as unknown as SwarmRunRow[])
    : (db
        .prepare(
          "select * from swarm_run where root_session_id = ? order by time_created desc, run_id limit ?",
        )
        .all(input.rootSessionID, limit) as unknown as SwarmRunRow[]);
  return rows.map(decodeSwarmRunRow);
}

/** Save the complete validated graph before Core dispatches any node side effects. */
export async function commitSwarmRunGraph(
  db: DatabaseSync,
  input: SwarmRunGraphCommit,
): Promise<boolean> {
  const graphJSON = validateSwarmGraph(input.graph);
  const now = input.now ?? Date.now();
  const result = db
    .prepare(`
      update swarm_run
      set graph_json = ?, revision = revision + 1, time_updated = ?
      where root_session_id = ? and run_id = ? and revision = ? and owner_epoch = ?
        and graph_json is null and status = 'planning' and time_terminal is null
    `)
    .run(
      graphJSON,
      now,
      input.rootSessionID,
      input.runID,
      input.expectedRevision,
      input.ownerEpoch,
    );
  return result.changes === 1;
}

export async function transitionSwarmRun(
  db: DatabaseSync,
  input: SwarmRunTransition,
): Promise<boolean> {
  if (!SWARM_RUN_STATUSES.includes(input.status)) throw new Error("Invalid Swarm run status");
  assertSwarmDiagnosticSize(input.diagnosticCode);
  const current = db
    .prepare("select status, graph_json from swarm_run where root_session_id = ? and run_id = ? and revision = ? and owner_epoch = ? and time_terminal is null")
    .get(input.rootSessionID, input.runID, input.expectedRevision, input.ownerEpoch) as
    | { status: string; graph_json: string | null }
    | undefined;
  if (!current) return false;
  const allowed: Record<string, readonly SwarmRunStatus[]> = {
    // 原因：显式「Рой」对不可拆分请求会把 planning 直接记为 completed，再交给普通 model turn。
    // 修复依据：无 graph 的 planning→completed 是 leaf/pre-spawn handoff；已提交图仍必须先进入 running。
    planning: ["running", "failed", "cancelled", "interrupted", "completed"],
    running: ["completed", "failed", "cancelled", "interrupted"],
  };
  if (!allowed[current.status]?.includes(input.status)) return false;
  if (current.status === "planning" && input.status === "completed" && current.graph_json != null) {
    return false;
  }
  const now = input.now ?? Date.now();
  const terminal = SWARM_TERMINAL_RUN_STATUSES.has(input.status) ? now : null;
  const result = db
    .prepare(`
      update swarm_run
      set status = ?, revision = revision + 1, time_updated = ?, time_terminal = ?,
          diagnostic_code = ?
      where root_session_id = ? and run_id = ? and revision = ? and owner_epoch = ?
        and status = ? and time_terminal is null
    `)
    .run(
      input.status,
      now,
      terminal,
      input.diagnosticCode ?? null,
      input.rootSessionID,
      input.runID,
      input.expectedRevision,
      input.ownerEpoch,
      current.status,
    );
  return result.changes === 1;
}

export async function claimSwarmRunOwner(
  db: DatabaseSync,
  input: SwarmRunOwnerClaim,
): Promise<boolean> {
  if (
    !Number.isSafeInteger(input.ownerEpoch) ||
    input.ownerEpoch <= input.expectedOwnerEpoch
  ) {
    throw new Error("Swarm owner epoch must advance monotonically");
  }
  const now = input.now ?? Date.now();
  db.exec("begin immediate");
  try {
    const result = db
      .prepare(`
        update swarm_run
        set owner_epoch = ?, revision = revision + 1, time_updated = ?
        where root_session_id = ? and run_id = ? and revision = ? and owner_epoch = ?
          and status in ('planning', 'running') and time_terminal is null
      `)
      .run(
        input.ownerEpoch,
        now,
        input.rootSessionID,
        input.runID,
        input.expectedRevision,
        input.expectedOwnerEpoch,
      );
    if (result.changes !== 1) {
      db.exec("commit");
      return false;
    }
    // 修复依据：新 Core owner 接管 run 时，旧 owner 留下的 in-flight attempts 也必须
    // 先被新 epoch fencing；否则新 owner 无法把不安全任务收口为 interrupted。
    db.prepare(`
      update swarm_node_attempt
      set owner_epoch = ?, revision = revision + 1, time_updated = ?
      where run_id = ? and status in ('pending', 'dispatching', 'running')
    `).run(input.ownerEpoch, now, input.runID);
    db.exec("commit");
    return true;
  } catch (error) {
    try {
      db.exec("rollback");
    } catch {
      // Keep the original storage error.
    }
    throw error;
  }
}

export function readSwarmAttempt(
  db: DatabaseSync,
  runID: string,
  nodeID: string,
  attemptID: string,
): SwarmNodeAttemptRecord | null {
  const row = db
    .prepare("select * from swarm_node_attempt where run_id = ? and node_id = ? and attempt_id = ?")
    .get(runID, nodeID, attemptID) as SwarmNodeAttemptRow | undefined;
  return row ? decodeSwarmAttemptRow(row) : null;
}

/** Reserve durable child identity before any child model/tool side effects can start. */
export async function reserveSwarmNodeAttempt(
  db: DatabaseSync,
  input: SwarmNodeAttemptReservation,
): Promise<{ attempt: SwarmNodeAttemptRecord; created: boolean }> {
  if (
    !input.runID.trim() ||
    !input.nodeID.trim() ||
    !input.attemptID.trim() ||
    !String(input.childSessionID).trim() ||
    !Number.isSafeInteger(input.attemptNo) ||
    input.attemptNo < 1 ||
    !Number.isSafeInteger(input.ownerEpoch) ||
    input.ownerEpoch < 0
  ) {
    throw new Error("Invalid Swarm node attempt reservation");
  }
  const now = input.now ?? Date.now();
  db.exec("begin immediate");
  try {
    const run = db
      .prepare("select owner_epoch, graph_json, status from swarm_run where run_id = ?")
      .get(input.runID) as
      | { owner_epoch: number; graph_json: string | null; status: string }
      | undefined;
    if (
      !run ||
      run.owner_epoch !== input.ownerEpoch ||
      !run.graph_json ||
      run.status !== "running"
    ) {
      throw new Error("Swarm attempt reservation requires an active run with a committed graph");
    }
    const graph = AgentTaskGraphSchema.parse(JSON.parse(run.graph_json));
    if (!graph.nodes.some((node) => node.id === input.nodeID)) {
      throw new Error("Swarm attempt node is missing from the committed graph");
    }
    const existing = readSwarmAttempt(db, input.runID, input.nodeID, input.attemptID);
    if (existing) {
      if (
        existing.attemptNo !== input.attemptNo ||
        existing.childSessionID !== input.childSessionID ||
        existing.ownerEpoch !== input.ownerEpoch
      ) {
        throw new Error("Swarm attempt identity was reused with conflicting reservation data");
      }
      db.exec("commit");
      return { attempt: existing, created: false };
    }
    db.prepare(`
      insert into swarm_node_attempt (
        schema_version, run_id, node_id, attempt_id, attempt_no, status,
        child_session_id, owner_epoch, revision, time_created, time_updated
      ) values (1, ?, ?, ?, ?, 'dispatching', ?, ?, 0, ?, ?)
    `).run(
      input.runID,
      input.nodeID,
      input.attemptID,
      input.attemptNo,
      input.childSessionID,
      input.ownerEpoch,
      now,
      now,
    );
    const attempt = readSwarmAttempt(db, input.runID, input.nodeID, input.attemptID);
    if (!attempt) throw new Error("Swarm node attempt reservation did not persist");
    db.exec("commit");
    return { attempt, created: true };
  } catch (error) {
    try {
      db.exec("rollback");
    } catch {
      // Keep the original storage error.
    }
    throw error;
  }
}

export async function transitionSwarmNodeAttempt(
  db: DatabaseSync,
  input: SwarmNodeAttemptTransition,
): Promise<boolean> {
  if (!SWARM_ATTEMPT_STATUSES.includes(input.status)) throw new Error("Invalid Swarm attempt status");
  if (
    input.resultText != null &&
    Buffer.byteLength(input.resultText, "utf8") > MAX_SWARM_RESULT_BYTES
  ) {
    throw new Error("Swarm node result exceeds 32 KiB");
  }
  assertSwarmDiagnosticSize(input.diagnosticCode);
  const existing = readSwarmAttempt(db, input.runID, input.nodeID, input.attemptID);
  if (!existing || existing.revision !== input.expectedRevision || existing.ownerEpoch !== input.ownerEpoch) {
    return false;
  }
  const allowed: Record<string, readonly SwarmNodeAttemptStatus[]> = {
    dispatching: ["running", "failed", "cancelled", "interrupted"],
    running: ["completed", "failed", "cancelled", "interrupted"],
  };
  if (!allowed[existing.status]?.includes(input.status)) return false;
  const resultText = input.resultText === undefined ? existing.resultText ?? null : input.resultText;
  const terminal = SWARM_TERMINAL_ATTEMPT_STATUSES.has(input.status) ? (input.now ?? Date.now()) : null;
  const result = db
    .prepare(`
      update swarm_node_attempt
      set status = ?, revision = revision + 1, time_updated = ?, time_terminal = ?,
          result_text = ?, diagnostic_code = ?
      where run_id = ? and node_id = ? and attempt_id = ? and revision = ? and owner_epoch = ?
        and status = ? and time_terminal is null
        and exists (select 1 from swarm_run where run_id = ? and owner_epoch = ?)
    `)
    .run(
      input.status,
      input.now ?? Date.now(),
      terminal,
      resultText,
      input.diagnosticCode === undefined ? existing.diagnosticCode ?? null : input.diagnosticCode,
      input.runID,
      input.nodeID,
      input.attemptID,
      input.expectedRevision,
      input.ownerEpoch,
      existing.status,
      input.runID,
      input.ownerEpoch,
    );
  return result.changes === 1;
}

export async function listSwarmNodeAttempts(
  db: DatabaseSync,
  input: { runID: string },
): Promise<SwarmNodeAttemptRecord[]> {
  const rows = db
    .prepare("select * from swarm_node_attempt where run_id = ? order by node_id, attempt_no")
    .all(input.runID) as unknown as SwarmNodeAttemptRow[];
  return rows.map(decodeSwarmAttemptRow);
}

/** Startup can query active facts; only Core decides whether/how to reconcile them. */
export async function listRecoverableSwarmRuns(
  db: DatabaseSync,
  input?: { limit?: number },
): Promise<SwarmRunRecord[]> {
  const rows = db
    .prepare(`
      select * from swarm_run
      where status in ('planning', 'running')
      order by time_updated, run_id
      limit ?
    `)
    .all(boundedLimit(input?.limit)) as unknown as SwarmRunRow[];
  return rows.map(decodeSwarmRunRow);
}


export function patchObject(value: unknown, patch: SessionInputPatch): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const current = value as Record<string, unknown>;
  const order = current.order;
  const intent = patch.intent;
  return {
    ...current,
    ...(patch.text !== undefined ? { text: patch.text } : {}),
    ...(patch.queuePosition !== undefined || intent?.queuePosition !== undefined
      ? {
          order:
            order && typeof order === "object" && !Array.isArray(order)
              ? {
                  ...(order as Record<string, unknown>),
                  queuePosition: patch.queuePosition ?? intent?.queuePosition,
                }
              : { queuePosition: patch.queuePosition ?? intent?.queuePosition },
        }
      : {}),
    ...(intent
      ? {
          delivery: {
            requested: intent.requestedDelivery,
            admitted: intent.admittedDelivery,
            ...(intent.fallbackReasonCode ? { fallbackReasonCode: intent.fallbackReasonCode } : {}),
          },
          steer: intent.fallbackReasonCode
            ? { state: "fellBack", reasonCode: intent.fallbackReasonCode }
            : current.steer,
        }
      : {}),
  };
}

export async function updateSessionInputs(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    updates: SessionInputPatch[];
  },
): Promise<void> {
  if (input.updates.length === 0) return;
  const read = db.prepare(
    "select delivery, payload from session_input where id = ? and session_id = ? and status = 'admitted'",
  );
  const write = db.prepare(
    "update session_input set delivery = ?, payload = ?, time_updated = ? where id = ? and session_id = ? and status = 'admitted'",
  );
  db.exec("begin immediate");
  try {
    const now = Date.now();
    for (const update of input.updates) {
      const row = read.get(update.id, input.sessionID) as
        | { delivery: SessionInputDelivery; payload: string }
        | undefined;
      if (!row) continue;
      const payload = decodePayload(row.payload);
      if (update.text !== undefined) payload.text = update.text;
      if ("conversationInputIntent" in payload) {
        payload.conversationInputIntent = patchObject(payload.conversationInputIntent, update);
      }
      // 兼容当前 runtime metadata；新写入权威格式仍是 conversationInputIntent。
      if (update.intent) {
        payload.intent = update.intent;
      } else if ("intent" in payload && update.queuePosition !== undefined) {
        const intent = payload.intent;
        if (intent && typeof intent === "object" && !Array.isArray(intent)) {
          payload.intent = {
            ...(intent as Record<string, unknown>),
            queuePosition: update.queuePosition,
          };
        }
      }
      write.run(
        update.delivery ?? row.delivery,
        encodeJson(payload) ?? "{}",
        now,
        update.id,
        input.sessionID,
      );
    }
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}
