import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreErrorType, type CoreError, isCoreError } from "@zcode/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isPathWithinWorkspaceRoot,
  resolveToolWorkingDirectory,
  resolveWorkspacePath,
  type WorkspaceBoundaryApprovalRequest,
  type WorkspaceBoundaryAuditEvent,
  type WorkspaceBoundaryMode,
} from "../src/tool/path-policy.js";

// docs/specs/2026-11-11-workspace-boundary-path-policy.md 的契约回归：
// strict 拒绝词法/软链/不可解析越界，ask 只走注入的审批端口，allow 保持兼容并审计。
// 软链创建在 Windows 需要额外权限，相关用例 skipIf，平台语义由 path-policy.test.ts 的纯函数矩阵覆盖。
const windows = process.platform === "win32";

type ToolWorkspacePathOptions = Parameters<typeof resolveWorkspacePath>[0];

interface Sandbox {
  base: string;
  workspace: string;
  outside: string;
  workspaceLink: string;
  realWorkspace: string;
  realOutside: string;
  missingRoot: string;
  links: {
    fileOut: string;
    dirOut: string;
    dangling: string;
    inside: string;
  };
}

let sandbox: Sandbox;

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), "zcode-ws-boundary-"));
  const workspace = join(base, "ws");
  const outside = join(base, "outside");
  await mkdir(join(workspace, "dir"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(workspace, "inside.txt"), "inside");
  await writeFile(join(workspace, "dir", "nested.txt"), "nested");
  await writeFile(join(outside, "secret.txt"), "secret");

  const links = {
    fileOut: join(workspace, "file-out.txt"),
    dirOut: join(workspace, "dir-out"),
    dangling: join(workspace, "dangling.txt"),
    inside: join(workspace, "link-inside.txt"),
  };
  const workspaceLink = join(base, "ws-link");
  if (!windows) {
    await symlink(join(outside, "secret.txt"), links.fileOut);
    await symlink(outside, links.dirOut, "dir");
    await symlink(join(outside, "does-not-exist.txt"), links.dangling);
    await symlink(join(workspace, "inside.txt"), links.inside);
    await symlink(workspace, workspaceLink, "dir");
  }

  sandbox = {
    base,
    workspace,
    outside,
    workspaceLink,
    realWorkspace: await realpath(workspace),
    realOutside: await realpath(outside),
    missingRoot: join(base, "missing-root"),
    links,
  };
});

afterAll(async () => {
  await rm(sandbox.base, { recursive: true, force: true });
});

function expectCoreError(fn: () => unknown, type: CoreErrorType): CoreError {
  try {
    fn();
  } catch (error) {
    expect(isCoreError(error)).toBe(true);
    const coreError = error as CoreError;
    expect(coreError.type).toBe(type);
    return coreError;
  }
  throw new Error(`Expected a ${type} CoreError but the call returned`);
}

function resolveIn(
  inputPath: string,
  overrides: Partial<ToolWorkspacePathOptions> = {},
): string {
  return resolveWorkspacePath({
    inputPath,
    workingDirectory: sandbox.workspace,
    workspaceRoot: sandbox.workspace,
    operation: "read",
    ...overrides,
  });
}

