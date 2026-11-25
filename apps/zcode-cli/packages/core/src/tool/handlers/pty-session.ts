// ============================================================
// PtySession Tool Handler
// ============================================================
//
// Тонкий маппинг действий инструмента на `AgentPtyManager`. Вся семантика
// (буфер, seq, песочница, дерево процессов) живёт в adapters; здесь — только
// валидация границ workspace, разрешение сессии и проекция в модель.

import {
  CoreErrorType,
  PTY_SESSION_DESCRIPTION,
  PTY_SESSION_TOOL_NAME,
  PtySessionInputJsonSchema,
  PtySessionInputSchema,
  PtySessionOutputJsonSchema,
  PtySessionOutputSchema,
  createCoreError,
  type PtySessionInput,
  type PtySessionOutput,
} from "@zcode/contracts";
import { isPathWithinWorkspaceRoot } from "../path-policy.js";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

const PTY_TOOL_TIMEOUT_MS = 120_000;
const PTY_MODEL_BYTES = 32_000;

/** Порт, который обязан предоставить runtime: иначе инструмент не регистрируется. */
export interface PtySessionPort {
  create(options: {
    cwd: string;
    workspacePath: string;
    shell?: string;
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
    cols?: number;
    rows?: number;
    sandbox?: { profile?: "off" | "workspace-write" | "strict-offline"; networkAccess?: "allow" | "deny" };
  }): Promise<{
    sessionId: string;
    status: "running" | "exited" | "killed";
    pid: number;
    cwd: string;
    shell: string;
    cols: number;
    rows: number;
    sandboxMode: "bwrap" | "seatbelt" | "degraded" | "none";
    sandboxReason?: string;
    exitCode?: number;
    signal?: number;
    lastSeq: number;
    firstSeq: number;
    truncatedBytes: number;
  }>;
  write(sessionId: string, data: string): Promise<void>;
  resize(sessionId: string, cols: number, rows: number): Promise<void>;
  read(
    sessionId: string,
    options?: { sinceSeq?: number },
  ): Promise<{
    session: PtySessionSnapshot;
    chunks: readonly { seq: number; text: string; at: number }[];
    truncatedFrom?: number;
  }>;
  waitFor(
    sessionId: string,
    options: {
      pattern?: string;
      idleMs?: number;
      exitCode?: number;
      timeoutMs?: number;
    },
  ): Promise<{
    session: PtySessionSnapshot;
    matched: "pattern" | "idle" | "exit" | "timeout";
    chunks: readonly { seq: number; text: string; at: number }[];
    match?: string;
  }>;
  kill(
    sessionId: string,
    options?: { signal?: string; graceMs?: number },
  ): Promise<PtySessionSnapshot>;
  list(): readonly PtySessionSnapshot[];
}

type PtySessionSnapshot = PtySessionOutput["session"] extends infer T
  ? NonNullable<T>
  : never;

function requirePtyPort(context: ToolExecutionContext): PtySessionPort {
  const port = context.ptySessionPort;
  if (!port) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "PTY session port is not configured for PtySession tool",
      {
        context: { toolCallId: context.toolCallId, toolName: PTY_SESSION_TOOL_NAME },
        recoverable: false,
      },
    );
  }
  return port;
}

/** cwd обязан оставаться внутри workspace: иначе песочница теряет границу. */
function resolvePtyCwd(input: PtySessionInput, context: ToolExecutionContext): string {
  const workspaceRoot = context.workspaceRoot || context.workingDirectory;
  const requested = "cwd" in input ? input.cwd : undefined;
  const cwd = requested ?? context.workingDirectory;
  if (!isPathWithinWorkspaceRoot(cwd, workspaceRoot)) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `PtySession cwd must stay inside the workspace: ${cwd}`,
      {
        context: { toolCallId: context.toolCallId, toolName: PTY_SESSION_TOOL_NAME },
        recoverable: true,
      },
    );
  }
  return cwd;
}

function projectSession(
  session: PtySessionSnapshot,
): NonNullable<PtySessionOutput["session"]> {
  return {
    sessionId: session.sessionId,
    status: session.status,
    pid: session.pid,
    cwd: session.cwd,
    shell: session.shell,
    cols: session.cols,
    rows: session.rows,
    sandboxMode: session.sandboxMode,
    ...(session.sandboxReason ? { sandboxReason: session.sandboxReason } : {}),
    ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
    ...(session.signal !== undefined ? { signal: session.signal } : {}),
    lastSeq: session.lastSeq,
    firstSeq: session.firstSeq,
    truncatedBytes: session.truncatedBytes,
  };
}

function projectChunks(
  chunks: readonly { seq: number; text: string; at: number }[],
): NonNullable<PtySessionOutput["chunks"]> {
  return chunks.map((chunk) => ({ seq: chunk.seq, text: chunk.text, at: chunk.at }));
}

