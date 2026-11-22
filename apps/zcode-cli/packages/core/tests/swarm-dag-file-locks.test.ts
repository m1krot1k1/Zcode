/// <reference types="node" />
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  SessionEventType,
  createRootTraceContext,
  createSessionEvent,
  createSessionId,
  createToolCallId,
} from "@zcode/contracts";
import {
  createSubagentExecutionGuard,
  withOptionalGitWorktreeIsolation,
} from "../src/runtime/methods/subagent/execution-guard.js";
import { executeSubagentTaskDag, planSubagentDagWaves } from "../src/subagent/runner.js";
import { parseWorkResultBlock } from "../src/subagent/runner-work-result.js";
import { createFileLockRegistry } from "../src/tool/file-transaction/index.js";
import { editToolEntry } from "../src/tool/handlers/edit.js";
import { createReadFileStateKey } from "../src/tool/read-file-state.js";
import type { ReadFileStateMap, ToolExecutionContext } from "../src/tool/types.js";

const execFileAsync = promisify(execFileCallback);

const tempDirs: string[] = [];

async function makeTempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-swarm-locks-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { force: true, recursive: true }).catch(() => undefined);
    }
  }
});

describe("Increment 4.1 (F-02): FileLockRegistry, Swarm DAG wave scheduling & subagent execution guard", () => {
  it("prevents deadlocks via canonical lexicographical realpath sorting (including symlinks)", async () => {
    const workspace = await makeTempWorkspace();
    const realA = join(workspace, "alpha.ts");
    const realB = join(workspace, "beta.ts");
    const aliasA = join(workspace, "zzz-symlink-to-alpha.ts");
    await writeFile(realA, "const a = 1;\n", "utf8");
    await writeFile(realB, "const b = 1;\n", "utf8");
    await symlink(realA, aliasA);

    const registry = createFileLockRegistry();
    const traceOrder: string[] = [];

    // Поток 1 запрашивает [aliasA, realB], Поток 2 встречно запрашивает [realB, realA].
    // Благодаря канонизации realpath и лексикографической сортировке оба потока берут блокировки
    // строго в порядке [realA, realB], исключая взаимную блокировку (deadlock).
    await Promise.all([
      registry.withLocks(
        [
          { mode: "exclusive-write", path: aliasA },
          { mode: "exclusive-write", path: realB },
        ],
        { holderId: "agent-1", workspaceRoot: workspace },
        async () => {
          traceOrder.push("agent-1:enter");
          await new Promise((resolve) => setTimeout(resolve, 25));
          traceOrder.push("agent-1:exit");
        },
      ),
      registry.withLocks(
        [
          { mode: "exclusive-write", path: realB },
          { mode: "exclusive-write", path: realA },
        ],
        { holderId: "agent-2", workspaceRoot: workspace },
        async () => {
          traceOrder.push("agent-2:enter");
          await new Promise((resolve) => setTimeout(resolve, 15));
          traceOrder.push("agent-2:exit");
        },
      ),
    ]);

    // Независимо от того, чей асинхронный syscall realpath() завершится в ядре ОС на долю мс раньше,
    // каноническая сортировка гарантирует отсутствие дедлока и строгое взаимное исключение критических секций.
    expect(traceOrder).toHaveLength(4);
    const firstWinner = traceOrder[0]?.startsWith("agent-1:") ? "agent-1" : "agent-2";
    const secondWinner = firstWinner === "agent-1" ? "agent-2" : "agent-1";
    expect(traceOrder).toEqual([
      `${firstWinner}:enter`,
      `${firstWinner}:exit`,
      `${secondWinner}:enter`,
      `${secondWinner}:exit`,
    ]);
  });

  it("eliminates read-modify-write overwrite races when parallel subagent Edit handlers share parent FileLockRegistry", async () => {
    const workspace = await makeTempWorkspace();
    const sharedFile = join(workspace, "shared-target.ts");
    await writeFile(
      sharedFile,
      ["export const HEADER = 'v0';", "export const FOOTER = 'v0';", ""].join("\n"),
      "utf8",
    );

    const sharedLockRegistry = createFileLockRegistry();

    // Имитируем асинхронную задержку ФС между чтением и записью: без FileLockRegistry
    // второй субагент прочитал бы устаревший 'v0' до завершения записи первого субагента
    // и перезатёр бы его правку!
    const slowFsPort = {
      async readTextFile({ path }: { path: string }) {
        const content = await readFile(path, "utf8");
        await new Promise((resolve) => setTimeout(resolve, 25));
        const sizeBytes = new TextEncoder().encode(content).byteLength;
        return {
          bytesRead: sizeBytes,
          content,
          encoding: "utf8" as const,
          path,
          sizeBytes,
          truncated: false,
        };
      },
      async stat({ path }: { path: string }) {
        const content = await readFile(path, "utf8");
        return {
          kind: "file" as const,
          mtimeMs: 1_000,
          path,
          sizeBytes: new TextEncoder().encode(content).byteLength,
        };
      },
      async writeTextFile({ content, path }: { content: string; path: string }) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        await writeFile(path, content, "utf8");
        const bytesWritten = new TextEncoder().encode(content).byteLength;
        return { bytesWritten, created: false, path };
      },
    };

    const makeContext = (
      agentName: string,
      readFileState: ReadFileStateMap,
    ): ToolExecutionContext => {
      const sessionId = createSessionId(`sess_${agentName}`);
      const traceContext = createRootTraceContext({ sessionId });
      return {
        abortSignal: new AbortController().signal,
        fileLockRegistry: sharedLockRegistry,
        fileSystemPort: slowFsPort as never,
        readFileState,
        sessionId,
        toolCallId: createToolCallId(`call_${agentName}`),
        traceContext,
        traceId: traceContext.traceId,
        workingDirectory: workspace,
        workspaceRoot: workspace,
      };
    };

    // Общий readFileState родителя и детей (как делает sharedReadFileStateForChild в subagent/port.ts!):
    // первый субагент под локом обновляет и файл на диске, и общий readFileState, после чего второй
    // субагент входит в критическую секцию и видит актуальное состояние!
    const sharedReadFileState: ReadFileStateMap = new Map([
      [
        createReadFileStateKey(sharedFile, undefined, undefined),
        {
          content: "export const HEADER = 'v0';\nexport const FOOTER = 'v0';\n",
          contentHash: "v0",
          isPartialView: false,
          mtimeMs: 1_000,
          path: sharedFile,
          readAt: new Date(2_000),
        },
      ],
    ]);
    const ctxA = makeContext("subagentA", sharedReadFileState);
    const ctxB = makeContext("subagentB", sharedReadFileState);

    await Promise.all([
      editToolEntry.handler(
        {
          file_path: sharedFile,
          new_string: "export const HEADER = 'updated-by-subagent-A';",
          old_string: "export const HEADER = 'v0';",
        },
        ctxA,
      ),
      editToolEntry.handler(
        {
          file_path: sharedFile,
          new_string: "export const FOOTER = 'updated-by-subagent-B';",
          old_string: "export const FOOTER = 'v0';",
        },
        ctxB,
      ),
    ]);

    const finalContent = await readFile(sharedFile, "utf8");
    expect(finalContent).toContain("export const HEADER = 'updated-by-subagent-A';");
    expect(finalContent).toContain("export const FOOTER = 'updated-by-subagent-B';");
  });

  it("schedules Swarm DAG nodes in deterministic waves honoring depends_on AND overlapping write_paths", async () => {
    const workspace = await makeTempWorkspace();
    const nodes = [
      {
        description: "Edit auth service part 1",
        id: "writer-auth-1",
        prompt: "Update auth.ts part 1",
        subagent_type: "coder",
        write_paths: ["src/auth/service.ts"],
      },
      {
        description: "Edit overlapping auth directory",
        id: "writer-auth-2",
        prompt: "Update auth index",
        subagent_type: "coder",
        write_paths: ["src/auth"],
      },
      {
        description: "Independent billing module",
        id: "writer-billing",
        prompt: "Update billing.ts",
        subagent_type: "coder",
        write_paths: ["src/billing/invoice.ts"],
      },
      {
        depends_on: ["writer-auth-2", "writer-billing"],
        description: "Final integration verifier",
        id: "verifier",
        prompt: "Verify auth and billing",
        subagent_type: "reviewer",
        write_paths: [],
      },
    ];

    const plannedWaves = planSubagentDagWaves(nodes, workspace);
    expect(plannedWaves.get("writer-auth-1")).toBe(0);
    expect(plannedWaves.get("writer-billing")).toBe(0);
    // Пересекающийся по write_paths ("src/auth" vs "src/auth/service.ts") автоматически разнесён во 2-ю волну!
    expect(plannedWaves.get("writer-auth-2")).toBe(1);
    // Зависящий от writer-auth-2 узел попадает в 3-ю волну (wave=2).
    expect(plannedWaves.get("verifier")).toBe(2);

    const runningAuthNodes = new Set<string>();
    let maxConcurrentAuthWriters = 0;
    const executionSequence: string[] = [];
    const sessionId = createSessionId("sess_dag_waves");

    const dagOutput = await executeSubagentTaskDag(
      {
        agentType: "swarm-coordinator",
        description: "Swarm wave execution test",
        maxParallel: 4,
        nodes,
        orchestrationRunId: "swarm_wave_run_1",
        prompt: "Update auth and billing",
        sessionId,
        trace: createRootTraceContext({ sessionId }),
        workingDirectory: workspace,
        workspaceRoot: workspace,
      },
      async (node) => {
        executionSequence.push(`start:${node.id}`);
        if (node.id.startsWith("writer-auth")) {
          runningAuthNodes.add(node.id);
          maxConcurrentAuthWriters = Math.max(maxConcurrentAuthWriters, runningAuthNodes.size);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        runningAuthNodes.delete(node.id);
        executionSequence.push(`end:${node.id}`);
        return {
          agentId: `agent_${node.id}`,
          agentType: node.subagent_type,
          content: [{ text: `Completed ${node.id}`, type: "text" as const }],
          description: node.description,
          prompt: node.prompt,
          status: "completed" as const,
          totalDurationMs: 20,
          totalTokens: 500,
          totalToolUseCount: 2,
          workResult: {
            claims: [],
            evidence: [],
            files: node.write_paths ?? [],
            status: "completed" as const,
            summary: `Done ${node.id}`,
            tests: [],
            unresolved: [],
          },
        };
      },
    );

    expect(maxConcurrentAuthWriters).toBe(1);
    expect(executionSequence.indexOf("end:writer-auth-1")).toBeLessThan(
      executionSequence.indexOf("start:writer-auth-2"),
    );
    expect(executionSequence.indexOf("end:writer-auth-2")).toBeLessThan(
      executionSequence.indexOf("start:verifier"),
    );
    expect(dagOutput.workResult?.status).toBe("completed");
    expect(dagOutput.workResult?.files).toEqual([
      "src/auth/service.ts",
      "src/auth",
      "src/billing/invoice.ts",
    ]);
    expect(dagOutput.content[0]?.text).toContain("wave=0");
    expect(dagOutput.content[0]?.text).toContain("wave=1");
    expect(dagOutput.content[0]?.text).toContain("wave=2");
  });

  it("supports parallel git-worktree isolation with controlled 3-way merge under FileLockRegistry", async () => {
    const repoDir = await makeTempWorkspace();
    await execFileAsync("git", ["init"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.email", "test@zcode.local"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.name", "Zcode Test"], { cwd: repoDir });

    const targetFile = join(repoDir, "module.ts");
    await writeFile(
      targetFile,
      [
        "export function firstSection() {",
        "  return 'initial-top';",
        "}",
        "",
        "// spacer 1",
        "// spacer 2",
        "// spacer 3",
        "// spacer 4",
        "",
        "export function secondSection() {",
        "  return 'initial-bottom';",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await execFileAsync("git", ["add", "."], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repoDir });

    const lockRegistry = createFileLockRegistry();
    const sessionId = createSessionId("sess_worktree");
    const traceContext = createRootTraceContext({ sessionId });

    await Promise.all([
      withOptionalGitWorktreeIsolation({
        agentId: "wt-branch-top",
        execute: async ({ workingDirectory }) => {
          const isolatedPath = join(workingDirectory, "module.ts");
          const current = await readFile(isolatedPath, "utf8");
          await writeFile(
            isolatedPath,
            current.replace("initial-top", "merged-from-worktree-top"),
            "utf8",
          );
          return { response: "Updated top section" };
        },
        fileLockRegistry: lockRegistry,
        isolationMode: "git-worktree",
        runScopeId: "swarm_wt_test",
        traceContext,
        workingDirectory: repoDir,
        workspaceRoot: repoDir,
      }),
      withOptionalGitWorktreeIsolation({
        agentId: "wt-branch-bottom",
        execute: async ({ workingDirectory }) => {
          const isolatedPath = join(workingDirectory, "module.ts");
          const current = await readFile(isolatedPath, "utf8");
          await writeFile(
            isolatedPath,
            current.replace("initial-bottom", "merged-from-worktree-bottom"),
            "utf8",
          );
          return { response: "Updated bottom section" };
        },
        fileLockRegistry: lockRegistry,
        isolationMode: "git-worktree",
        runScopeId: "swarm_wt_test",
        traceContext,
        workingDirectory: repoDir,
        workspaceRoot: repoDir,
      }),
    ]);

    const merged = await readFile(targetFile, "utf8");
    expect(merged).toContain("merged-from-worktree-top");
    expect(merged).toContain("merged-from-worktree-bottom");
  });

  it("enforces subagent token budgets, detects identical tool-error loops, and emits structured <zcode-work-result>", () => {
    const sessionId = createSessionId("sess_guard_child");
    const loopGuard = createSubagentExecutionGuard({
      agentId: "agent_looping",
      maxIdenticalToolErrors: 3,
    });

    for (let i = 1; i <= 3; i += 1) {
      loopGuard.observeEvent(
        createSessionEvent(SessionEventType.ToolCallError, sessionId, {
          error: { message: "Edit failed: old_string not found in src/app.ts" },
          toolCallId: `call_${i}`,
          toolName: "Edit",
        } as never),
      );
    }

    expect(loopGuard.signal.aborted).toBe(true);
    expect(loopGuard.getTermination()?.code).toBe("SUBAGENT_IDENTICAL_TOOL_ERROR_LOOP");
    const structuredReport = loopGuard.buildStructuredTerminationResponse();
    const parsedWorkResult = parseWorkResultBlock(structuredReport);
    expect(parsedWorkResult?.status).toBe("failed");
    expect(parsedWorkResult?.unresolved[0]).toContain("SUBAGENT_IDENTICAL_TOOL_ERROR_LOOP");
    loopGuard.dispose();

    const budgetGuard = createSubagentExecutionGuard({
      agentId: "agent_budget",
      budget: { maxInputTokens: 10_000 },
    });
    budgetGuard.observeEvent(
      createSessionEvent(SessionEventType.ModelComplete, sessionId, {
        fileChanges: { files: [{ path: "src/partial.ts" }] },
        usage: { inputTokens: 12_500, outputTokens: 400 },
      } as never),
    );
    expect(budgetGuard.signal.aborted).toBe(true);
    expect(budgetGuard.getTermination()?.code).toBe("SUBAGENT_INPUT_TOKEN_BUDGET_EXHAUSTED");
    const parsedBudgetResult = parseWorkResultBlock(
      budgetGuard.buildStructuredTerminationResponse(),
    );
    expect(parsedBudgetResult?.files).toEqual(["src/partial.ts"]);
    budgetGuard.dispose();
  });
});
