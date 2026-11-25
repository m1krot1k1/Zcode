import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CoreErrorType,
  createFileSystemError,
  type FileSystemPort,
  type FileSystemRevision,
} from "@zcode/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applyWorkspaceBoundaryGate } from "../src/tool/executor/permission-flow.js";
import { readHandler, readToolEntry } from "../src/tool/handlers/read.js";
import { writeHandler, writeToolEntry } from "../src/tool/handlers/write.js";
import {
  createWorkspaceBoundaryApprovalPort,
  findBashPathsOutsideWorkspace,
  type WorkspaceBoundaryAuditEvent,
} from "../src/tool/path-policy.js";
import { bashHandler } from "../src/tool/handlers/bash.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

// docs/specs/2026-11-11-workspace-boundary.md §10 的接线回归：
// 配置投影出的模式经 ToolExecutionContext 真正约束 handler，而不是只有 path-policy 单测。
// path-policy 的判定矩阵已由 tests/path-policy-workspace-boundary.test.ts 覆盖，这里不重复。

interface Sandbox {
  base: string;
  workspace: string;
  outsideFile: string;
}

let sandbox: Sandbox;

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), "zcode-ws-boundary-wiring-"));
  const workspace = join(base, "ws");
  await mkdir(workspace, { recursive: true });
  const outsideFile = join(base, "outside.txt");
  await writeFile(outsideFile, "outside secret", "utf8");
  sandbox = { base, workspace, outsideFile };
});

afterAll(async () => {
  await rm(sandbox.base, { recursive: true, force: true });
});

