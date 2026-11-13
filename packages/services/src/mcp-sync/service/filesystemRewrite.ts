import { posix, win32 } from "node:path";
import type { McpServerConfig } from "@zcode/shared";

interface RemotePathRewriteContext {
  localHomeDir: string;
  localWorkspacePath?: string;
  remoteHomeDir: string;
  remoteWorkspacePath?: string;
}

export function rewriteFilesystemMcpConfig(
  name: string,
  config: McpServerConfig,
  paths: RemotePathRewriteContext,
): McpServerConfig {
  if (!isStdioMcpConfig(config) || !isFilesystemMcpServer(name, config)) {
    return config;
  }
  if (!Array.isArray(config.args)) {
    return config;
  }
  return {
    ...config,
    args: config.args.map((arg) => rewritePathArgForRemote(arg, paths)),
  };
}

function isStdioMcpConfig(config: McpServerConfig): boolean {
  const type = typeof config.type === "string" ? config.type.trim().toLowerCase() : "";
  if (!type && typeof config.command === "string" && config.command.trim()) {
    return true;
  }
  return type === "stdio";
}

function isFilesystemMcpServer(name: string, config: McpServerConfig): boolean {
  const normalizedName = name.trim().toLowerCase();
  if (
    normalizedName === "filesystem" ||
    normalizedName === "file-system" ||
    normalizedName === "fs"
  ) {
    return true;
  }
  const haystack = [config.command, ...(Array.isArray(config.args) ? config.args : [])]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return (
    haystack.includes("@modelcontextprotocol/server-filesystem") ||
    haystack.includes("mcp-server-filesystem")
  );
}

function rewritePathArgForRemote(arg: string, paths: RemotePathRewriteContext): string {
  const workspaceRelative = getRelativePathIfWithin(paths.localWorkspacePath, arg);
  if (workspaceRelative !== null && paths.remoteWorkspacePath?.trim()) {
    return joinRemotePath(paths.remoteWorkspacePath, workspaceRelative);
  }

  const homeRelative = getRelativePathIfWithin(paths.localHomeDir, arg);
  if (homeRelative !== null) {
    return joinRemotePath(paths.remoteHomeDir, homeRelative);
  }

  return arg;
}

function getRelativePathIfWithin(
  basePath: string | undefined,
  candidatePath: string,
): string | null {
  if (!basePath?.trim()) {
    return null;
  }
  const base = normalizeComparablePath(basePath);
  const candidate = normalizeComparablePath(candidatePath);
  if (!base || !candidate) {
    return null;
  }
  const baseValue = base.caseInsensitive ? base.value.toLowerCase() : base.value;
  const candidateValue = base.caseInsensitive ? candidate.value.toLowerCase() : candidate.value;
  if (candidateValue === baseValue) {
    return "";
  }
  const prefix = baseValue.endsWith("/") ? baseValue : `${baseValue}/`;
  if (!candidateValue.startsWith(prefix)) {
    return null;
  }
  return candidate.value.slice(prefix.length);
}

function normalizeComparablePath(
  rawPath: string,
): { value: string; caseInsensitive: boolean } | null {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return null;
  }
  const isWindowsPath = /^[a-zA-Z]:[\\/]/u.test(trimmed) || trimmed.startsWith("\\\\");
  const isPosixPath = trimmed.startsWith("/");
  if (!isWindowsPath && !isPosixPath) {
    return null;
  }

  let value = trimmed.replaceAll("\\", "/");
  value = value.replace(/\/+$/u, "");
  if (value === "") {
    value = "/";
  }
  return {
    value,
    caseInsensitive: isWindowsPath,
  };
}

function joinRemotePath(remoteBasePath: string, relativePath: string): string {
  if (!relativePath) {
    return remoteBasePath;
  }
  const segments = relativePath.split(/[\\/]+/u).filter(Boolean);
  // MCP 同步运行在本机进程里，但 remoteWorkspacePath 描述的是远端主机路径。
  // 不能用 process.platform 决定拼接风格，否则 Windows 客户端同步到 Linux/WSL 时会把 /srv/... 写成 \srv\...。
  const normalizedBasePath = remoteBasePath.trim();
  if (normalizedBasePath.startsWith("/")) {
    return posix.join(normalizedBasePath.replaceAll("\\", "/"), ...segments);
  }
  if (/^[a-zA-Z]:[\\/]/u.test(normalizedBasePath) || normalizedBasePath.startsWith("\\\\")) {
    return win32.join(normalizedBasePath, ...segments);
  }
  return posix.join(normalizedBasePath.replaceAll("\\", "/"), ...segments);
}
