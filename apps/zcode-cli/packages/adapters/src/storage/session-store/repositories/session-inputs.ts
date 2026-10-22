// session_input 账本仓库。
// 语义：admitted（已接受）→ promoted（与 user message/parts 同事务落 transcript）
// / cancelled / discarded / failed。promotion 的原子性是硬要求：杜绝
// 「queue 已消费但 transcript 无 user message」的孤儿窗口（旧 drain 跨 store 无事务）。
import type { DatabaseSync } from "node:sqlite";
import type {
  MessageInfo,
  MessagePart,
  OpenCodeAgentRunAdmission,
  OpenCodeAgentRunHostEventTransition,
  OpenCodeAgentRunRecord,
  OpenCodeAgentRunStatus,
  OpenCodeAgentRunTransition,
  SessionId,
  SessionInputDelivery,
  SessionInputRecord,
  SessionInputStatus,
  TurnInputIntentMetadata,
} from "@zcode/contracts";
import { encodeJson } from "../json.js";
import { messages as readMessages, saveMessage, savePart } from "./messages.js";
import * as sessionEntryRepository from "./session-entries.js";

interface SessionInputRow {
  id: string;
  session_id: string;
  kind: string;
  delivery: string;
  payload: string;
  admitted_sequence: number;
  promoted_sequence: number | null;
  promoted_message_id: string | null;
  status: string;
  status_reason: string | null;
  time_created: number;
  time_updated: number;
}

interface OpenCodeAgentRunRow {
  schema_version: number;
  session_id: string;
  run_id: string;
  command_id: string;
  input_id: string;
  route_kind: string;
  requested_model_id: string | null;
  status: string;
  event_sequence: number;
  host_event_sequence: number;
  time_created: number;
  time_updated: number;
  time_terminal: number | null;
  opencode_session_id: string | null;
  result_text: string | null;
  stop_reason: string | null;
  diagnostic_code: string | null;
  prompt_text: string;
  activity_json: string;
}

interface OpenCodeAgentRunActivity {
  outputText: string;
  tools: Array<{ toolCallId: string; title: string; status: string }>;
}

const OPEN_CODE_RUN_TERMINAL_STATUSES = new Set<OpenCodeAgentRunStatus>([
  "completed",
  "cancelled",
  "failed",
  "interrupted",
]);

const OPEN_CODE_RUN_TRANSITIONS: Readonly<
  Record<OpenCodeAgentRunStatus, readonly OpenCodeAgentRunStatus[]>
> = {
  pending: ["dispatching", "failed", "interrupted"],
  dispatching: ["cancelled", "failed", "interrupted"],
  running: ["interrupted"],
  completed: [],
  cancelled: [],
  failed: [],
  interrupted: [],
};

const OPEN_CODE_HOST_EVENT_TRANSITIONS: Readonly<
  Record<OpenCodeAgentRunStatus, readonly OpenCodeAgentRunStatus[]>
> = {
  pending: [],
  dispatching: ["running", "completed", "cancelled", "failed", "interrupted"],
  running: ["running", "completed", "cancelled", "failed", "interrupted"],
  completed: [],
  cancelled: [],
  failed: [],
  interrupted: [],
};

const MAX_OPEN_CODE_RUN_RESULT_BYTES = 32 * 1024;
const MAX_OPEN_CODE_RUN_PROMPT_BYTES = 64 * 1024;
const MAX_OPEN_CODE_RUN_TOOLS = 64;

function assertOpenCodePromptSize(promptText: string): void {
  if (Buffer.byteLength(promptText, "utf8") > MAX_OPEN_CODE_RUN_PROMPT_BYTES) {
    throw new Error("OpenCode delegated prompt exceeds its bounded snapshot size");
  }
}

function decodeOpenCodeActivity(value: string): OpenCodeAgentRunActivity {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid persisted OpenCode activity");
  const activity = parsed as OpenCodeAgentRunActivity;
  if (
    typeof activity.outputText !== "string" ||
    !Array.isArray(activity.tools) ||
    Buffer.byteLength(activity.outputText, "utf8") > MAX_OPEN_CODE_RUN_RESULT_BYTES ||
    activity.tools.length > MAX_OPEN_CODE_RUN_TOOLS ||
    activity.tools.some(
      (tool) =>
        typeof tool?.toolCallId !== "string" ||
        typeof tool?.title !== "string" ||
        typeof tool?.status !== "string",
    )
  ) {
    throw new Error("Persisted OpenCode delegated run activity exceeds its bounds");
  }
  return activity;
}