describe("workspace boundary through tool handlers", () => {
  it("strict blocks Read and Write outside the workspace", async () => {
    const context = contextWith(createRealFileSystemPort(), { workspaceBoundary: "strict" });

    await expect(readHandler({ file_path: sandbox.outsideFile }, context)).rejects.toMatchObject({
      type: CoreErrorType.PermissionDenied,
      context: { workspaceBoundary: "strict", escapeKind: "lexical", operation: "read" },
    });

    const escapedWrite = join(sandbox.workspace, "..", "written-outside.txt");
    await expect(
      writeHandler({ file_path: escapedWrite, content: "should not exist" }, context),
    ).rejects.toMatchObject({
      type: CoreErrorType.PermissionDenied,
      context: { workspaceBoundary: "strict", escapeKind: "lexical", operation: "write" },
    });
    await expect(stat(escapedWrite)).rejects.toMatchObject({ code: "ENOENT" });

    // strict 只约束越界：workspace 内的写入仍然正常。
    const insideWrite = await writeHandler({ file_path: "inside.txt", content: "inside" }, context);
    expect(insideWrite).toMatchObject({ type: "create" });
    expect(await readFile(join(sandbox.workspace, "inside.txt"), "utf8")).toBe("inside");
  });

  it("allow keeps legacy behavior and reports an audit event", async () => {
    const events: WorkspaceBoundaryAuditEvent[] = [];
    const context = contextWith(createRealFileSystemPort(), {
      workspaceBoundary: "allow",
      auditWorkspaceBoundary: (event) => events.push(event),
    });

    const output = await writeHandler(
      { file_path: "../allow-outside.txt", content: "allowed" },
      context,
    );
    expect(output).toMatchObject({ type: "create", filePath: "../allow-outside.txt" });
    expect(await readFile(join(sandbox.base, "allow-outside.txt"), "utf8")).toBe("allowed");

    const read = await readHandler({ file_path: sandbox.outsideFile }, context);
    expect(read).toMatchObject({ type: "text", content: "outside secret" });

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]).toMatchObject({
      event: "workspace_boundary.escape",
      action: "allow",
      mode: "allow",
      operation: "write",
      requestedPath: "../allow-outside.txt",
      workspaceRoot: sandbox.workspace,
      escapeKind: "lexical",
    });
  });

  it("ask fails closed when no approval port is wired", async () => {
    const context = contextWith(createRealFileSystemPort(), { workspaceBoundary: "ask" });

    await expect(readHandler({ file_path: sandbox.outsideFile }, context)).rejects.toMatchObject({
      type: CoreErrorType.PermissionEscalation,
      context: { workspaceBoundary: "ask", operation: "read", escapeKind: "lexical" },
    });
    await expect(
      writeHandler({ file_path: "../ask-outside.txt", content: "nope" }, context),
    ).rejects.toMatchObject({
      type: CoreErrorType.PermissionEscalation,
      context: { workspaceBoundary: "ask", operation: "write" },
    });
    await expect(stat(join(sandbox.base, "ask-outside.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("ask only allows the path that was pre-approved through the permission gate", async () => {
    const gate = applyWorkspaceBoundaryGate({
      decision: allowDecision(),
      entry: writeToolEntry,
      executionInput: { file_path: "../gate-approved.txt", content: "approved" },
      workspaceBoundary: "ask",
      workingDirectory: sandbox.workspace,
      workspaceRoot: sandbox.workspace,
    });
    expect(gate.decision).toMatchObject({
      decision: "ask",
      allowed: false,
      approvalMode: "user-once",
      ruleId: "tool.workspaceBoundary.ask",
    });
    expect(gate.approvedRequests).toHaveLength(1);
    expect(gate.approvedRequests[0]).toMatchObject({
      operation: "write",
      requestedPath: "../gate-approved.txt",
      resolvedPath: join(sandbox.base, "gate-approved.txt"),
      escapeKind: "lexical",
    });

    const context = contextWith(createRealFileSystemPort(), {
      workspaceBoundary: "ask",
      workspaceBoundaryApproval: createWorkspaceBoundaryApprovalPort(gate.approvedRequests),
    });
    const written = await writeHandler(
      { file_path: "../gate-approved.txt", content: "approved" },
      context,
    );
    expect(written).toMatchObject({ type: "create" });
    expect(await readFile(join(sandbox.base, "gate-approved.txt"), "utf8")).toBe("approved");

    // 同一端口不会放行未展示给用户的另一条越界路径。
    await expect(
      writeHandler({ file_path: "../not-approved.txt", content: "no" }, context),
    ).rejects.toMatchObject({
      type: CoreErrorType.PermissionDenied,
      context: { workspaceBoundary: "ask" },
    });
    await expect(stat(join(sandbox.base, "not-approved.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("bash command path boundary", () => {
  it("detects explicit outside paths without flagging shell expansions", () => {
    const outside = findBashPathsOutsideWorkspace({
      command:
        "cat ../outside.txt /etc/passwd --file=/etc/hosts src/allowed.ts $HOME/secret '~/private' https://example.com/x --flag",
      workingDirectory: sandbox.workspace,
      workspaceRoot: sandbox.workspace,
    });
    expect(outside).toEqual(["../outside.txt", "/etc/passwd", "/etc/hosts", "~/private"]);
  });

  it("blocks in strict and escalates in ask before execution", async () => {
    const run = vi.fn();
    const context = contextWith(createRealFileSystemPort(), {
      workspaceBoundary: "strict",
      executionPort: { run } as never,
    });
    await expect(
      bashHandler({ command: "cat ../outside.txt", description: "read outside" }, context),
    ).rejects.toMatchObject({
      type: CoreErrorType.PermissionDenied,
      context: { code: "workspace_boundary_bash_path" },
    });
    expect(run).not.toHaveBeenCalled();

    await expect(
      bashHandler(
        { command: "cat ../outside.txt", description: "read outside" },
        { ...context, workspaceBoundary: "ask" },
      ),
    ).rejects.toMatchObject({ type: CoreErrorType.PermissionEscalation });
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps allow mode and in-workspace commands untouched", async () => {
    const now = new Date();
    const run = vi.fn().mockResolvedValue({
      status: "completed",
      exitCode: 0,
      stdout: { text: "ok", bytes: 2, truncated: false },
      stderr: { text: "", bytes: 0, truncated: false },
      durationMs: 1,
      timedOut: false,
      cancelled: false,
      startedAt: now,
      completedAt: now,
    });
    const context = contextWith(createRealFileSystemPort(), {
      workspaceBoundary: "allow",
      executionPort: { run } as never,
    });
    await bashHandler({ command: "cat ../outside.txt", description: "allow" }, context);
    await bashHandler({ command: "cat inside.txt", description: "inside" }, context);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("declared write scope through tool handlers", () => {
  it("rejects writes outside write_paths and allows writes inside", async () => {
    const context = contextWith(createRealFileSystemPort(), { writeScope: ["src"] });

    await expect(
      writeHandler({ file_path: "README.md", content: "outside scope" }, context),
    ).rejects.toMatchObject({
      type: CoreErrorType.PermissionDenied,
      context: { code: "write_scope_violation" },
    });
    await expect(stat(join(sandbox.workspace, "README.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const inside = await writeHandler(
      { file_path: "src/allowed.ts", content: "export const ok = 1;" },
      context,
    );
    expect(inside).toMatchObject({ type: "create" });
  });

  it("treats an empty declared scope as no file writes", async () => {
    const context = contextWith(createRealFileSystemPort(), { writeScope: [] });
    await expect(
      writeHandler({ file_path: "src/blocked.ts", content: "no" }, context),
    ).rejects.toMatchObject({
      type: CoreErrorType.PermissionDenied,
      context: { code: "write_scope_violation", reason: "empty_scope" },
    });
  });

  it("keeps legacy behavior when no scope is declared", async () => {
    const context = contextWith(createRealFileSystemPort());
    const written = await writeHandler({ file_path: "free.txt", content: "free" }, context);
    expect(written).toMatchObject({ type: "create" });
  });
});

describe("workspace boundary permission gate", () => {
  it("leaves allow and strict decisions untouched", () => {
    for (const mode of ["allow", "strict"] as const) {
      const gate = applyWorkspaceBoundaryGate({
        decision: allowDecision(),
        entry: readToolEntry,
        executionInput: { file_path: sandbox.outsideFile },
        workspaceBoundary: mode,
        workingDirectory: sandbox.workspace,
        workspaceRoot: sandbox.workspace,
      });
      expect(gate.decision.decision).toBe("allow");
      expect(gate.approvedRequests).toHaveLength(0);
    }
  });

  it("keeps a hard deny and never turns it into ask", () => {
    const gate = applyWorkspaceBoundaryGate({
      decision: {
        ...allowDecision(),
        decision: "deny",
        allowed: false,
        reason: "blocked by policy",
        ruleId: "test.deny",
      },
      entry: readToolEntry,
      executionInput: { file_path: sandbox.outsideFile },
      workspaceBoundary: "ask",
      workingDirectory: sandbox.workspace,
      workspaceRoot: sandbox.workspace,
    });
    expect(gate.decision.decision).toBe("deny");
    expect(gate.decision.reason).toBe("blocked by policy");
  });
});

function allowDecision() {
  return {
    decision: "allow" as const,
    allowed: true,
    escalated: false,
    mode: "build" as const,
    ruleId: "test.allow",
    riskLevel: "low" as const,
  };
}

function contextWith(
  fileSystemPort: FileSystemPort,
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    toolCallId: "tool_test",
    traceId: "trace_test",
    abortSignal: new AbortController().signal,
    fileSystemPort,
    readFileState: new Map(),
    workingDirectory: sandbox.workspace,
    workspaceRoot: sandbox.workspace,
    sessionId: "sess_test",
    ...overrides,
  };
}

/**
 * 只实现这些 handler 会调用的方法。测试用真实临时目录，因为 strict/ask 的判定本来就
 * 依赖 realpath；内存 FS 无法证明物理落点。
 */
function createRealFileSystemPort(): FileSystemPort {
  return {
    async stat(request) {
      try {
        const info = await stat(request.path);
        return {
          path: request.path,
          kind: info.isDirectory() ? "directory" : "file",
          sizeBytes: info.size,
          mtimeMs: info.mtimeMs,
          revision: revisionFor(info),
        };
      } catch (error) {
        throw toFileSystemError(error, request.path);
      }
    },
    async readTextFile(request) {
      const content = await readFile(request.path, "utf8").catch((error: unknown) => {
        throw toFileSystemError(error, request.path);
      });
      const info = await stat(request.path);
      return {
        path: request.path,
        content,
        encoding: request.encoding ?? "utf8",
        lineEndings: content.includes("\r\n") ? "CRLF" : "LF",
        bytesRead: Buffer.byteLength(content, "utf8"),
        sizeBytes: info.size,
        truncated: false,
        revision: revisionFor(info),
      };
    },
    async readTextFileRange(request) {
      const content = await readFile(request.path, "utf8").catch((error: unknown) => {
        throw toFileSystemError(error, request.path);
      });
      const info = await stat(request.path);
      const lines = content.length === 0 ? [] : content.split("\n");
      const offsetLine = Math.max(0, Math.trunc(request.offsetLine ?? 0));
      const limitLines =
        request.limitLines === undefined ? undefined : Math.max(0, Math.trunc(request.limitLines));
      const selected =
        limitLines === undefined
          ? lines.slice(offsetLine)
          : lines.slice(offsetLine, offsetLine + limitLines);
      return {
        path: request.path,
        content: selected.join("\n"),
        encoding: request.encoding ?? "utf8",
        lineEndings: content.includes("\r\n") ? "CRLF" : "LF",
        bytesRead: info.size,
        sizeBytes: info.size,
        truncated: false,
        startLine: offsetLine + 1,
        lineCount: selected.length,
        totalLines: lines.length,
        revision: revisionFor(info),
      };
    },
    async writeTextFile(request) {
      if (request.createParents) {
        await mkdir(dirname(request.path), { recursive: true });
      }
      await writeFile(request.path, request.content, "utf8");
      const info = await stat(request.path);
      return {
        path: request.path,
        bytesWritten: Buffer.byteLength(request.content, "utf8"),
        revision: revisionFor(info),
      };
    },
  } as unknown as FileSystemPort;
}

function revisionFor(info: { mtimeMs: number; size: number }): FileSystemRevision {
  return {
    id: `${info.mtimeMs}:${info.size}`,
    mtimeMs: info.mtimeMs,
    sizeBytes: info.size,
  };
}

function toFileSystemError(error: unknown, path: string) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") {
    return createFileSystemError({ code: "not_found", path, message: `missing: ${path}` });
  }
  return createFileSystemError({
    code: "io_error",
    path,
    message: error instanceof Error ? error.message : String(error),
  });
}
