// session_input 账本仓库。
// 语义：admitted（已接受）→ promoted（与 user message/parts 同事务落 transcript）
// / cancelled / discarded / failed。promotion 的原子性是硬要求：杜绝
// 「queue 已消费但 transcript 无 user message」的孤儿窗口（旧 drain 跨 store 无事务）。
import type { DatabaseSync } from "node:sqlite";
import type { OpenCodeAgentRunAdmission, OpenCodeAgentRunHostEventTransition, OpenCodeAgentRunRecord, OpenCodeAgentRunStatus, OpenCodeAgentRunTransition, AgentTaskGraph, SwarmNodeAttemptRecord, SwarmNodeAttemptStatus, SwarmRunRecord, SwarmRunStatus, SessionId, SessionInputDelivery, SessionInputRecord, SessionInputStatus, TurnInputIntentMetadata } from "@zcode/contracts";
import { AgentTaskGraphSchema } from "@zcode/contracts";
import { encodeJson } from "../json.js";


export interface SessionInputRow {
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

export interface SwarmRunRow {
  schema_version: number;
  root_session_id: string;
  source_command_id: string;
  run_id: string;
  root_turn_id: string;
  graph_json: string | null;
  status: string;
  owner_epoch: number;
  revision: number;
  time_created: number;
  time_updated: number;
  time_terminal: number | null;
  diagnostic_code: string | null;
}

export interface SwarmNodeAttemptRow {
  schema_version: number;
  run_id: string;
  node_id: string;
  attempt_id: string;
  attempt_no: number;
  status: string;
  child_session_id: string;
  owner_epoch: number;
  revision: number;
  time_created: number;
  time_updated: number;
  time_terminal: number | null;
  result_text: string | null;
  diagnostic_code: string | null;
}

export const SWARM_TERMINAL_RUN_STATUSES = new Set<SwarmRunStatus>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export const SWARM_TERMINAL_ATTEMPT_STATUSES = new Set<SwarmNodeAttemptStatus>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "blocked",
]);
const MAX_SWARM_GRAPH_BYTES = 120_000;
export const MAX_SWARM_RESULT_BYTES = 32 * 1024;
const MAX_SWARM_DIAGNOSTIC_BYTES = 512;
export const SWARM_RUN_STATUSES: readonly SwarmRunStatus[] = [
  "planning",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];
export const SWARM_ATTEMPT_STATUSES: readonly SwarmNodeAttemptStatus[] = [
  "pending",
  "dispatching",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "blocked",
];

export function assertSwarmDiagnosticSize(value: string | null | undefined): void {
  if (value != null && Buffer.byteLength(value, "utf8") > MAX_SWARM_DIAGNOSTIC_BYTES) {
    throw new Error("Swarm diagnostic code exceeds its bounded snapshot size");
  }
}

export function validateSwarmGraph(graph: AgentTaskGraph): string {
  const parsed = AgentTaskGraphSchema.parse(graph);
  const encoded = JSON.stringify(parsed);
  if (Buffer.byteLength(encoded, "utf8") > MAX_SWARM_GRAPH_BYTES) {
    throw new Error("Swarm graph exceeds its bounded snapshot size");
  }
  return encoded;
}

export function decodeSwarmRunRow(row: SwarmRunRow): SwarmRunRecord {
  if (row.schema_version !== 1 || !SWARM_RUN_STATUSES.includes(row.status as SwarmRunStatus)) {
    throw new Error("Invalid persisted Swarm run record");
  }
  const graph = row.graph_json === null ? undefined : AgentTaskGraphSchema.parse(JSON.parse(row.graph_json));
  if (row.graph_json !== null && Buffer.byteLength(row.graph_json, "utf8") > MAX_SWARM_GRAPH_BYTES) {
    throw new Error("Persisted Swarm graph exceeds its bounded snapshot size");
  }
  assertSwarmDiagnosticSize(row.diagnostic_code);
  return {
    schemaVersion: 1,
    rootSessionID: row.root_session_id as SessionId,
    sourceCommandID: row.source_command_id,
    runID: row.run_id,
    rootTurnID: row.root_turn_id as SwarmRunRecord["rootTurnID"],
    ...(graph ? { graph } : {}),
    status: row.status as SwarmRunStatus,
    ownerEpoch: row.owner_epoch,
    revision: row.revision,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      ...(row.time_terminal === null ? {} : { terminal: row.time_terminal }),
    },
    ...(row.diagnostic_code === null ? {} : { diagnosticCode: row.diagnostic_code }),
  };
}

export function decodeSwarmAttemptRow(row: SwarmNodeAttemptRow): SwarmNodeAttemptRecord {
  if (
    row.schema_version !== 1 ||
    !SWARM_ATTEMPT_STATUSES.includes(row.status as SwarmNodeAttemptStatus)
  ) {
    throw new Error("Invalid persisted Swarm node attempt");
  }
  if (row.result_text !== null && Buffer.byteLength(row.result_text, "utf8") > MAX_SWARM_RESULT_BYTES) {
    throw new Error("Persisted Swarm node result exceeds its bounded snapshot size");
  }
  assertSwarmDiagnosticSize(row.diagnostic_code);
  return {
    schemaVersion: 1,
    runID: row.run_id,
    nodeID: row.node_id,
    attemptID: row.attempt_id,
    attemptNo: row.attempt_no,
    status: row.status as SwarmNodeAttemptStatus,
    childSessionID: row.child_session_id as SessionId,
    ownerEpoch: row.owner_epoch,
    revision: row.revision,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      ...(row.time_terminal === null ? {} : { terminal: row.time_terminal }),
    },
    ...(row.result_text === null ? {} : { resultText: row.result_text }),
    ...(row.diagnostic_code === null ? {} : { diagnosticCode: row.diagnostic_code }),
  };
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


export interface SessionInputPatch {
  delivery?: SessionInputDelivery;
  id: string;
  intent?: TurnInputIntentMetadata;
  text?: string;
  queuePosition?: number;
}


export function decodePayload(raw: string): { text: string; [key: string]: unknown } {
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
/** queue edit/reorder 必须同步更新 durable intent，避免 CLI restart 后恢复旧 payload。 */

export function decodeSessionInputRow(row: SessionInputRow): SessionInputRecord {
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

export {

  patchObject,
  updateSessionInputs,
  promoteSessionInput,
  markSessionInputPromoted,
  settleSessionInput,
  listSessionInputs,
  getSessionInputById,
  readSwarmRun,
  readSwarmRunBySource,
  admitSwarmRun,
  getSwarmRun,
  findSwarmRunBySourceCommand,
  boundedLimit,
  listSwarmRuns,
  commitSwarmRunGraph,
  transitionSwarmRun,
  claimSwarmRunOwner,
  readSwarmAttempt,
  reserveSwarmNodeAttempt,
  transitionSwarmNodeAttempt,
  listSwarmNodeAttempts,
  listRecoverableSwarmRuns,
} from "./session-inputs-ledger.js";