function decodeOpenCodeAgentRunRow(row: OpenCodeAgentRunRow): OpenCodeAgentRunRecord {
  if (row.schema_version !== 1 || row.route_kind !== "opencode-cli") {
    throw new Error("Unsupported OpenCode delegated run record");
  }
  const statuses: readonly OpenCodeAgentRunStatus[] = [
    "pending",
    "dispatching",
    "running",
    "completed",
    "cancelled",
    "failed",
    "interrupted",
  ];
  if (!statuses.includes(row.status as OpenCodeAgentRunStatus)) {
    throw new Error("Invalid OpenCode delegated run status");
  }
  assertOpenCodePromptSize(row.prompt_text);
  return {
    schemaVersion: 1,
    sessionID: row.session_id as SessionId,
    runID: row.run_id,
    commandID: row.command_id,
    inputID: row.input_id,
    routeKind: "opencode-cli",
    ...(row.requested_model_id !== null ? { requestedModelID: row.requested_model_id } : {}),
    status: row.status as OpenCodeAgentRunStatus,
    eventSequence: row.event_sequence,
    hostEventSequence: row.host_event_sequence,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      ...(row.time_terminal !== null ? { terminal: row.time_terminal } : {}),
    },
    ...(row.opencode_session_id !== null ? { openCodeSessionID: row.opencode_session_id } : {}),
    ...(row.result_text !== null ? { resultText: row.result_text } : {}),
    ...(row.stop_reason !== null ? { stopReason: row.stop_reason } : {}),
    ...(row.diagnostic_code !== null ? { diagnosticCode: row.diagnostic_code } : {}),
    promptText: row.prompt_text,
    ...(() => {
      const activity = decodeOpenCodeActivity(row.activity_json);
      return { outputText: activity.outputText, toolActivity: activity.tools };
    })(),
  };
}

function assertOpenCodeRunResultSize(resultText: string | null | undefined): void {
  if (
    resultText != null &&
    Buffer.byteLength(resultText, "utf8") > MAX_OPEN_CODE_RUN_RESULT_BYTES
  ) {
    throw new Error("OpenCode delegated run result exceeds 32 KiB");
  }
}

function appendOpenCodeOutputBounded(current: string, chunk: string): string {
  const bytes = Buffer.from(`${current}${chunk}`, "utf8");
  if (bytes.byteLength <= MAX_OPEN_CODE_RUN_RESULT_BYTES) return bytes.toString("utf8");
  // Accept the ordered Host event even after the display snapshot fills; never make the Host's
  // next sequence permanently unprocessable because a transcript preview reached its cap.
  let end = MAX_OPEN_CODE_RUN_RESULT_BYTES;
  while (end > 0) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return "";
}

function readOpenCodeAgentRun(
  db: DatabaseSync,
  sessionID: SessionId,
  runID: string,
): OpenCodeAgentRunRecord | null {
  const row = db
    .prepare("select * from opencode_agent_run where session_id = ? and run_id = ?")
    .get(sessionID, runID) as OpenCodeAgentRunRow | undefined;
  return row ? decodeOpenCodeAgentRunRow(row) : null;
}