describe("strict: lexical containment", () => {
  it("denies a '..' escape with escapeKind=lexical", () => {
    const error = expectCoreError(
      () => resolveIn("../outside/secret.txt", { workspaceBoundary: "strict" }),
      CoreErrorType.PermissionDenied,
    );
    expect(error.recoverable).toBe(true);
    expect(error.context).toMatchObject({
      workspaceBoundary: "strict",
      escapeKind: "lexical",
      operation: "read",
      requestedPath: "../outside/secret.txt",
      workspaceRoot: sandbox.workspace,
    });
  });

  it("denies an absolute path to a non-existent file outside the workspace", () => {
    const missingOutside = join(sandbox.outside, "not-created.txt");
    const error = expectCoreError(
      () => resolveIn(missingOutside, { workspaceBoundary: "strict", operation: "write" }),
      CoreErrorType.PermissionDenied,
    );
    expect(error.context).toMatchObject({
      escapeKind: "lexical",
      operation: "write",
      resolvedPath: missingOutside,
    });
  });

  it("allows the boundary itself, existing files and a non-existent nested leaf inside", () => {
    expect(resolveIn(sandbox.workspace, { workspaceBoundary: "strict" })).toBe(
      sandbox.workspace,
    );
    expect(resolveIn("inside.txt", { workspaceBoundary: "strict" })).toBe(
      join(sandbox.workspace, "inside.txt"),
    );
    expect(resolveIn("dir/nested.txt", { workspaceBoundary: "strict" })).toBe(
      join(sandbox.workspace, "dir", "nested.txt"),
    );
    expect(
      resolveIn("new/deep/file.txt", { workspaceBoundary: "strict", operation: "write" }),
    ).toBe(join(sandbox.workspace, "new", "deep", "file.txt"));
  });

  it("allows '..' segments that normalize back inside the workspace", () => {
    expect(resolveIn("dir/../inside.txt", { workspaceBoundary: "strict" })).toBe(
      join(sandbox.workspace, "inside.txt"),
    );
  });

  it("fails closed with escapeKind=unresolvable when the workspace root cannot be resolved", () => {
    const error = expectCoreError(
      () =>
        resolveIn(join(sandbox.missingRoot, "file.txt"), {
          workspaceBoundary: "strict",
          workspaceRoot: sandbox.missingRoot,
        }),
      CoreErrorType.PermissionDenied,
    );
    expect(error.context).toMatchObject({
      escapeKind: "unresolvable",
      workspaceRoot: sandbox.missingRoot,
    });
  });

  it("rejects an unknown mode with a configuration error", () => {
    expectCoreError(
      () =>
        resolveIn("inside.txt", {
          workspaceBoundary: "permissive" as unknown as WorkspaceBoundaryMode,
        }),
      CoreErrorType.ConfigurationError,
    );
  });

  it("applies the boundary to the resolved tool working directory", () => {
    expectCoreError(
      () =>
        resolveToolWorkingDirectory("../outside", {
          operation: "execute",
          workingDirectory: sandbox.workspace,
          workspaceRoot: sandbox.workspace,
          workspaceBoundary: "strict",
        }),
      CoreErrorType.PermissionDenied,
    );
    expect(
      resolveToolWorkingDirectory(undefined, {
        operation: "execute",
        workingDirectory: sandbox.workspace,
        workspaceRoot: sandbox.workspace,
        workspaceBoundary: "strict",
      }),
    ).toBe(sandbox.workspace);
  });
});

describe.skipIf(windows)("strict: physical containment (symlinks)", () => {
  it("denies an in-workspace symlink file pointing outside", () => {
    const error = expectCoreError(
      () => resolveIn(sandbox.links.fileOut, { workspaceBoundary: "strict" }),
      CoreErrorType.PermissionDenied,
    );
    expect(error.context).toMatchObject({
      escapeKind: "symlink",
      physicalPath: join(sandbox.realOutside, "secret.txt"),
      physicalWorkspaceRoot: sandbox.realWorkspace,
    });
  });

  it("denies a non-existent leaf reached through an escaping directory symlink", () => {
    const target = join(sandbox.links.dirOut, "not-created.txt");
    const error = expectCoreError(
      () => resolveIn(target, { workspaceBoundary: "strict", operation: "write" }),
      CoreErrorType.PermissionDenied,
    );
    expect(error.context).toMatchObject({
      escapeKind: "symlink",
      physicalPath: join(sandbox.realOutside, "not-created.txt"),
    });
  });

  it("denies a dangling symlink because its target cannot be proven inside", () => {
    const error = expectCoreError(
      () => resolveIn(sandbox.links.dangling, { workspaceBoundary: "strict" }),
      CoreErrorType.PermissionDenied,
    );
    expect(error.context).toMatchObject({ escapeKind: "dangling_symlink" });
  });

  it("allows a symlink that resolves inside and a symlinked workspace root", () => {
    expect(resolveIn(sandbox.links.inside, { workspaceBoundary: "strict" })).toBe(
      sandbox.links.inside,
    );
    expect(
      resolveWorkspacePath({
        inputPath: join(sandbox.workspaceLink, "inside.txt"),
        workingDirectory: sandbox.workspaceLink,
        workspaceRoot: sandbox.workspaceLink,
        operation: "read",
        workspaceBoundary: "strict",
      }),
    ).toBe(join(sandbox.workspaceLink, "inside.txt"));
  });
});

