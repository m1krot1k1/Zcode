import { describe, expect, it, vi } from "vitest";
import {
  createSessionId,
  createTraceId,
  type McpConnectionSnapshot,
  type McpPort,
  type McpServerStatus,
  type McpToolDescriptor,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { resolveSubagentMcpAccess } from "../src/runtime/methods/subagent/mcp-access.js";

const connected = (toolCount = 1): McpServerStatus => ({
  status: "connected",
  transport: "stdio",
  toolCount,
  updatedAt: "now",
});

const descriptor = (serverName: string, toolName: string): McpToolDescriptor => ({
  serverName,
  toolName,
  inputSchema: { type: "object" },
});

describe("subagent MCP live snapshot", () => {
  it("sees an MCP server connected after runtime startup without reload", async () => {
    const sessionId = createSessionId("subagent-mcp-live-snapshot");
    const traceContext = { sessionId, traceId: createTraceId() };
    const live: McpConnectionSnapshot = {
      statuses: { late: connected() },
      tools: [descriptor("late", "echo")],
    };
    const currentSnapshot = vi.fn(async () => live);
    const mcpPort: McpPort = {
      connectConfiguredServers: async () => ({ statuses: {}, tools: [] }),
      connectServer: async () => connected(),
      disconnectServer: async () => undefined,
      status: async () => ({}),
      listTools: async () => [],
      currentSnapshot,
      callTool: async () => ({ content: [{ type: "text", text: "pong" }] }),
      close: async () => {},
    };
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        workingDirectory: "/workspace/project",
        mcp: { enabled: true, servers: {} },
      },
      {
        eventStore: createTestSessionEventStore(),
        mcpPort,
        modelFactory: createTestModelFactory({}),
      },
    );
    const internal = runtime as any;
    await internal.mcpStartupPromise;

    const access = await resolveSubagentMcpAccess.call(
      internal,
      {
        agentId: "late-agent",
        agentType: "late-agent",
        allowedTools: [],
        background: false,
        sessionId,
        description: "Use late MCP",
        prompt: "Call the late server",
        profile: {
          name: "late-agent",
          description: "Late MCP",
          source: "project",
          systemPrompt: "",
          mcpServers: ["late"],
        },
        workingDirectory: "/workspace/project",
        workspaceRoot: "/workspace/project",
        traceContext,
      },
      new Set(),
    );

    expect(currentSnapshot).toHaveBeenCalledTimes(1);
    expect(access.snapshot?.statuses.late).toEqual(connected());
    expect(access.snapshot?.tools).toEqual([descriptor("late", "echo")]);
    await expect(access.port?.listTools()).resolves.toEqual([descriptor("late", "echo")]);
    await expect(access.port?.callTool({ serverName: "late", toolName: "echo" })).resolves.toEqual({
      content: [{ type: "text", text: "pong" }],
    });
  });

  it("applies a live plugin MCP server and removes it on disable", async () => {
    const sessionId = createSessionId("subagent-plugin-mcp-live");
    const traceContext = { sessionId, traceId: createTraceId() };
    const live: McpConnectionSnapshot = { statuses: {}, tools: [] };
    const mcpPort: McpPort = {
      connectConfiguredServers: async () => ({ statuses: {}, tools: [] }),
      connectServer: async (serverName) => {
        live.statuses[serverName] = connected();
        live.tools = [descriptor(serverName, "echo")];
        return live.statuses[serverName]!;
      },
      disconnectServer: async (serverName) => {
        delete live.statuses[serverName];
        live.tools = live.tools.filter((tool) => tool.serverName !== serverName);
        return undefined;
      },
      status: async () => live.statuses,
      listTools: async () => live.tools,
      currentSnapshot: async () => live,
      callTool: async () => ({ content: [{ type: "text", text: "pong" }] }),
      close: async () => {},
    };
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build", workingDirectory: "/workspace/project", mcp: { enabled: true, servers: {} } },
      { eventStore: createTestSessionEventStore(), mcpPort, modelFactory: createTestModelFactory({}) },
    );
    const internal = runtime as any;
    await internal.mcpStartupPromise;

    await expect(
      runtime.applyPluginRuntime({
        mcpServers: { plugin: { type: "stdio", command: "node" } },
        previousPluginMcpServerNames: [],
        preservedMcpServerNames: [],
        reloadAgentDefinitions: false,
        signal: new AbortController().signal,
        traceContext,
      }),
    ).resolves.toMatchObject({ connected: ["plugin"], disconnected: [], failed: [] });

    const access = await resolveSubagentMcpAccess.call(
      internal,
      {
        agentId: "plugin-agent",
        agentType: "plugin-agent",
        allowedTools: [],
        background: false,
        sessionId,
        description: "Use plugin MCP",
        prompt: "Call plugin MCP",
        profile: {
          name: "plugin-agent",
          description: "Plugin MCP",
          source: "project",
          systemPrompt: "",
          mcpServers: ["plugin"],
        },
        workingDirectory: "/workspace/project",
        workspaceRoot: "/workspace/project",
        traceContext,
      },
      new Set(),
    );
    expect(access.snapshot?.tools).toEqual([descriptor("plugin", "echo")]);

    const requiredAccess = await resolveSubagentMcpAccess.call(
      internal,
      {
        agentId: "required-plugin-agent",
        agentType: "required-plugin-agent",
        allowedTools: ["Read"],
        requiredCapabilities: ["mcp:plugin"],
        background: false,
        sessionId,
        description: "Required plugin MCP",
        prompt: "Call required plugin MCP",
        profile: {
          name: "required-plugin-agent",
          description: "Required plugin MCP",
          source: "project",
          systemPrompt: "",
        },
        workingDirectory: "/workspace/project",
        workspaceRoot: "/workspace/project",
        traceContext,
      },
      new Set(),
    );
    expect(requiredAccess.snapshot?.tools).toEqual([descriptor("plugin", "echo")]);

    await expect(
      runtime.applyPluginRuntime({
        mcpServers: {},
        previousPluginMcpServerNames: ["plugin"],
        preservedMcpServerNames: [],
        reloadAgentDefinitions: false,
        signal: new AbortController().signal,
        traceContext,
      }),
    ).resolves.toMatchObject({ connected: [], disconnected: ["plugin"], failed: [] });
    expect(live.statuses.plugin).toBeUndefined();
    expect(internal.config.mcp.servers.plugin).toBeUndefined();
  });
});
