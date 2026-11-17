import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  SessionEventType,
  type Logger,
  type SessionEvent,
  type SubagentExecutionBudget,
  type SubagentIsolationMode,
  type TraceContext,
} from "@zcode/contracts";
import type { IFileLockRegistry } from "../../../tool/file-transaction/contract.js";

const execFileAsync = promisify(execFileCallback);

export const DEFAULT_MAX_IDENTICAL_SUBAGENT_TOOL_ERRORS = 3;

export interface SubagentGuardTermination {
  readonly code:
    | "SUBAGENT_INPUT_TOKEN_BUDGET_EXHAUSTED"
    | "SUBAGENT_WALL_TIME_BUDGET_EXHAUSTED"
    | "SUBAGENT_IDENTICAL_TOOL_ERROR_LOOP";
  readonly detail: string;
  readonly kind: "budget_exhausted" | "loop_detected";
}

export interface SubagentExecutionGuard {
  readonly observedEvents: SessionEvent[];
  readonly signal: AbortSignal;
  readonly touchedFiles: ReadonlySet<string>;
  buildStructuredTerminationResponse(partialText?: string): string;
  dispose(): void;
  getTermination(): SubagentGuardTermination | undefined;
  observeEvent(event: SessionEvent): void;
}

export function createSubagentExecutionGuard(input: {
  readonly agentId: string;
  readonly budget?: SubagentExecutionBudget;
  readonly logger?: Logger;
  readonly maxIdenticalToolErrors?: number;
  readonly parentSignal?: AbortSignal;
}): SubagentExecutionGuard {
  const controller = new AbortController();
  const observedEvents: SessionEvent[] = [];
  const touchedFiles = new Set<string>();
  const toolNameByCallId = new Map<string, string>();
  const maxIdenticalErrors = Math.max(
    2,
    Math.floor(input.maxIdenticalToolErrors ?? DEFAULT_MAX_IDENTICAL_SUBAGENT_TOOL_ERRORS),
  );

  let termination: SubagentGuardTermination | undefined;
  let cumulativeInputTokens = 0;
  let lastErrorSignature: string | undefined;
  let consecutiveIdenticalErrors = 0;
  let wallTimer: ReturnType<typeof setTimeout> | undefined;

  const onParentAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(input.parentSignal?.reason ?? new Error("Parent aborted subagent"));
    }
  };
  if (input.parentSignal) {
    if (input.parentSignal.aborted) {
      onParentAbort();
    } else {
      input.parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }
  }

  const triggerTermination = (next: SubagentGuardTermination) => {
    if (termination || input.parentSignal?.aborted) return;
    termination = next;
    input.logger?.warn("Subagent execution guard tripped", {
      agentId: input.agentId,
      code: next.code,
      detail: next.detail,
      event: "subagent.execution_guard.tripped",
      kind: next.kind,
      module: "core.subagent",
    });
    if (!controller.signal.aborted) {
      controller.abort(new Error(`[${next.code}] ${next.detail}`));
    }
  };

  const maxWallTimeMs = input.budget?.maxWallTimeMs;
  if (maxWallTimeMs !== undefined && Number.isFinite(maxWallTimeMs) && maxWallTimeMs > 0) {
    wallTimer = setTimeout(() => {
      triggerTermination({
        code: "SUBAGENT_WALL_TIME_BUDGET_EXHAUSTED",
        detail: `Subagent wall-time budget (${Math.floor(maxWallTimeMs)}ms) exhausted.`,
        kind: "budget_exhausted",
      });
    }, Math.floor(maxWallTimeMs));
  }

  return {
    observedEvents,
    signal: controller.signal,
    touchedFiles,
    getTermination: () => termination,
    observeEvent(event: SessionEvent) {
      observedEvents.push(event);
      const payload = asRecord(event.payload);
      if (!payload) return;

      if (event.type === SessionEventType.ModelComplete) {
        const usage = asRecord(payload.usage);
        const stepInput = typeof usage?.inputTokens === "number" ? usage.inputTokens : 0;
        cumulativeInputTokens += Math.max(0, stepInput);
        const fileChanges = asRecord(payload.fileChanges);
        const files = Array.isArray(fileChanges?.files) ? fileChanges.files : [];
        for (const item of files) {
          const path = typeof asRecord(item)?.path === "string" ? String(asRecord(item)!.path) : "";
          if (path) touchedFiles.add(path);
        }
        const maxInputTokens = input.budget?.maxInputTokens;
        if (
          maxInputTokens !== undefined &&
          Number.isFinite(maxInputTokens) &&
          maxInputTokens > 0 &&
          cumulativeInputTokens > maxInputTokens
        ) {
          triggerTermination({
            code: "SUBAGENT_INPUT_TOKEN_BUDGET_EXHAUSTED",
            detail: `Subagent cumulative input token budget (${cumulativeInputTokens} > ${maxInputTokens}) exhausted.`,
            kind: "budget_exhausted",
          });
        }
        return;
      }

      if (event.type === SessionEventType.ToolCallScheduled) {
        const callId = typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
        const toolName = typeof payload.toolName === "string" ? payload.toolName : undefined;
        if (callId && toolName) {
          toolNameByCallId.set(callId, toolName);
        }
        return;
      }

      if (event.type === SessionEventType.ToolCallResult) {
        consecutiveIdenticalErrors = 0;
        lastErrorSignature = undefined;
        return;
      }

      if (event.type === SessionEventType.ToolCallError) {
        const callId = typeof payload.toolCallId === "string" ? payload.toolCallId : "";
        const toolName =
          (typeof payload.toolName === "string" ? payload.toolName : undefined) ??
          toolNameByCallId.get(callId) ??
          "unknown";
        const errorObj = asRecord(payload.error);
        const errorMsg = normalizeErrorSignatureText(
          (typeof errorObj?.message === "string" ? errorObj.message : undefined) ??
            (typeof payload.message === "string" ? payload.message : "tool_error"),
        );
        const signature = `${toolName}\u0000${errorMsg}`;
        if (signature === lastErrorSignature) {
          consecutiveIdenticalErrors += 1;
        } else {
          lastErrorSignature = signature;
          consecutiveIdenticalErrors = 1;
        }
        if (consecutiveIdenticalErrors >= maxIdenticalErrors) {
          triggerTermination({
            code: "SUBAGENT_IDENTICAL_TOOL_ERROR_LOOP",
            detail: `Loop detected: tool "${toolName}" failed ${consecutiveIdenticalErrors} consecutive times with identical error: ${errorMsg}`,
            kind: "loop_detected",
          });
        }
      }
    },
    buildStructuredTerminationResponse(partialText = ""): string {
      const active = termination;
      const summary = active
        ? `[${active.code}] ${active.detail}`
        : "Subagent stopped by execution guard.";
      const workResultPayload = {
        claims: [],
        evidence: [],
        files: [...touchedFiles],
        status: "failed",
        summary: summary.slice(0, 1_000),
        tests: [],
        unresolved: [summary],
      };
      const prefix = partialText.trim() ? `${partialText.trim()}\n\n` : "";
      return `${prefix}${summary}\n\n<zcode-work-result>\n${JSON.stringify(workResultPayload)}\n</zcode-work-result>`;
    },
    dispose() {
      if (wallTimer !== undefined) {
        clearTimeout(wallTimer);
        wallTimer = undefined;
      }
      input.parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

export async function withOptionalGitWorktreeIsolation<T extends { response: string }>(input: {
  readonly agentId: string;
  readonly fileLockRegistry: IFileLockRegistry;
  readonly isolationMode?: SubagentIsolationMode;
  readonly logger?: Logger;
  readonly runScopeId: string;
  readonly signal?: AbortSignal;
  readonly traceContext: TraceContext;
  readonly workingDirectory: string;
  readonly workspaceIdentity?: string;
  readonly workspaceRoot: string;
  readonly execute: (paths: { workingDirectory: string; workspaceRoot: string }) => Promise<T>;
}): Promise<T> {
  if (input.isolationMode !== "git-worktree") {
    return input.execute({
      workingDirectory: input.workingDirectory,
      workspaceRoot: input.workspaceRoot,
    });
  }

  const rootDir = resolve(input.workspaceRoot);
  const safeRunScope = sanitizePathSegment(input.runScopeId || "swarm");
  const safeNodeId = sanitizePathSegment(input.agentId || "node");
  const worktreeDir = join(rootDir, ".zcode", "worktrees", safeRunScope, safeNodeId);

  let worktreeCreated = false;
  try {
    await ensureWorktreeGitExclude(rootDir);
    await mkdir(dirname(worktreeDir), { recursive: true });
    await execGit(["worktree", "add", "--force", "--detach", worktreeDir, "HEAD"], rootDir);
    worktreeCreated = true;

    const result = await input.execute({
      workingDirectory: worktreeDir,
      workspaceRoot: worktreeDir,
    });

    const mergeNote = await mergeWorktreeChangesUnderLock({
      agentId: input.agentId,
      fileLockRegistry: input.fileLockRegistry,
      rootDir,
      signal: input.signal,
      workspaceIdentity: input.workspaceIdentity,
      worktreeDir,
    });
    if (!mergeNote) {
      return result;
    }
    return {
      ...result,
      response: `${result.response}\n\n${mergeNote}`,
    };
  } catch (error) {
    if (!worktreeCreated) {
      input.logger?.warn("Git worktree isolation unavailable; falling back to shared-locked workspace", {
        agentId: input.agentId,
        error: error instanceof Error ? error.message : String(error),
        event: "subagent.worktree.fallback_shared_locked",
        module: "core.subagent",
      });
      return input.execute({
        workingDirectory: input.workingDirectory,
        workspaceRoot: input.workspaceRoot,
      });
    }
    throw error;
  } finally {
    if (worktreeCreated) {
      await execGit(["worktree", "remove", "--force", worktreeDir], rootDir).catch(() => undefined);
      await rm(worktreeDir, { force: true, recursive: true }).catch(() => undefined);
    }
  }
}

async function mergeWorktreeChangesUnderLock(input: {
  readonly agentId: string;
  readonly fileLockRegistry: IFileLockRegistry;
  readonly rootDir: string;
  readonly signal?: AbortSignal;
  readonly workspaceIdentity?: string;
  readonly worktreeDir: string;
}): Promise<string | undefined> {
  await execGit(["add", "-N", "."], input.worktreeDir).catch(() => undefined);
  const { stdout: nameOnlyStdout } = await execGit(["diff", "--name-only", "HEAD"], input.worktreeDir);
  const changedRelativePaths = nameOnlyStdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith(".zcode/"));
  if (changedRelativePaths.length === 0) {
    return undefined;
  }

  const { stdout: patchText } = await execGit(
    ["diff", "--binary", "HEAD", "--", ...changedRelativePaths],
    input.worktreeDir,
  );
  if (!patchText.trim()) {
    return undefined;
  }

  const patchFilePath = join(input.worktreeDir, `.zcode-merge-${sanitizePathSegment(input.agentId)}.patch`);
  await writeFile(patchFilePath, patchText, "utf8");

  return input.fileLockRegistry.withLocks(
    changedRelativePaths.map((relPath) => ({
      mode: "exclusive-write" as const,
      path: resolve(input.rootDir, relPath),
    })),
    {
      holderId: `worktree-merge:${input.agentId}`,
      signal: input.signal,
      workspaceIdentity: input.workspaceIdentity,
      workspaceRoot: input.rootDir,
    },
    async () => {
      try {
        await execGit(["apply", "--check", "--3way", patchFilePath], input.rootDir);
        await execGit(["apply", "--3way", patchFilePath], input.rootDir);
        return undefined;
      } catch (mergeError) {
        const reason = mergeError instanceof Error ? mergeError.message : String(mergeError);
        return `[WORKTREE_MERGE_CONFLICT] Isolated changes in [${changedRelativePaths.join(", ")}] could not be cleanly merged into workspace: ${reason.slice(0, 300)}`;
      }
    },
  );
}

async function ensureWorktreeGitExclude(rootDir: string): Promise<void> {
  try {
    const { stdout } = await execGit(["rev-parse", "--git-path", "info/exclude"], rootDir);
    const excludePath = resolve(rootDir, stdout.trim());
    let existing = "";
    try {
      existing = await readFile(excludePath, "utf8");
    } catch {
      existing = "";
    }
    if (!existing.split(/\r?\n/u).includes(".zcode/worktrees/")) {
      await mkdir(dirname(excludePath), { recursive: true });
      const prefix = existing.length > 0 && !existing.endsWith("\n") ? `${existing}\n` : existing;
      await writeFile(excludePath, `${prefix}.zcode/worktrees/\n`, "utf8");
    }
  } catch {
    // Non-fatal if git info/exclude is read-only or not initialized.
  }
}

async function execGit(
  args: readonly string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("git", [...args], {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    stderr: String(result.stderr ?? ""),
    stdout: String(result.stdout ?? ""),
  };
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, "_").slice(0, 64) || "item";
}

function normalizeErrorSignatureText(text: string): string {
  return text.replace(/\s+/gu, " ").trim().slice(0, 240);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
