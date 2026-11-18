// ============================================================
// PtySession Tool - Interactive terminal sessions for the agent
// ============================================================
//
// Инструмент покрывает то, чего не умеет Bash: визарды, REPL, dev-серверы.
// Действия взаимоисключающие, поэтому вход — discriminated union: неверная
// комбинация полей отсекается схемой до handler-а, а не внутри него.

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const PTY_SESSION_TOOL_NAME = "PtySession";

/** Размер терминала ограничен, чтобы модель не могла заказать гигантский экран. */
const MAX_COLS = 400;
const MAX_ROWS = 200;
const MAX_WRITE_CHARS = 16_384;
const MAX_WAIT_MS = 120_000;
const MAX_READ_CHUNKS = 500;

const sessionIdSchema = z.string().trim().min(1).max(128);

const startActionSchema = z
  .object({
    action: z.literal("start"),
    /** Каталог запуска; должен лежать внутри workspace. */
    cwd: z.string().trim().min(1).max(4096).optional(),
    /** Shell по умолчанию — пользовательский, иначе /bin/sh. */
    shell: z.string().trim().min(1).max(4096).optional(),
    args: z.array(z.string().max(4096)).max(64).optional(),
    cols: z.number().int().min(1).max(MAX_COLS).optional(),
    rows: z.number().int().min(1).max(MAX_ROWS).optional(),
    env: z.record(z.string().max(256), z.string().max(8192)).optional(),
    /** `off` запускает shell без песочницы; по умолчанию — workspace-write. */
    sandboxProfile: z.enum(["off", "workspace-write", "strict-offline"]).optional(),
    networkAccess: z.enum(["allow", "deny"]).optional(),
  })
  .strict();

const writeActionSchema = z
  .object({
    action: z.literal("write"),
    sessionId: sessionIdSchema,
    data: z.string().min(1).max(MAX_WRITE_CHARS),
  })
  .strict();

const readActionSchema = z
  .object({
    action: z.literal("read"),
    sessionId: sessionIdSchema,
    /** Читать строго после этого seq; отсутствие — весь доступный буфер. */
    sinceSeq: z.number().int().min(0).optional(),
  })
  .strict();

const waitActionSchema = z
  .object({
    action: z.literal("wait"),
    sessionId: sessionIdSchema,
    pattern: z.string().min(1).max(2048).optional(),
    idleMs: z.number().int().min(20).max(60_000).optional(),
    exitCode: z.number().int().min(0).max(255).optional(),
    timeoutMs: z.number().int().min(1).max(MAX_WAIT_MS).optional(),
  })
  .strict();

const resizeActionSchema = z
  .object({
    action: z.literal("resize"),
    sessionId: sessionIdSchema,
    cols: z.number().int().min(1).max(MAX_COLS),
    rows: z.number().int().min(1).max(MAX_ROWS),
  })
  .strict();

const killActionSchema = z
  .object({
    action: z.literal("kill"),
    sessionId: sessionIdSchema,
    signal: z.string().trim().min(1).max(32).optional(),
    graceMs: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

const listActionSchema = z.object({ action: z.literal("list") }).strict();

export const PtySessionInputSchema = z.discriminatedUnion("action", [
  startActionSchema,
  writeActionSchema,
  readActionSchema,
  waitActionSchema,
  resizeActionSchema,
  killActionSchema,
  listActionSchema,
]);

export type PtySessionInput = z.infer<typeof PtySessionInputSchema>;
export type PtySessionStartInput = z.infer<typeof startActionSchema>;
export type PtySessionWriteInput = z.infer<typeof writeActionSchema>;
export type PtySessionReadInput = z.infer<typeof readActionSchema>;
export type PtySessionWaitInput = z.infer<typeof waitActionSchema>;
export type PtySessionResizeInput = z.infer<typeof resizeActionSchema>;
export type PtySessionKillInput = z.infer<typeof killActionSchema>;
export type PtySessionListInput = z.infer<typeof listActionSchema>;

export const PtySessionInputJsonSchema = toToolJsonSchema(PtySessionInputSchema);

/** Структурированный вывод: всегда сессия + то, что вернуло действие. */
export const PtySessionOutputSchema = z.object({
  action: z.enum(["start", "write", "read", "wait", "resize", "kill", "list"]),
  session: z
    .object({
      sessionId: z.string(),
      status: z.enum(["running", "exited", "killed"]),
      pid: z.number().int().nonnegative(),
      cwd: z.string(),
      shell: z.string(),
      cols: z.number().int(),
      rows: z.number().int(),
      sandboxMode: z.enum(["bwrap", "seatbelt", "degraded", "none"]),
      sandboxReason: z.string().optional(),
      exitCode: z.number().int().optional(),
      signal: z.number().int().optional(),
      lastSeq: z.number().int().nonnegative(),
      firstSeq: z.number().int().nonnegative(),
      truncatedBytes: z.number().int().nonnegative(),
    })
    .optional(),
  sessions: z
    .array(
      z.object({
        sessionId: z.string(),
        status: z.enum(["running", "exited", "killed"]),
        pid: z.number().int().nonnegative(),
        sandboxMode: z.enum(["bwrap", "seatbelt", "degraded", "none"]),
      }),
    )
    .optional(),
  /** Дельта вывода, уже очищенная от ANSI. */
  chunks: z
    .array(
      z.object({
        seq: z.number().int().positive(),
        text: z.string(),
        at: z.number().int().nonnegative(),
      }),
    )
    .max(MAX_READ_CHUNKS)
    .optional(),
  /** `true`, если `sinceSeq` старше буфера и часть вывода потеряна. */
  truncatedFrom: z.number().int().nonnegative().optional(),
  matched: z.enum(["pattern", "idle", "exit", "timeout"]).optional(),
  match: z.string().optional(),
  /** Причина отказа действия; присутствует только при неуспехе. */
  error: z.string().optional(),
});

export type PtySessionOutput = z.infer<typeof PtySessionOutputSchema>;

export const PtySessionOutputJsonSchema = toToolJsonSchema(PtySessionOutputSchema);

export const PTY_SESSION_DESCRIPTION = [
  "Manage interactive terminal sessions (PTY) for wizards, REPLs, dev servers and DB clients.",
  "",
  "- `start` launches a shell using the session sandbox policy (which the user may disable) and returns `sessionId`, `pid` and `sandboxMode`.",
  "- `write` sends text or control bytes to stdin (`\\r` for Enter, `\\u0003` for Ctrl+C, `\\u0004` for Ctrl+D).",
  "- `read` returns only output newer than `sinceSeq`, with a monotonic `seq` per chunk; ANSI escapes are stripped and reported separately.",
  "- `wait` blocks until a regex matches, output goes idle, a specific exit code appears, or the timeout expires.",
  "- `kill` terminates the whole process tree of the session; `list` shows every session and its sandbox mode.",
  "",
  "Sessions are bounded (4 by default) and idle sessions close automatically. Prefer Bash for one-shot commands.",
].join("\n");
