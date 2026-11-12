import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultRuntimeConfig,
  type McpHttpServerConfig,
  type McpPort,
  type McpServerConfig,
  type McpStdioServerConfig,
} from "@zcode/contracts";
import { createConfig } from "@zcode/adapters/config";
import { describe, expect, it, vi } from "vitest";
import { listMcpServerStatuses } from "../src/mcp-config.js";
import { createSessionFacade } from "../src/app/session-facade.js";
import {
  computeMcpServerDefinitionDigest,
  createMcpProjectApprovalRecord,
  grantMcpProjectTrust,
  readMcpProjectTrustRecords,
  resolveAppRuntimeConfig,
  resolveMcpProjectTrustStorePath,
  resolveUntrustedProjectMcpServers,
} from "../src/app/runtime-config.js";
import { listMcpServers } from "../src/zcode-protocol/mcp.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
const PROJECT_ROOT = "/workspace/project";

const baseStdio: McpStdioServerConfig = {
  type: "stdio",
  command: "node",
  args: ["server.js"],
};

const baseHttp: McpHttpServerConfig = {
  type: "http",
  url: "https://mcp.example.test/mcp",
};

function approvalFor(
  config: McpServerConfig,
  options: { serverName?: string; workspaceIdentity?: string } = {},
) {
  return createMcpProjectApprovalRecord({
    workspaceIdentity: options.workspaceIdentity ?? PROJECT_ROOT,
    serverName: options.serverName ?? "project-server",
    config,
  });
}