describe("ask: injected approval port only", () => {
  it("allows after approval and reports the request plus an approve audit event", () => {
    const requests: WorkspaceBoundaryApprovalRequest[] = [];
    const events: WorkspaceBoundaryAuditEvent[] = [];
    const outsideFile = join(sandbox.outside, "secret.txt");
    const resolved = resolveIn(outsideFile, {
      workspaceBoundary: "ask",
      workspaceBoundaryApproval: {
        decide: (request) => {
          requests.push(request);
          return { decision: "allow" };
        },
      },
      auditWorkspaceBoundary: (event) => events.push(event),
    });
    expect(resolved).toBe(outsideFile);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      operation: "read",
      requestedPath: outsideFile,
      resolvedPath: outsideFile,
      workspaceRoot: sandbox.workspace,
      escapeKind: "lexical",
    });
    expect(requests[0]!.summary).toContain("outside workspace");
    expect(events.map((event) => event.action)).toEqual(["approve"]);
    expect(events[0]).toMatchObject({ mode: "ask", configured: true });
  });

  it("denies after the port denies and keeps the port reason", () => {
    const events: WorkspaceBoundaryAuditEvent[] = [];
    const error = expectCoreError(
      () =>
        resolveIn("../outside/secret.txt", {
          workspaceBoundary: "ask",
          workspaceBoundaryApproval: {
            decide: () => ({ decision: "deny", reason: "outside is off limits" }),
          },
          auditWorkspaceBoundary: (event) => events.push(event),
        }),
      CoreErrorType.PermissionDenied,
    );
    expect(error.message).toBe("outside is off limits");
    expect(error.context).toMatchObject({
      workspaceBoundary: "ask",
      reason: "outside is off limits",
    });
    expect(events.map((event) => event.action)).toEqual(["deny"]);
  });

  it("fails closed with permission_escalation when no port is wired", () => {
    const error = expectCoreError(
      () => resolveIn("../outside/secret.txt", { workspaceBoundary: "ask" }),
      CoreErrorType.PermissionEscalation,
    );
    expect(error.recoverable).toBe(true);
    expect(error.context).toMatchObject({ workspaceBoundary: "ask", escapeKind: "lexical" });
  });

  it("treats a throwing port as a denial", () => {
    const error = expectCoreError(
      () =>
        resolveIn("../outside/secret.txt", {
          workspaceBoundary: "ask",
          workspaceBoundaryApproval: {
            decide: () => {
              throw new Error("approval window crashed");
            },
          },
        }),
      CoreErrorType.PermissionDenied,
    );
    expect(error.message).toContain("approval window crashed");
  });

  it("treats a malformed port result as a denial instead of leaking a TypeError", () => {
    // fail closed：undefined / null / 缺字段 / 未知 decision 都不能变成隐式放行。
    const malformedResults: unknown[] = [undefined, null, {}, { decision: "maybe" }];
    for (const malformed of malformedResults) {
      const events: WorkspaceBoundaryAuditEvent[] = [];
      const error = expectCoreError(
        () =>
          resolveIn("../outside/secret.txt", {
            workspaceBoundary: "ask",
            workspaceBoundaryApproval: {
              decide: () => malformed as never,
            },
            auditWorkspaceBoundary: (event) => events.push(event),
          }),
        CoreErrorType.PermissionDenied,
      );
      expect(error.recoverable).toBe(true);
      expect(events.map((event) => event.action)).toEqual(["deny"]);
    }
  });

  it("does not consult the port for a contained path", () => {
    let calls = 0;
    const resolved = resolveIn("inside.txt", {
      workspaceBoundary: "ask",
      workspaceBoundaryApproval: {
        decide: () => {
          calls += 1;
          return { decision: "deny" };
        },
      },
    });
    expect(resolved).toBe(join(sandbox.workspace, "inside.txt"));
    expect(calls).toBe(0);
  });

  it.skipIf(windows)("routes a symlink escape through the approval port", () => {
    const requests: WorkspaceBoundaryApprovalRequest[] = [];
    const error = expectCoreError(
      () =>
        resolveIn(sandbox.links.fileOut, {
          workspaceBoundary: "ask",
          workspaceBoundaryApproval: {
            decide: (request) => {
              requests.push(request);
              return { decision: "deny" };
            },
          },
        }),
      CoreErrorType.PermissionDenied,
    );
    expect(requests.map((request) => request.escapeKind)).toEqual(["symlink"]);
    expect(error.context).toMatchObject({ escapeKind: "symlink" });
  });
});

