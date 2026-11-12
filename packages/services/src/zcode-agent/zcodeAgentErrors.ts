// 原始 -32602 文案来自旧 Agent schema，跨 RPC 后 UI 不能靠易变字符串识别能力缺失。
// ChannelClient 会保留 error.code，因此用稳定 code 驱动设置页停止 status-only 轮询。
export const ZCODE_AGENT_MCP_STATUS_MODE_UNSUPPORTED_ERROR_CODE =
  "ZCODE_AGENT_MCP_STATUS_MODE_UNSUPPORTED";

export class ZCodeAgentMcpStatusModeUnsupportedError extends Error {
  readonly code = ZCODE_AGENT_MCP_STATUS_MODE_UNSUPPORTED_ERROR_CODE;

  constructor() {
    super("The connected ZCode Agent does not support MCP status-only refresh");
    this.name = "ZCodeAgentMcpStatusModeUnsupportedError";
  }
}

export function isZCodeAgentMcpStatusModeUnsupportedError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  return (error as { code?: unknown }).code === ZCODE_AGENT_MCP_STATUS_MODE_UNSUPPORTED_ERROR_CODE;
}

/**
 * 旧 Agent 不认识 `mcp/connect`（-32601）。显式连接不能回退到旧路径，
 * 由稳定 code 让设置页提示升级/重启，而不是把 method-not-found 原文暴露给用户。
 */
export const ZCODE_AGENT_MCP_CONNECT_UNSUPPORTED_ERROR_CODE = "ZCODE_AGENT_MCP_CONNECT_UNSUPPORTED";

export class ZCodeAgentMcpConnectUnsupportedError extends Error {
  readonly code = ZCODE_AGENT_MCP_CONNECT_UNSUPPORTED_ERROR_CODE;

  constructor() {
    super("The connected ZCode Agent does not support explicit MCP connection");
    this.name = "ZCodeAgentMcpConnectUnsupportedError";
  }
}

export function isZCodeAgentMcpConnectUnsupportedError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  return (error as { code?: unknown }).code === ZCODE_AGENT_MCP_CONNECT_UNSUPPORTED_ERROR_CODE;
}
