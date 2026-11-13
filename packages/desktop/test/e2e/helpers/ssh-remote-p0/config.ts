// SSH P0 配置读取：只解析环境变量与超时，不建立任何连接。

export const SSH_CONNECT_TIMEOUT_MS = 10 * 60_000;
export const SSH_WORKSPACE_READY_TIMEOUT_MS = 2 * 60_000;

export interface SSHConnectionConfig {
  host: string;
  password: string;
  port: number;
  username: string;
}

export interface SSHRuntimeConfig extends SSHConnectionConfig {
  workspacePaths: readonly [string, string];
}

export interface SingleSSHWorkspaceRuntimeConfig extends SSHConnectionConfig {
  workspacePath: string;
}

export interface DualSSHRuntimeConfig {
  targets: readonly [SSHConnectionConfig, SSHConnectionConfig];
  workspacePath: string;
}

export function readSSHRuntimeConfig(caseMarker: string): SSHRuntimeConfig {
  const host = requireSecretEnv("ZCODE_E2E_SSH_HOST", caseMarker);
  const username = requireSecretEnv("ZCODE_E2E_SSH_USERNAME", caseMarker);
  const password = requireSecretEnv("ZCODE_E2E_SSH_PASSWORD", caseMarker);
  const portText = process.env.ZCODE_E2E_SSH_PORT?.trim() || "22";
  const port = Number.parseInt(portText, 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${caseMarker}: ZCODE_E2E_SSH_PORT 必须是 1..65535 的整数`);
  }

  const workspacePaths = (
    process.env.ZCODE_E2E_SSH_WORKSPACE_PATHS?.split(",") ?? ["/root", "/home"]
  )
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    workspacePaths.length !== 2 ||
    workspacePaths.some((value) => !value.startsWith("/")) ||
    workspacePaths[0] === workspacePaths[1]
  ) {
    throw new Error(`${caseMarker}: ZCODE_E2E_SSH_WORKSPACE_PATHS 必须是两个不同的绝对路径`);
  }

  return {
    host,
    password,
    port,
    username,
    workspacePaths: [workspacePaths[0]!, workspacePaths[1]!],
  };
}

export function readSingleSSHWorkspaceRuntimeConfig(
  caseMarker: string,
): SingleSSHWorkspaceRuntimeConfig {
  const host = requireSecretEnv("ZCODE_E2E_SSH_HOST", caseMarker);
  const username = requireSecretEnv("ZCODE_E2E_SSH_USERNAME", caseMarker);
  const password = requireSecretEnv("ZCODE_E2E_SSH_PASSWORD", caseMarker);
  const port = parseSSHPort(
    process.env.ZCODE_E2E_SSH_PORT?.trim() || "22",
    `${caseMarker}: ZCODE_E2E_SSH_PORT`,
  );
  const workspacePath =
    process.env.ZCODE_E2E_SSH_WORKSPACE_PATH?.trim() ||
    process.env.ZCODE_E2E_SSH_SHARED_WORKSPACE_PATH?.trim() ||
    "/root/workspace";
  if (!workspacePath.startsWith("/")) {
    throw new Error(`${caseMarker}: ZCODE_E2E_SSH_WORKSPACE_PATH 必须是绝对路径`);
  }

  return { host, password, port, username, workspacePath };
}

export function readDualSSHRuntimeConfig(caseMarker: string): DualSSHRuntimeConfig {
  const commonHost = process.env.ZCODE_E2E_SSH_HOST?.trim();
  const commonUsername = process.env.ZCODE_E2E_SSH_USERNAME?.trim();
  const commonPassword = process.env.ZCODE_E2E_SSH_PASSWORD?.trim();
  const workspacePath = process.env.ZCODE_E2E_SSH_SHARED_WORKSPACE_PATH?.trim() || "/workspace";
  if (!workspacePath.startsWith("/")) {
    throw new Error(`${caseMarker}: ZCODE_E2E_SSH_SHARED_WORKSPACE_PATH 必须是绝对路径`);
  }

  const readTarget = (suffix: "A" | "B"): SSHConnectionConfig => {
    const host = process.env[`ZCODE_E2E_SSH_${suffix}_HOST`]?.trim() || commonHost;
    const username = process.env[`ZCODE_E2E_SSH_${suffix}_USERNAME`]?.trim() || commonUsername;
    const password = process.env[`ZCODE_E2E_SSH_${suffix}_PASSWORD`]?.trim() || commonPassword;
    const portText = process.env[`ZCODE_E2E_SSH_${suffix}_PORT`]?.trim();
    if (!host || !username || !password || !portText) {
      throw new Error(`${caseMarker}: dual SSH target ${suffix} 缺少 host/username/password/port`);
    }
    const port = parseSSHPort(portText, `${caseMarker}: target ${suffix}`);
    return { host, password, port, username };
  };

  const targets = [readTarget("A"), readTarget("B")] as const;
  if (
    targets[0].host === targets[1].host &&
    targets[0].port === targets[1].port &&
    targets[0].username === targets[1].username
  ) {
    throw new Error(`${caseMarker}: dual SSH target 必须产生两个不同 remote identity`);
  }
  return { targets, workspacePath };
}

function requireSecretEnv(name: string, caseMarker: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${caseMarker}: 缺少 ${name}`);
  return value;
}

function parseSSHPort(portText: string, context: string): number {
  const port = Number.parseInt(portText, 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${context}: SSH port 必须是 1..65535 的整数`);
  }
  return port;
}
