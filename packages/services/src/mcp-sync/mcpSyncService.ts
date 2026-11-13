/**
 * MCP 同步服务公开入口。实现按职责拆分在 `service/` 子目录，这里只做转发，
 * 保持既有引用路径 `mcp-sync/mcpSyncService.js` 不变。
 */
export { createMcpSyncService } from "./service/index.js";
