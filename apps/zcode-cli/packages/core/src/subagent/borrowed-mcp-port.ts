import type { McpConnectionSnapshot, McpPort } from "@zcode/contracts";
import { SUBAGENT_COMPUTER_USE_UNAVAILABLE_MESSAGE } from "./computer-use-policy.js";

interface BorrowedSubagentMcpAccess {
  port: McpPort;
  snapshot: McpConnectionSnapshot;
}

export function createBorrowedSubagentMcpAccess(
  parentPort: McpPort,
  parentStartupSnapshot: McpConnectionSnapshot,
  scopedServerNames?: readonly string[],
  deniedServerNames?: ReadonlySet<string>,
): BorrowedSubagentMcpAccess {
  const scope = scopedServerNames === undefined ? undefined : new Set(scopedServerNames);
  const isDenied = (serverName: string): boolean => deniedServerNames?.has(serverName) === true;
  const isInScope = (serverName: string): boolean =>
    (scope === undefined || scope.has(serverName)) && !isDenied(serverName);
  const filterSnapshot = (source: McpConnectionSnapshot): McpConnectionSnapshot => {
    const statuses = Object.fromEntries(
      Object.entries(source.statuses).filter(([serverName]) => isInScope(serverName)),
    );
    const connectedServerNames = new Set(
      Object.entries(statuses)
        .filter(([, status]) => status.status === "connected")
        .map(([serverName]) => serverName),
    );
    return {
      statuses,
      tools: source.tools.filter(
        (descriptor) =>
          isInScope(descriptor.serverName) && connectedServerNames.has(descriptor.serverName),
      ),
    };
  };
  const snapshot = filterSnapshot(parentStartupSnapshot);
  const rejectLifecycleMutation = (): never => {
    // child 借用 parent adapter，不拥有 MCP 连接生命周期。
    throw new Error("Subagent MCP port cannot mutate parent connection lifecycle");
  };

  return {
    snapshot,
    port: {
      async callTool(request, options) {
        if (isDenied(request.serverName)) {
          throw new Error(SUBAGENT_COMPUTER_USE_UNAVAILABLE_MESSAGE);
        }
        if (!isInScope(request.serverName)) {
          throw new Error(`Subagent MCP server is outside visible scope: ${request.serverName}`);
        }
        if (snapshot.statuses[request.serverName]?.status !== "connected") {
          throw new Error(`Subagent MCP server is not connected: ${request.serverName}`);
        }
        return parentPort.callTool(request, options);
      },
      async close() {
        // child 结束时不向 parent adapter 传播 close。
      },
      async connectConfiguredServers() {
        return rejectLifecycleMutation();
      },
      async connectServer() {
        return rejectLifecycleMutation();
      },
      async disconnectServer() {
        return rejectLifecycleMutation();
      },
      async listTools() {
        return [...snapshot.tools];
      },
      async currentSnapshot() {
        // Вложенный orchestrator тоже должен видеть MCP, установленный его дочерью:
        // поднимаем live-снимок к корневому adapter, а не повторяем собственный startup.
        const current = parentPort.currentSnapshot
          ? await parentPort.currentSnapshot()
          : parentStartupSnapshot;
        return filterSnapshot(current);
      },
      async status() {
        return { ...snapshot.statuses };
      },
    },
  };
}
