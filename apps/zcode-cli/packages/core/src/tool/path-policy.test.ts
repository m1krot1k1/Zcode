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
} from "./path-policy.js";

type ToolWorkspacePathOptions = Parameters<typeof resolveWorkspacePath>[0];

// docs/specs/2026-11-11-workspace-boundary.md 的回归用例：
// strict 拒绝词法/软链越界，ask 走审批端口，allow 放行并审计，边界本身始终允许。
// 软链创建在 Windows 需要额外权限；平台路径语义由文件末尾的纯函数矩阵覆盖。
const windows = process.platform === "win32";

interface Sandbox {
  base: string;
  workspace: string;
  outside: string;
  workspaceLink: string;
  /** realpath 后的落点：macOS 上 /var 会解析为 /private/var。 */
  realWorkspace: string;
  realOutside: string;
  symlinks: {
    fileOut: string;
    dirOut: string;
    chain: string;
    dangling: string;
    inside: string;
  };
}

let sandbox: Sandbox;

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), "zcode-path-policy-"));
  const workspace = join(base, "ws");
  const outside = join(base, "outside");
  await mkdir(join(workspace, "dir"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(workspace, "inside.txt"), "inside");
  await writeFile(join(workspace, "dir", "nested.txt"), "nested");
  await writeFile(join(outside, "secret.txt"), "secret");

  const symlinks = {
    fileOut: join(workspace, "file-out.txt"),
    dirOut: join(workspace, "dir-out"),
    chain: join(workspace, "chain.txt"),
    dangling: join(workspace, "dangling.txt"),
    inside: join(workspace, "link-inside.txt"),
  };
  const workspaceLink = join(base, "ws-link");
  if (!windows) {
    await symlink(join(outside, "secret.txt"), symlinks.fileOut);
    await symlink(outside, symlinks.dirOut, "dir");
    // 软链链：chain.txt -> file-out.txt -> outside/secret.txt。
    await symlink(symlinks.fileOut, symlinks.chain);
    await symlink(join(outside, "does-not-exist.txt"), symlinks.dangling);
    await symlink(join(workspace, "inside.txt"), symlinks.inside);
    await symlink(workspace, workspaceLink, "dir");
  }
  sandbox = {
    base,
    workspace,
    outside,
    workspaceLink,
    realWorkspace: await realpath(workspace),
    realOutside: await realpath(outside),
    symlinks,
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

describe("workspaceBoundary=strict", () => {
  it("rejects a '..' escape with escapeKind=lexical", () => {
    const error = expectCoreError(
      () => resolveIn("../outside/secret.txt", { workspaceBoundary: "strict" }),
      CoreErrorType.PermissionDenied,
    );
    expect(error.context).toMatchObject({
      workspaceBoundary: "strict",
      escapeKind: "lexical",
      operation: "read",
      requestedPath: "../outside/secret.txt",
    });
    expect(error.recoverable).toBe(true);
  });

  it("rejects an absolute path outside the workspace", () => {
    const error = expectCoreError(
      () =>
        resolveIn(join(sandbox.outside, "secret.txt"), {
          workspaceBoundary: "strict",
        }),
      CoreErrorType.PermissionDenied,
    );
    expect(error.context).toMatchObject({ escapeKind: "lexical" });
  });

  it("allows the workspace boundary itself, an existing file and a not-yet-existing file", () => {
    expect(
      resolveIn(sandbox.workspace, { workspaceBoundary: "strict" }),
    ).toBe(sandbox.workspace);
    expect(
      resolveIn(join(sandbox.workspace, "inside.txt"), { workspaceBoundary: "strict" }),
    ).toBe(join(sandbox.workspace, "inside.txt"));
    expect(
      resolveIn(join(sandbox.workspace, "new", "deep", "file.txt"), {
        workspaceBoundary: "strict",
        operation: "write",
      }),
    ).toBe(join(sandbox.workspace, "new", "deep", "file.txt"));
  });

  it("allows a relative path that resolves inside the workspace", () => {
    expect(resolveIn("dir/nested.txt", { workspaceBoundary: "strict" })).toBe(
      join(sandbox.workspace, "dir", "nested.txt"),
    );
  });

  it("allows '..' segments that normalize back inside the workspace", () => {
    expect(resolveIn("dir/../inside.txt", { workspaceBoundary: "strict" })).toBe(
      join(sandbox.workspace, "inside.txt"),
    );
    expect(resolveIn("../ws/inside.txt", { workspaceBoundary: "strict" })).toBe(
      join(sandbox.workspace, "inside.txt"),
    );
  });
});

describe.skipIf(windows)("workspaceBoundary=strict with symlinks", () => {
  it("rejects an in-workspace symlink that points to an outside file", () => {
    const error = expectCoreError(
      () => resolveIn(sandbox.symlinks.fileOut, { workspaceBoundary: "strict" }),
      CoreErrorType.PermissionDenied,
    );
    expect(error.context).toMatchObject({
      escapeKind: "symlink",
      physicalPath: join(sandbox.realOutside, "secret.txt"),
    });
  });

  it("rejects an in-workspace symlink that points to an outside directory", () => {
    const error = expectCoreError(
      () => resolveIn(join(sandbox.symlinks.dirOut, "secret.txt"), { workspaceBoundary: "strict" }),
      CoreErrorType.PermissionDenied,
    );
    expect(error.context).toMatchObject({ escapeKind: "symlink" });
  });

  it("rejects a symlink chain that ends outside the workspace", () => {
    const error = expectCoreError(
      () => resolveIn(sandbox.symlinks.chain, { workspaceBoundary: "strict" }),
      CoreErrorType.PermissionDenied,
    );
    expect(error.context).toMatchObject({ escapeKind: "symlink" });
  });

  it("rejects a dangling symlink because its target cannot be proven inside", () => {
    const error = expectCoreError(
      () => resolveIn(sandbox.symlinks.dangling, { workspaceBoundary: "strict" }),
      CoreErrorType.PermissionDenied,
    );
    expect(error.context).toMatchObject({ escapeKind: "dangling_symlink" });
  });

  it("allows a symlink that resolves inside the workspace", () => {
    expect(resolveIn(sandbox.symlinks.inside, { workspaceBoundary: "strict" })).toBe(
      sandbox.symlinks.inside,
    );
  });

  it("allows paths inside a workspace root that is itself a symlink", () => {
    expect(
      resolveWorkspacePath({
        inputPath: join(sandbox.workspaceLink, "inside.txt"),
        workingDirectory: sandbox.workspaceLink,
        workspaceRoot: sandbox.workspaceLink,
        operation: "read",
        workspaceBoundary: "strict",
      }),
    ).toBe(join(sandbox.workspaceLink, "inside.txt"));
    expect(
      resolveWorkspacePath({
        inputPath: "dir/nested.txt",
        workingDirectory: sandbox.workspaceLink,
        workspaceRoot: sandbox.workspaceLink,
        operation: "read",
        workspaceBoundary: "strict",
      }),
    ).toBe(join(sandbox.workspaceLink, "dir", "nested.txt"));
  });
});

describe("workspaceBoundary=allow", () => {
  it("keeps the legacy out-of-workspace path allowed by default", () => {
    // resolve() 折叠 `..`，因此返回值是归一化后的外部路径。
    expect(resolveIn("../outside/secret.txt")).toBe(join(sandbox.outside, "secret.txt"));
    expect(resolveIn(join(sandbox.outside, "secret.txt"))).toBe(
      join(sandbox.outside, "secret.txt"),
    );
  });

  it("allows an escaped path with explicit allow and reports an audit event", () => {
    const events: WorkspaceBoundaryAuditEvent[] = [];
    const path = resolveIn("../outside/secret.txt", {
      workspaceBoundary: "allow",
      auditWorkspaceBoundary: (event) => events.push(event),
    });
    expect(path).toBe(join(sandbox.outside, "secret.txt"));
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

  it("does not emit an audit event for contained paths", () => {
    const events: WorkspaceBoundaryAuditEvent[] = [];
    resolveIn("inside.txt", {
      workspaceBoundary: "allow",
      auditWorkspaceBoundary: (event) => events.push(event),
    });
    expect(events).toEqual([]);
  });

  it("does not let a throwing audit callback change the result", () => {
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

describe("workspaceBoundary=ask", () => {
  it("asks the approval port with a path preview before allowing", () => {
    const requests: WorkspaceBoundaryApprovalRequest[] = [];
    const events: WorkspaceBoundaryAuditEvent[] = [];
    const path = resolveIn(join(sandbox.outside, "secret.txt"), {
      workspaceBoundary: "ask",
      workspaceBoundaryApproval: {
        decide: (request) => {
          requests.push(request);
          return { decision: "allow" };
        },
      },
      auditWorkspaceBoundary: (event) => events.push(event),
    });
    expect(path).toBe(join(sandbox.outside, "secret.txt"));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      operation: "read",
      requestedPath: join(sandbox.outside, "secret.txt"),
      resolvedPath: join(sandbox.outside, "secret.txt"),
      workspaceRoot: sandbox.workspace,
      escapeKind: "lexical",
    });
    expect(requests[0]!.summary).toContain("outside workspace");
    expect(events.map((event) => event.action)).toEqual(["approve"]);
  });

  it("denies the path when the approval port denies it", () => {
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

  it("fails closed with permission_escalation when no approval port is wired", () => {
    const error = expectCoreError(
      () => resolveIn("../outside/secret.txt", { workspaceBoundary: "ask" }),
      CoreErrorType.PermissionEscalation,
    );
    expect(error.recoverable).toBe(true);
    expect(error.context).toMatchObject({ workspaceBoundary: "ask", escapeKind: "lexical" });
  });

  it("treats a throwing approval port as a denial", () => {
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

  it.skipIf(windows)("routes a symlink escape through the approval port", () => {
    const requests: string[] = [];
    const error = expectCoreError(
      () =>
        resolveIn(sandbox.symlinks.fileOut, {
          workspaceBoundary: "ask",
          workspaceBoundaryApproval: {
            decide: (request) => {
              requests.push(request.escapeKind);
              return { decision: "deny" };
            },
          },
        }),
      CoreErrorType.PermissionDenied,
    );
    expect(requests).toEqual(["symlink"]);
    expect(error.context).toMatchObject({ escapeKind: "symlink" });
  });
});

describe("workspaceBoundary wiring", () => {
  it("rejects an unsafe tool working directory in strict mode", () => {
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
  });

  it("keeps the default tool working directory untouched", () => {
    expect(
      resolveToolWorkingDirectory(undefined, {
        operation: "execute",
        workingDirectory: sandbox.workspace,
        workspaceRoot: sandbox.workspace,
        workspaceBoundary: "strict",
      }),
    ).toBe(sandbox.workspace);
  });

  it("fails closed on an unknown boundary mode", () => {
    expectCoreError(
      () =>
        resolveIn("inside.txt", {
          workspaceBoundary: "permissive" as unknown as WorkspaceBoundaryMode,
        }),
      CoreErrorType.ConfigurationError,
    );
  });

  it("reports the real physical workspace root for a symlinked root", () => {
    if (windows) return;
    const events: WorkspaceBoundaryAuditEvent[] = [];
    const path = resolveWorkspacePath({
      inputPath: "file-out.txt",
      workingDirectory: sandbox.workspaceLink,
      workspaceRoot: sandbox.workspaceLink,
      operation: "read",
      workspaceBoundary: "allow",
      auditWorkspaceBoundary: (event) => events.push(event),
    });
    expect(path).toBe(join(sandbox.workspaceLink, "file-out.txt"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "allow",
      escapeKind: "symlink",
      physicalWorkspaceRoot: sandbox.realWorkspace,
      physicalPath: join(sandbox.realOutside, "secret.txt"),
    });
  });
});

describe("platform containment matrix", () => {
  it("treats win32 paths case-insensitively and rejects sibling prefixes", () => {
    expect(isPathWithinWorkspaceRoot("C:\\ws\\a.txt", "C:\\ws", "win32")).toBe(true);
    expect(isPathWithinWorkspaceRoot("C:\\ws", "C:\\ws", "win32")).toBe(true);
    expect(isPathWithinWorkspaceRoot("C:\\WS\\a.txt", "c:\\ws", "win32")).toBe(true);
    expect(isPathWithinWorkspaceRoot("C:\\ws2\\a.txt", "C:\\ws", "win32")).toBe(false);
    expect(isPathWithinWorkspaceRoot("D:\\ws\\a.txt", "C:\\ws", "win32")).toBe(false);
  });

  it("does not treat a posix prefix sibling as contained", () => {
    expect(isPathWithinWorkspaceRoot("/ws/a.txt", "/ws", "linux")).toBe(true);
    expect(isPathWithinWorkspaceRoot("/ws2/a.txt", "/ws", "linux")).toBe(false);
    expect(isPathWithinWorkspaceRoot("/ws/../ws/a.txt", "/ws", "linux")).toBe(true);
    expect(isPathWithinWorkspaceRoot("/ws/../outside/a.txt", "/ws", "linux")).toBe(false);
  });
});
