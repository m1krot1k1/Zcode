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
});