/** Commit the accepted canonical input and dispatchable outbox envelope as one transaction. */
export async function admitOpenCodeAgentRun(
  db: DatabaseSync,
  admission: OpenCodeAgentRunAdmission,
): Promise<{ input: SessionInputRecord; run: OpenCodeAgentRunRecord; created: boolean }> {
  const { input } = admission;
  if (
    !admission.commandID.trim() ||
    admission.runID !== admission.commandID ||
    input.id !== admission.commandID ||
    input.kind !== "sendText" ||
    input.delivery !== "startNow" ||
    input.payload.executionRoute !== "opencode-cli"
  ) {
    throw new Error("Invalid OpenCode delegated run admission");
  }
  assertOpenCodePromptSize(input.payload.text);
  const now = admission.now ?? Date.now();
  db.exec("begin immediate");
  try {
    const existingInput = db
      .prepare("select * from session_input where id = ?")
      .get(input.id) as unknown as SessionInputRow | undefined;
    const existingRun = db
      .prepare("select * from opencode_agent_run where command_id = ?")
      .get(admission.commandID) as OpenCodeAgentRunRow | undefined;
    if (existingRun) {
      if (existingRun.session_id !== input.sessionID || existingRun.input_id !== input.id) {
        throw new Error("OpenCode delegated command ID belongs to another session");
      }
      if (!existingInput || existingInput.session_id !== input.sessionID) {
        throw new Error("OpenCode delegated run is missing its canonical input");
      }
      const record = decodeOpenCodeAgentRunRow(existingRun);
      const inputRecord = decodeSessionInputRow(existingInput);
      db.exec("commit");
      return { input: inputRecord, run: record, created: false };
    }
    if (existingInput) {
      throw new Error("Command ID already has a session input without an OpenCode outbox row");
    }
    const admittedSequence = db
      .prepare(
        "select coalesce(max(admitted_sequence), -1) + 1 as next from session_input where session_id = ?",
      )
      .get(input.sessionID) as { next: number };
    db.prepare(`
      insert into session_input (
        id, session_id, kind, delivery, payload, admitted_sequence, status, time_created, time_updated
      ) values (?, ?, ?, ?, ?, ?, 'admitted', ?, ?)
    `).run(
      input.id,
      input.sessionID,
      input.kind,
      input.delivery,
      encodeJson(input.payload) ?? "{}",
      admittedSequence.next,
      now,
      now,
    );
    db.prepare(`
      insert into opencode_agent_run (
        schema_version, session_id, run_id, command_id, input_id, route_kind,
        requested_model_id, status, event_sequence, time_created, time_updated,
        prompt_text, activity_json
      ) values (1, ?, ?, ?, ?, 'opencode-cli', ?, 'pending', 0, ?, ?, ?, '{"outputText":"","tools":[]}')
    `).run(
      input.sessionID,
      admission.runID,
      admission.commandID,
      input.id,
      admission.requestedModelID ?? null,
      now,
      now,
      input.payload.text,
    );
    const admittedInput = db
      .prepare("select * from session_input where id = ?")
      .get(input.id) as unknown as SessionInputRow;
    const run = readOpenCodeAgentRun(db, input.sessionID, admission.runID);
    if (!run) throw new Error("OpenCode delegated run admission did not persist");
    db.exec("commit");
    return { input: decodeSessionInputRow(admittedInput), run, created: true };
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

/** Compare-and-set ordered event/status transition; terminal state can never be reopened. */
export async function transitionOpenCodeAgentRun(
  db: DatabaseSync,
  input: OpenCodeAgentRunTransition,
): Promise<boolean> {
  if (
    input.eventSequence !== input.expectedEventSequence + 1 ||
    !OPEN_CODE_RUN_TRANSITIONS[input.expectedStatus].includes(input.status) ||
    (input.status === "running" && !input.openCodeSessionID?.trim())
  ) {
    return false;
  }
  assertOpenCodeRunResultSize(input.resultText);
  const terminal = OPEN_CODE_RUN_TERMINAL_STATUSES.has(input.status);
  if (terminal && input.openCodeSessionID) return false;
  const now = input.now ?? Date.now();
  const result = db
    .prepare(`
    update opencode_agent_run set
      status = ?, event_sequence = ?, time_updated = ?,
      time_terminal = ?,
      opencode_session_id = ?,
      result_text = ?, stop_reason = ?, diagnostic_code = ?
    where session_id = ? and run_id = ? and status = ? and event_sequence = ?
  `)
    .run(
      input.status,
      input.eventSequence,
      now,
      terminal ? now : null,
      terminal ? null : (input.openCodeSessionID ?? null),
      input.resultText ?? null,
      input.stopReason ?? null,
      input.diagnosticCode ?? null,
      input.sessionID,
      input.runID,
      input.expectedStatus,
      input.expectedEventSequence,
    );
  return result.changes === 1;
}

/**
 * 修复依据：Host sequence 属于 Host 事件流，不能与 outbox 状态迁移共享计数，否则重启或 ACK 会让合法事件变成过期事件。
 * Accept one exact-next Host event without confusing the durable CAS revision with its sequence.
 */
export async function applyOpenCodeAgentRunHostEvent(
  db: DatabaseSync,
  input: OpenCodeAgentRunHostEventTransition,
): Promise<boolean> {
  if (
    input.eventSequence !== input.expectedEventSequence + 1 ||
    input.hostEventSequence !== input.expectedHostEventSequence + 1 ||
    !OPEN_CODE_HOST_EVENT_TRANSITIONS[input.expectedStatus].includes(input.status) ||
    (input.status === "running" && !input.openCodeSessionID?.trim())
  ) {
    return false;
  }
  assertOpenCodeRunResultSize(input.resultText);
  const terminal = OPEN_CODE_RUN_TERMINAL_STATUSES.has(input.status);
  if (terminal && input.openCodeSessionID) return false;
  const now = input.now ?? Date.now();
  db.exec("begin immediate");
  try {
    const current = readOpenCodeAgentRun(db, input.sessionID, input.runID);
    if (
      !current ||
      current.status !== input.expectedStatus ||
      current.eventSequence !== input.expectedEventSequence ||
      current.hostEventSequence !== input.expectedHostEventSequence
    ) {
      db.exec("rollback");
      return false;
    }
    let activity = decodeOpenCodeActivity(
      (
        db.prepare("select activity_json from opencode_agent_run where session_id = ? and run_id = ?")
          .get(input.sessionID, input.runID) as { activity_json: string }
      ).activity_json,
    );
    if (input.hostEvent.type === "content") {
      activity = {
        ...activity,
        outputText: appendOpenCodeOutputBounded(activity.outputText, input.hostEvent.text),
      };
    } else if (
      input.hostEvent.type === "completed" &&
      activity.outputText.length === 0 &&
      input.hostEvent.finalText
    ) {
      // Некоторые ACP сервера присылают только финальный текст без content-дельт.
      assertOpenCodeRunResultSize(input.hostEvent.finalText);
      activity = { ...activity, outputText: input.hostEvent.finalText };
    } else if (input.hostEvent.type === "tool") {
      const summary = {
        toolCallId: input.hostEvent.toolCallId,
        title: input.hostEvent.title,
        status: input.hostEvent.status,
      };
      const existingIndex = activity.tools.findIndex(
        (tool) => tool.toolCallId === summary.toolCallId,
      );
      const tools = [...activity.tools];
      if (existingIndex >= 0) tools[existingIndex] = summary;
      else if (tools.length < MAX_OPEN_CODE_RUN_TOOLS) tools.push(summary);
      activity = { ...activity, tools };
    }
    const result = db.prepare(`
    update opencode_agent_run set
      status = ?, event_sequence = ?, host_event_sequence = ?, time_updated = ?,
      time_terminal = ?,
      opencode_session_id = ?,
      result_text = ?, stop_reason = ?, diagnostic_code = ?, activity_json = ?
    where session_id = ? and run_id = ? and status = ?
      and event_sequence = ? and host_event_sequence = ?
  `).run(
      input.status,
      input.eventSequence,
      input.hostEventSequence,
      now,
      terminal ? now : null,
      terminal ? null : (input.openCodeSessionID ?? null),
      input.resultText ?? null,
      input.stopReason ?? null,
      input.diagnosticCode ?? null,
      JSON.stringify(activity),
      input.sessionID,
      input.runID,
      input.expectedStatus,
      input.expectedEventSequence,
      input.expectedHostEventSequence,
    );
    if (result.changes !== 1) {
      db.exec("rollback");
      return false;
    }
    db.exec("commit");
    return true;
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

export async function getOpenCodeAgentRun(
  db: DatabaseSync,
  input: { sessionID: SessionId; runID: string },
): Promise<OpenCodeAgentRunRecord | null> {
  return readOpenCodeAgentRun(db, input.sessionID, input.runID);
}

export async function listOpenCodeAgentRuns(
  db: DatabaseSync,
  input: { sessionID: SessionId; statuses?: OpenCodeAgentRunStatus[]; limit?: number },
): Promise<OpenCodeAgentRunRecord[]> {
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)));
  const statuses = input.statuses?.length ? input.statuses : undefined;
  const rows = statuses
    ? db
        .prepare(
          `select * from opencode_agent_run where session_id = ? and status in (${statuses.map(() => "?").join(",")}) order by time_created, run_id limit ?`,
        )
        .all(input.sessionID, ...statuses, limit)
    : db
        .prepare(
          "select * from opencode_agent_run where session_id = ? order by time_created, run_id limit ?",
        )
        .all(input.sessionID, limit);
  return (rows as unknown as OpenCodeAgentRunRow[]).map(decodeOpenCodeAgentRunRow);
}

export async function listPendingOpenCodeAgentRuns(
  db: DatabaseSync,
  input: { limit?: number } = {},
): Promise<OpenCodeAgentRunRecord[]> {
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)));
  const rows = db
    .prepare(
      "select * from opencode_agent_run where status = 'pending' order by time_created, run_id limit ?",
    )
    .all(limit);
  return (rows as unknown as OpenCodeAgentRunRow[]).map(decodeOpenCodeAgentRunRow);
}