async function executePtySession(
  input: unknown,
  context: ToolExecutionContext,
): Promise<PtySessionOutput> {
  const parsed = PtySessionInputSchema.parse(input) as PtySessionInput;
  const port = requirePtyPort(context);

  try {
    switch (parsed.action) {
      case "start": {
        const cwd = resolvePtyCwd(parsed, context);
        const session = await port.create({
          cwd,
          workspacePath: context.workspaceRoot || cwd,
          ...(parsed.shell ? { shell: parsed.shell } : {}),
          ...(parsed.args ? { args: parsed.args } : {}),
          ...(parsed.env ? { env: parsed.env } : {}),
          ...(parsed.cols !== undefined ? { cols: parsed.cols } : {}),
          ...(parsed.rows !== undefined ? { rows: parsed.rows } : {}),
          sandbox: {
            profile:
              parsed.sandboxProfile ??
              (context.bashSandboxMode === "off" ? "off" : "workspace-write"),
            networkAccess:
              parsed.networkAccess ?? (context.bashSandboxNetwork === "deny" ? "deny" : "allow"),
          },
        });
        return PtySessionOutputSchema.parse({
          action: "start",
          session: projectSession(session as PtySessionSnapshot),
        });
      }
      case "write": {
        await port.write(parsed.sessionId, parsed.data);
        const [session] = port.list().filter((item) => item.sessionId === parsed.sessionId);
        return PtySessionOutputSchema.parse({
          action: "write",
          ...(session ? { session: projectSession(session) } : {}),
        });
      }
      case "read": {
        const result = await port.read(
          parsed.sessionId,
          parsed.sinceSeq !== undefined ? { sinceSeq: parsed.sinceSeq } : {},
        );
        return PtySessionOutputSchema.parse({
          action: "read",
          session: projectSession(result.session),
          chunks: projectChunks(result.chunks),
          ...(result.truncatedFrom !== undefined ? { truncatedFrom: result.truncatedFrom } : {}),
        });
      }
      case "wait": {
        const result = await port.waitFor(parsed.sessionId, {
          ...(parsed.pattern !== undefined ? { pattern: parsed.pattern } : {}),
          ...(parsed.idleMs !== undefined ? { idleMs: parsed.idleMs } : {}),
          ...(parsed.exitCode !== undefined ? { exitCode: parsed.exitCode } : {}),
          ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
        });
        return PtySessionOutputSchema.parse({
          action: "wait",
          session: projectSession(result.session),
          matched: result.matched,
          chunks: projectChunks(result.chunks),
          ...(result.match !== undefined ? { match: result.match } : {}),
        });
      }
      case "resize": {
        await port.resize(parsed.sessionId, parsed.cols, parsed.rows);
        const [session] = port.list().filter((item) => item.sessionId === parsed.sessionId);
        return PtySessionOutputSchema.parse({
          action: "resize",
          ...(session ? { session: projectSession(session) } : {}),
        });
      }
      case "kill": {
        const session = await port.kill(parsed.sessionId, {
          ...(parsed.signal !== undefined ? { signal: parsed.signal } : {}),
          ...(parsed.graceMs !== undefined ? { graceMs: parsed.graceMs } : {}),
        });
        return PtySessionOutputSchema.parse({
          action: "kill",
          session: projectSession(session),
        });
      }
      case "list": {
        return PtySessionOutputSchema.parse({
          action: "list",
          sessions: port.list().map((session) => ({
            sessionId: session.sessionId,
            status: session.status,
            pid: session.pid,
            sandboxMode: session.sandboxMode,
          })),
        });
      }
    }
  } catch (error) {
    // Ошибки действия возвращаются моделью-видимым результатом, а не падением:
    // агент должен увидеть причину и исправить вход, не теряя сессии.
    return PtySessionOutputSchema.parse({
      action: parsed.action,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export const ptySessionHandler: ToolHandler = (input, context) =>
  executePtySession(input, context);

export const ptySessionToolEntry: ToolEntry = {
  capability: "Run and control interactive PTY sessions for wizards, REPLs and dev servers",
  metadata: {
    name: PTY_SESSION_TOOL_NAME,
    description: PTY_SESSION_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: PTY_TOOL_TIMEOUT_MS,
    maxOutputBytes: PTY_MODEL_BYTES,
    sideEffectScope: "system",
    riskLevel: "medium",
    needsApproval: true,
    // The schema is large and the tool is rarely needed; keep it behind ToolSearch.
    shouldDefer: true,
  },
  handler: ptySessionHandler,
  inputSchema: PtySessionInputJsonSchema,
  outputSchema: PtySessionOutputJsonSchema,
  runtimeInputSchema: PtySessionInputSchema,
  runtimeOutputSchema: PtySessionOutputSchema,
  resolvePermissionCapability: () => ({
    destructive: false,
    needsApproval: true,
    riskLevel: "medium",
    sideEffectScope: "system",
    permission: {
      needsApproval: true,
      riskLevel: "medium",
      sideEffectScope: "system",
    },
  }),
  permission: {
    permission: "bash",
    reason: "PtySession spawns shells and can affect workspace, git, network, or system state",
    riskLevel: "medium",
    sideEffectScope: "system",
    needsApproval: true,
    patternSources: ["path"],
    alwaysAllowPatternSources: [],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: PTY_MODEL_BYTES,
    maxModelBytes: PTY_MODEL_BYTES,
    strategy: "truncate",
  },
  timeout: {
    defaultMs: PTY_TOOL_TIMEOUT_MS,
    maxMs: PTY_TOOL_TIMEOUT_MS,
    allowCallOverride: true,
    cleanupGraceMs: 2_000,
  },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage: "PtySession was cancelled and its process tree was terminated",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