async function tempRoot(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

async function writeProjectConfig(
  workspace: string,
  servers: Record<string, unknown>,
): Promise<string> {
  const configPath = join(workspace, ".zcode", "config.json");
  await mkdir(join(workspace, ".zcode"), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({ mcp: { servers } }, null, 2)}\n`, "utf8");
  return configPath;
}

describe("MCP project-scope definition digest", () => {
  it("is stable for the same semantics and independent of env key order", () => {
    const left: McpServerConfig = {
      type: "stdio",
      command: "node",
      args: ["server.js", "--flag"],
      env: { B: "2", A: "1" },
    };
    const right: McpServerConfig = {
      type: "stdio",
      command: "node",
      args: ["server.js", "--flag"],
      env: { A: "1", B: "2" },
    };

    expect(computeMcpServerDefinitionDigest(left)).toBe(
      computeMcpServerDefinitionDigest(right),
    );
    expect(computeMcpServerDefinitionDigest(left)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("ignores `enabled` because it is configuration state, not execution content", () => {
    const enabled = computeMcpServerDefinitionDigest({ ...baseStdio, enabled: true });
    const disabled = computeMcpServerDefinitionDigest({ ...baseStdio, enabled: false });

    expect(enabled).toBe(disabled);
  });

  it.each([
    {
      label: "command",
      mutate: (): McpServerConfig => ({ type: "stdio", command: "bash", args: ["server.js"] }),
    },
    {
      label: "args",
      mutate: (): McpServerConfig => ({
        type: "stdio",
        command: "node",
        args: ["server.js", "--evil"],
      }),
    },
    {
      label: "env",
      mutate: (): McpServerConfig => ({
        type: "stdio",
        command: "node",
        args: ["server.js"],
        env: { TOKEN: "changed" },
      }),
    },
    {
      label: "cwd",
      mutate: (): McpServerConfig => ({
        type: "stdio",
        command: "node",
        args: ["server.js"],
        cwd: "/tmp/other",
      }),
    },
    {
      label: "timeoutMs",
      mutate: (): McpServerConfig => ({
        type: "stdio",
        command: "node",
        args: ["server.js"],
        timeoutMs: 1000,
      }),
    },
  ])("changes when $label changes", ({ mutate }) => {
    expect(computeMcpServerDefinitionDigest(mutate())).not.toBe(
      computeMcpServerDefinitionDigest(baseStdio),
    );
  });

  it.each([
    {
      label: "url",
      mutate: (): McpServerConfig => ({
        type: "http",
        url: "https://attacker.example.test/mcp",
      }),
    },
    {
      label: "headers",
      mutate: (): McpServerConfig => ({
        type: "http",
        url: "https://mcp.example.test/mcp",
        headers: { Authorization: "Bearer changed" },
      }),
    },
    {
      label: "transport",
      mutate: (): McpServerConfig => ({
        type: "sse",
        url: "https://mcp.example.test/mcp",
      }),
    },
  ])("changes when $label changes", ({ mutate }) => {
    expect(computeMcpServerDefinitionDigest(mutate())).not.toBe(
      computeMcpServerDefinitionDigest(baseHttp),
    );
  });

  it("never leaks secret inputs into the digest output", () => {
    const digest = computeMcpServerDefinitionDigest({
      type: "stdio",
      command: "node",
      env: { API_TOKEN: "super-secret-token-value" },
    });

    expect(digest).not.toContain("super-secret-token-value");
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("project-scope MCP untrusted resolution", () => {
  it("treats every project-scope server as untrusted when no approval snapshot exists", () => {
    const untrusted = resolveUntrustedProjectMcpServers({
      configuredMcpServers: { "project-server": baseStdio },
      serverSources: { "project-server": "project" },
      trust: undefined,
    });

    expect([...untrusted]).toEqual(["project-server"]);
  });

  it("accepts a matching approval and rejects a digest mismatch", () => {
    const approved = resolveUntrustedProjectMcpServers({
      configuredMcpServers: { "project-server": baseStdio },
      serverSources: { "project-server": "project" },
      trust: {
        workspaceIdentity: PROJECT_ROOT,
        approvals: [approvalFor(baseStdio)],
      },
    });
    expect([...approved]).toEqual([]);

    const stale = resolveUntrustedProjectMcpServers({
      configuredMcpServers: { "project-server": { ...baseStdio, command: "bash" } },
      serverSources: { "project-server": "project" },
      trust: {
        workspaceIdentity: PROJECT_ROOT,
        approvals: [approvalFor(baseStdio)],
      },
    });
    expect([...stale]).toEqual(["project-server"]);
  });

  it("does not reuse an approval across workspaces or server names", () => {
    const otherWorkspace = resolveUntrustedProjectMcpServers({
      configuredMcpServers: { "project-server": baseStdio },
      serverSources: { "project-server": "project" },
      trust: {
        workspaceIdentity: "/workspace/other",
        approvals: [approvalFor(baseStdio)],
      },
    });
    expect([...otherWorkspace]).toEqual(["project-server"]);

    const otherName = resolveUntrustedProjectMcpServers({
      configuredMcpServers: { "renamed-server": baseStdio },
      serverSources: { "renamed-server": "project" },
      trust: {
        workspaceIdentity: PROJECT_ROOT,
        approvals: [approvalFor(baseStdio)],
      },
    });
    expect([...otherName]).toEqual(["renamed-server"]);
  });

  it("requires re-approval after command, args, env, or url changes", () => {
    // R01 验收：approval 绑定执行语义，任一显著字段变化都必须让旧批准失效。
    // 这里同时覆盖 runtime 的 untrusted 判定，避免只有 digest 单测而缺少消费侧证据。
    const approvedStdio: McpStdioServerConfig = {
      type: "stdio",
      command: "node",
      args: ["server.js"],
      env: { TOKEN: "original" },
    };
    const stdioApproval = approvalFor(approvedStdio);
    const changedStdio: McpServerConfig[] = [
      { ...approvedStdio, command: "bash" },
      { ...approvedStdio, args: ["server.js", "--evil"] },
      { ...approvedStdio, env: { TOKEN: "changed" } },
    ];
    for (const changed of changedStdio) {
      const untrusted = resolveUntrustedProjectMcpServers({
        configuredMcpServers: { "project-server": changed },
        serverSources: { "project-server": "project" },
        trust: { workspaceIdentity: PROJECT_ROOT, approvals: [stdioApproval] },
      });
      expect([...untrusted]).toEqual(["project-server"]);
    }

    const approvedHttp: McpHttpServerConfig = {
      type: "http",
      url: "https://mcp.example.test/mcp",
    };
    const httpApproval = approvalFor(approvedHttp);
    const changedHttp: McpServerConfig[] = [
      { type: "http", url: "https://attacker.example.test/mcp" },
      { type: "sse", url: "https://mcp.example.test/mcp" },
    ];
    for (const changed of changedHttp) {
      const untrusted = resolveUntrustedProjectMcpServers({
        configuredMcpServers: { "project-server": changed },
        serverSources: { "project-server": "project" },
        trust: { workspaceIdentity: PROJECT_ROOT, approvals: [httpApproval] },
      });
      expect([...untrusted]).toEqual(["project-server"]);
    }
  });

  it("keeps user-scope and host-provided servers auto-approved", () => {
    const untrusted = resolveUntrustedProjectMcpServers({
      configuredMcpServers: { "user-server": baseStdio, context7: baseHttp },
      serverSources: { "user-server": "user", context7: "cli" },
      trust: undefined,
    });

    expect([...untrusted]).toEqual([]);
  });

  it("never gates host-owned servers even when a project config declares the same name", () => {
    // node_repl 等宿主内建 server 合并优先级最高；项目里同名声明的只是被覆盖的低优先条目，
    // 不能因为 config 标签仍是 project 就把宿主 server 判成 untrusted。
    const untrusted = resolveUntrustedProjectMcpServers({
      configuredMcpServers: { node_repl: baseStdio },
      serverSources: { node_repl: "project" },
      trust: undefined,
      hostOwnedServerNames: new Set(["node_repl"]),
    });

    expect([...untrusted]).toEqual([]);
  });
});

describe("project-scope MCP approval store", () => {
  it("round-trips an approval without persisting the definition", async () => {
    const storageRoot = await tempRoot("zcode-mcp-trust-store-");
    try {
      const record = approvalFor({
        type: "stdio",
        command: "node",
        env: { API_TOKEN: "super-secret-token-value" },
      });
      await grantMcpProjectTrust({ storageRoot, record });

      const records = await readMcpProjectTrustRecords(storageRoot);
      expect(records).toEqual([record]);
      const raw = await readFile(resolveMcpProjectTrustStorePath(storageRoot), "utf8");
      expect(raw).not.toContain("super-secret-token-value");
      expect(raw).not.toContain("node");
    } finally {
      await rm(storageRoot, { force: true, recursive: true });
    }
  });

  it("is idempotent for the same approval and keeps distinct approvals", async () => {
    const storageRoot = await tempRoot("zcode-mcp-trust-idempotent-");
    try {
      const record = approvalFor(baseStdio);
      await grantMcpProjectTrust({ storageRoot, record });
      await grantMcpProjectTrust({ storageRoot, record });
      await grantMcpProjectTrust({
        storageRoot,
        record: approvalFor({ ...baseStdio, command: "bash" }),
      });

      const records = await readMcpProjectTrustRecords(storageRoot);
      expect(records).toHaveLength(2);
    } finally {
      await rm(storageRoot, { force: true, recursive: true });
    }
  });

  it("fails closed on a corrupt store", async () => {
    const storageRoot = await tempRoot("zcode-mcp-trust-corrupt-");
    try {
      const storePath = resolveMcpProjectTrustStorePath(storageRoot);
      await mkdir(join(storageRoot, "security"), { recursive: true });
      await writeFile(storePath, "{not json", "utf8");

      await expect(readMcpProjectTrustRecords(storageRoot)).resolves.toEqual([]);
    } finally {
      await rm(storageRoot, { force: true, recursive: true });
    }
  });

  it("drops records with a non-hex digest instead of trusting them", async () => {
    const storageRoot = await tempRoot("zcode-mcp-trust-invalid-digest-");
    try {
      const storePath = resolveMcpProjectTrustStorePath(storageRoot);
      await mkdir(join(storageRoot, "security"), { recursive: true });
      await writeFile(
        storePath,
        JSON.stringify({
          schemaVersion: 1,
          records: [
            {
              workspaceIdentity: PROJECT_ROOT,
              serverName: "project-server",
              definitionDigest: "not-a-digest",
              decision: "approved",
              grantedAt: "2026-11-11T00:00:00.000Z",
            },
          ],
        }),
        "utf8",
      );

      await expect(readMcpProjectTrustRecords(storageRoot)).resolves.toEqual([]);
    } finally {
      await rm(storageRoot, { force: true, recursive: true });
    }
  });
});

describe("resolveAppRuntimeConfig project MCP gating", () => {
  it("keeps a project server out of the runtime set until it is approved", async () => {
    const workspace = await tempRoot("zcode-mcp-app-untrusted-");
    try {
      await writeProjectConfig(workspace, {
        "project-server": { type: "stdio", command: "node", args: ["server.js"] },
      });
      const configResult = createConfig({
        env: {},
        skipUserConfig: true,
        workingDirectory: workspace,
      });
      expect(configResult.sources.mcp.serverSources["project-server"]).toBe("project");

      const baseInput = {
        cliStorageRoot: join(workspace, "cli"),
        configResult,
        options: {},
        subagentOutputRootDir: join(workspace, "agents"),
        storageRoot: workspace,
        workingDirectory: workspace,
      };
      const effectiveConfig = configResult.config.mcp.servers["project-server"];
      expect(effectiveConfig).toBeDefined();

      const withoutApproval = resolveAppRuntimeConfig(baseInput);
      expect(withoutApproval.untrustedProjectMcpServers.has("project-server")).toBe(true);
      expect(withoutApproval.runtimeConfig.mcp?.servers?.["project-server"]).toBeUndefined();
      expect(withoutApproval.configuredMcpServers["project-server"]).toBeDefined();

      const withApproval = resolveAppRuntimeConfig({
        ...baseInput,
        projectMcpTrust: {
          workspaceIdentity: workspace,
          approvals: [approvalFor(effectiveConfig!, { workspaceIdentity: workspace })],
        },
      });
      expect(withApproval.untrustedProjectMcpServers.has("project-server")).toBe(false);
      expect(withApproval.runtimeConfig.mcp?.servers?.["project-server"]).toBeDefined();
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("does not gate protocol-provided user-scope servers", async () => {
    const workspace = await tempRoot("zcode-mcp-app-user-");
    try {
      const configResult = createConfig({
        env: {},
        skipUserConfig: true,
        workingDirectory: workspace,
      });
      const resolved = resolveAppRuntimeConfig({
        cliStorageRoot: join(workspace, "cli"),
        configResult,
        options: {
          runtimeConfig: {
            mcp: { enabled: true, servers: { "user-server": baseStdio } },
            workingDirectory: workspace,
          },
        },
        subagentOutputRootDir: join(workspace, "agents"),
        storageRoot: workspace,
        workingDirectory: workspace,
      });

      expect([...resolved.untrustedProjectMcpServers]).toEqual([]);
      expect(resolved.runtimeConfig.mcp?.servers?.["user-server"]).toBeDefined();
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });
});

describe("untrusted status projection", () => {
  it("renders untrusted with a fixed error and no definition values", async () => {
    const statuses = await listMcpServerStatuses(
      undefined,
      { "project-server": baseStdio },
      new Set(["project-server"]),
    );
    const status = statuses["project-server"];
    expect(status).toMatchObject({
      status: "untrusted",
      failureKind: "status_unavailable",
      transport: "stdio",
      error: "Project MCP server requires explicit connection before use.",
    });
    expect(status?.error).not.toContain("server.js");
    expect(status?.error).not.toContain("node");
  });
});

describe("mcp/list project MCP gating", () => {
  /**
   * listMcpServers 内部调用 createConfig()，会读 `~/.zcode/cli/config.json`。
   * 用临时 HOME + ZCODE_STORAGE_DIR 把真实用户目录隔离出去，否则本机已装的
   * server 会混进断言，测试也不再可重复。
   */
  async function withIsolatedHome<T>(run: () => Promise<T>): Promise<T> {
    const home = await tempRoot("zcode-mcp-list-home-");
    const previousHome = process.env.HOME;
    const previousStorageDir = process.env.ZCODE_STORAGE_DIR;
    process.env.HOME = home;
    process.env.ZCODE_STORAGE_DIR = join(home, "storage");
    try {
      return await run();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousStorageDir === undefined) delete process.env.ZCODE_STORAGE_DIR;
      else process.env.ZCODE_STORAGE_DIR = previousStorageDir;
      await rm(home, { force: true, recursive: true });
    }
  }

  it("does not auto-connect an unapproved project server and connects it after approval", async () => {
    const workspace = await tempRoot("zcode-mcp-list-project-");
    try {
      await withIsolatedHome(async () => {
        const storageRoot = join(process.env.HOME!, "storage");
        const serverConfig = { type: "stdio", command: "node", args: ["server.js"] };
        await writeProjectConfig(workspace, { "project-server": serverConfig });
        const effectiveConfig: McpServerConfig = {
          type: "stdio",
          command: "node",
          args: ["server.js"],
          // project 配置归一化会把相对 cwd 固化为 workspace 根。
          cwd: workspace,
        };

        const connectConfiguredServers = vi.fn(async () => ({ statuses: {}, tools: [] }));
        const mcpPort = {
          callTool: vi.fn(),
          close: vi.fn(async () => undefined),
          connectConfiguredServers,
          connectServer: vi.fn(),
          disconnectServer: vi.fn(),
          listTools: vi.fn(async () => []),
          status: vi.fn(async () => ({})),
        } as unknown as McpPort;
        const context = {
          deps: { env: process.env, mcpPort },
        } as unknown as ZCodeProtocolAgentServerContext;
        const params = {
          workspace: { workspaceKey: workspace, workspacePath: workspace },
        };

        await listMcpServers(context, params);
        const unapprovedServers = connectConfiguredServers.mock.calls[0]?.[0] as
          | Record<string, McpServerConfig>
          | undefined;
        expect(unapprovedServers?.["project-server"]).toBeUndefined();

        connectConfiguredServers.mockClear();
        await grantMcpProjectTrust({
          storageRoot,
          record: approvalFor(effectiveConfig, { workspaceIdentity: workspace }),
        });

        const result = await listMcpServers(context, params);
        const approvedServers = connectConfiguredServers.mock.calls[0]?.[0] as
          | Record<string, McpServerConfig>
          | undefined;
        expect(approvedServers?.["project-server"]).toBeDefined();
        expect(result.statuses["project-server"]?.status).not.toBe("untrusted");
      });
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("projects untrusted status instead of connecting in status mode", async () => {
    const workspace = await tempRoot("zcode-mcp-list-status-");
    try {
      await withIsolatedHome(async () => {
        await writeProjectConfig(workspace, {
          "project-server": { type: "stdio", command: "node", args: ["server.js"] },
        });
        const connectConfiguredServers = vi.fn(async () => ({ statuses: {}, tools: [] }));
        const mcpPort = {
          callTool: vi.fn(),
          close: vi.fn(async () => undefined),
          connectConfiguredServers,
          connectServer: vi.fn(),
          disconnectServer: vi.fn(),
          listTools: vi.fn(async () => []),
          status: vi.fn(async () => ({})),
        } as unknown as McpPort;
        const context = {
          deps: { env: process.env, mcpPort },
        } as unknown as ZCodeProtocolAgentServerContext;

        const result = await listMcpServers(context, {
          workspace: { workspaceKey: workspace, workspacePath: workspace },
          mode: "status",
        });

        expect(connectConfiguredServers).not.toHaveBeenCalled();
        expect(result.statuses["project-server"]).toMatchObject({
          status: "untrusted",
          failureKind: "status_unavailable",
        });
      });
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });
});

describe("explicit connect approval", () => {
  function createFacade(input: {
    approveProjectMcpServer?: (value: {
      name: string;
      config: McpServerConfig;
    }) => Promise<void>;
    untrusted: Set<string>;
  }) {
    const connectServer = vi.fn(async () => ({
      status: "connected" as const,
      transport: "stdio" as const,
      toolCount: 0,
      updatedAt: "2026-11-11T00:00:00.000Z",
    }));
    const facade = createSessionFacade({
      configResult: { config: DefaultRuntimeConfig },
      configuredMcpServers: { "project-server": baseStdio },
      logger: { info: vi.fn(), warn: vi.fn() },
      mcpPort: { connectServer, disconnectServer: vi.fn() },
      ownsExecutionPort: false,
      ownsMcpPort: false,
      ownsSessionStore: false,
      prepareResume: async () => {},
      prepareUserExecutionBoundary: async () => {},
      resolveUiLocale: () => "en-US",
      runtime: {} as never,
      sessionId: "session",
      sessionStore: {},
      traceContext: { traceId: "trace" },
      untrustedProjectMcpServers: input.untrusted,
      workingDirectory: PROJECT_ROOT,
      ...(input.approveProjectMcpServer
        ? { approveProjectMcpServer: input.approveProjectMcpServer }
        : {}),
    } as never);
    return { facade, connectServer };
  }

  it("refuses to connect an untrusted project server without an approval writer", async () => {
    const { facade, connectServer } = createFacade({ untrusted: new Set(["project-server"]) });

    await expect(facade.connectMcpServer("project-server")).rejects.toThrow(
      "Project MCP server requires explicit approval before use: project-server",
    );
    expect(connectServer).not.toHaveBeenCalled();
  });

  it("records approval before connecting and clears the runtime untrusted mark", async () => {
    const approve = vi.fn(async () => undefined);
    const untrusted = new Set(["project-server"]);
    const { facade, connectServer } = createFacade({
      approveProjectMcpServer: approve,
      untrusted,
    });

    await facade.connectMcpServer("project-server");

    expect(approve).toHaveBeenCalledWith({ name: "project-server", config: baseStdio });
    expect(connectServer).toHaveBeenCalledTimes(1);
    expect(untrusted.has("project-server")).toBe(false);

    // 第二次连接不再写入授权（本 session 已经放行）。
    await facade.connectMcpServer("project-server");
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it("does not write approval when the store write fails", async () => {
    const approve = vi.fn(async () => {
      throw new Error("store write failed");
    });
    const untrusted = new Set(["project-server"]);
    const { facade, connectServer } = createFacade({
      approveProjectMcpServer: approve,
      untrusted,
    });

    await expect(facade.connectMcpServer("project-server")).rejects.toThrow(
      "store write failed",
    );
    expect(connectServer).not.toHaveBeenCalled();
    expect(untrusted.has("project-server")).toBe(true);
  });
});
