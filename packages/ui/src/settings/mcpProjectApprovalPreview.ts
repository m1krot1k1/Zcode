import type { McpServerConfig } from "@zcode/shared";

/**
 * project-scope MCP 确认框的展示投影。
 *
 * 这里只保留“将执行什么”的最小信息：stdio 的 command/args 与 env **键名**、
 * http/sse 的 origin+pathname 与 header 键名。值一律不进入 DOM：env/header 值
 * 常被用来存放 token，URL 查询串也可能携带凭据。
 */
const MCP_PROJECT_APPROVAL_SECRET_MASK = "••••";

interface McpProjectApprovalPreview {
  commandLine?: string;
  envEntries: string[];
  headerEntries: string[];
  url?: string;
}

export function buildMcpProjectApprovalPreview(config: McpServerConfig): McpProjectApprovalPreview {
  if (config.type === "stdio") {
    const commandLine = [config.command, ...(config.args ?? [])].join(" ").trim();
    return {
      ...(commandLine ? { commandLine } : {}),
      envEntries: maskedEntries(config.env),
      headerEntries: [],
    };
  }
  return {
    ...(config.url ? { url: stripUrlQuery(config.url) } : {}),
    envEntries: [],
    headerEntries: maskedEntries(config.headers),
  };
}

function maskedEntries(values: Record<string, string> | undefined): string[] {
  return Object.keys(values ?? {})
    .sort((left, right) => left.localeCompare(right))
    .map((name) => `${name}=${MCP_PROJECT_APPROVAL_SECRET_MASK}`);
}

function stripUrlQuery(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    // 非标准 URL（例如未解析的变量占位）保留原文，但仍去掉问号后的查询串。
    return rawUrl.split("?")[0] ?? rawUrl;
  }
}