/** Settle every unresolved run on startup; no ACP session is resumed or recreated. */
export async function recoverOpenCodeAgentRuns(
  db: DatabaseSync,
  input: { now?: number; diagnosticCode?: string } = {},
): Promise<OpenCodeAgentRunRecord[]> {
  const now = input.now ?? Date.now();
  const diagnosticCode = input.diagnosticCode ?? "opencode.run-interrupted-after-restart";
  db.exec("begin immediate");
  try {
    const unresolved = db
      .prepare(`
      select session_id, run_id from opencode_agent_run
      where status in ('pending', 'dispatching', 'running')
      order by session_id, run_id
    `)
      .all() as Array<{ session_id: string; run_id: string }>;
    db.prepare(`
      update opencode_agent_run set
        status = 'interrupted', event_sequence = event_sequence + 1,
        time_updated = ?, time_terminal = ?, opencode_session_id = null,
        diagnostic_code = coalesce(diagnostic_code, ?)
      where status in ('pending', 'dispatching', 'running')
    `).run(now, now, diagnosticCode);
    const read = db.prepare("select * from opencode_agent_run where session_id = ? and run_id = ?");
    const rows = unresolved
      .map(
        ({ session_id, run_id }) =>
          read.get(session_id, run_id) as unknown as OpenCodeAgentRunRow | undefined,
      )
      .filter((row): row is OpenCodeAgentRunRow => row !== undefined);
    db.exec("commit");
    return rows.map(decodeOpenCodeAgentRunRow);
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

export async function saveSessionInput(
  db: DatabaseSync,
  input: {
    id: string;
    sessionID: SessionId;
    kind: string;
    delivery: SessionInputDelivery;
    payload: { text: string; [key: string]: unknown };
  },
): Promise<void> {
  const now = Date.now();
  // admitted_sequence 按 session 内账本单调分配；同 id 重入会用 runtime 的实际
  // kind/delivery/payload 修正执行前预 admission，同时保留原序与状态（幂等）。
  db.prepare(
    `
      insert into session_input (
        id, session_id, kind, delivery, payload,
        admitted_sequence, status, time_created, time_updated
      )
      values (
        ?, ?, ?, ?, ?,
        (
          select coalesce(max(admitted_sequence), -1) + 1
          from session_input
          where session_id = ?
        ),
        'admitted', ?, ?
      )
      on conflict(id) do update set
        kind = excluded.kind,
        delivery = excluded.delivery,
        payload = excluded.payload,
        time_updated = excluded.time_updated
      `,
  ).run(
    input.id,
    input.sessionID,
    input.kind,
    input.delivery,
    encodeJson(input.payload) ?? "{}",
    input.sessionID,
    now,
    now,
  );
}

function decodePayload(raw: string): { text: string; [key: string]: unknown } {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? ({ text: "", ...(parsed as Record<string, unknown>) } as {
          text: string;
          [key: string]: unknown;
        })
      : { text: "" };
  } catch {
    return { text: "" };
  }
}

interface SessionInputPatch {
  delivery?: SessionInputDelivery;
  id: string;
  intent?: TurnInputIntentMetadata;
  text?: string;
  queuePosition?: number;
}

function patchObject(value: unknown, patch: SessionInputPatch): unknown {
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

/** queue edit/reorder 必须同步更新 durable intent，避免 CLI restart 后恢复旧 payload。 */
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
              ...(contextMessage.info.metadata ?? {}),
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

function decodeSessionInputRow(row: SessionInputRow): SessionInputRecord {
  const payload = decodePayload(row.payload);
  return {
    id: row.id,
    sessionID: row.session_id as SessionId,
    kind: row.kind,
    delivery:
      row.delivery === "startNow" || row.delivery === "guide" || row.delivery === "queue"
        ? row.delivery
        : "queue",
    payload,
    admittedSequence: row.admitted_sequence,
    ...(row.promoted_sequence !== null ? { promotedSequence: row.promoted_sequence } : {}),
    ...(row.promoted_message_id !== null
      ? { promotedMessageID: row.promoted_message_id as SessionInputRecord["promotedMessageID"] }
      : {}),
    status: (["admitted", "promoted", "cancelled", "discarded", "failed"].includes(row.status)
      ? row.status
      : "admitted") as SessionInputStatus,
    ...(row.status_reason !== null ? { statusReason: row.status_reason } : {}),
    time: { created: row.time_created, updated: row.time_updated },
  };
}