describe("platform containment matrix (explicit platform)", () => {
  // 纯函数用例显式传 platform，宿主是 macOS/Linux/Windows 时语义一致。
  it("treats win32 paths case-insensitively and rejects sibling prefixes and other drives", () => {
    expect(isPathWithinWorkspaceRoot("C:\\ws\\a.txt", "C:\\ws", "win32")).toBe(true);
    expect(isPathWithinWorkspaceRoot("C:\\ws", "C:\\ws", "win32")).toBe(true);
    expect(isPathWithinWorkspaceRoot("C:\\WS\\a.txt", "c:\\ws", "win32")).toBe(true);
    expect(isPathWithinWorkspaceRoot("C:\\ws2\\a.txt", "C:\\ws", "win32")).toBe(false);
    expect(isPathWithinWorkspaceRoot("D:\\ws\\a.txt", "C:\\ws", "win32")).toBe(false);
  });

  it("normalizes Git Bash drive aliases on win32", () => {
    expect(isPathWithinWorkspaceRoot("/c/ws/a.txt", "C:\\ws", "win32")).toBe(true);
    expect(isPathWithinWorkspaceRoot("/d/ws/a.txt", "C:\\ws", "win32")).toBe(false);
  });

  it("does not treat a posix prefix sibling as contained", () => {
    expect(isPathWithinWorkspaceRoot("/ws/a.txt", "/ws", "linux")).toBe(true);
    expect(isPathWithinWorkspaceRoot("/ws2/a.txt", "/ws", "linux")).toBe(false);
    expect(isPathWithinWorkspaceRoot("/ws/../ws/a.txt", "/ws", "linux")).toBe(true);
    expect(isPathWithinWorkspaceRoot("/ws/../outside/a.txt", "/ws", "linux")).toBe(false);
  });
});

describe("allow: compatibility default and audit", () => {
  it("keeps the legacy behavior when no mode is passed", () => {
    expect(resolveIn("../outside/secret.txt")).toBe(join(sandbox.outside, "secret.txt"));
    expect(resolveIn(join(sandbox.outside, "secret.txt"))).toBe(
      join(sandbox.outside, "secret.txt"),
    );
  });

  it("does not probe the filesystem on the default fast path", () => {
    // root 不存在时若做了探测会判 unresolvable；默认 allow 必须完全不触碰文件系统。
    expect(
      resolveIn(join(sandbox.missingRoot, "file.txt"), {
        workspaceRoot: sandbox.missingRoot,
        operation: "write",
      }),
    ).toBe(join(sandbox.missingRoot, "file.txt"));
  });

  it("allows an escape explicitly and reports action=allow", () => {
    const events: WorkspaceBoundaryAuditEvent[] = [];
    const resolved = resolveIn("../outside/secret.txt", {
      workspaceBoundary: "allow",
      auditWorkspaceBoundary: (event) => events.push(event),
    });
    expect(resolved).toBe(join(sandbox.outside, "secret.txt"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "workspace_boundary.escape",
      action: "allow",
      mode: "allow",
      configured: true,
      operation: "read",
      escapeKind: "lexical",
      workspaceRoot: sandbox.workspace,
      platform: process.platform,
    });
  });

  it("marks the default mode as not configured in the audit event", () => {
    const events: WorkspaceBoundaryAuditEvent[] = [];
    resolveIn(join(sandbox.outside, "secret.txt"), {
      auditWorkspaceBoundary: (event) => events.push(event),
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ mode: "allow", configured: false, action: "allow" });
  });

  it("emits nothing for contained paths and ignores a throwing audit callback", () => {
    const events: WorkspaceBoundaryAuditEvent[] = [];
    resolveIn("inside.txt", {
      workspaceBoundary: "allow",
      auditWorkspaceBoundary: (event) => events.push(event),
    });
    expect(events).toEqual([]);
    expect(
      resolveIn(join(sandbox.outside, "secret.txt"), {
        workspaceBoundary: "allow",
        auditWorkspaceBoundary: () => {
          throw new Error("audit sink offline");
        },
      }),
    ).toBe(join(sandbox.outside, "secret.txt"));
  });
});
