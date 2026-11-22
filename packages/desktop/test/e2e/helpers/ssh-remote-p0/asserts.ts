// SSH P0 断言：只从 renderer tab store 读取远端身份与会话事实，不驱动 UI。
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import type { SSHConnectionConfig } from "./config.js";
import { SSH_WORKSPACE_READY_TIMEOUT_MS } from "./config.js";

export interface RemoteTabSnapshot {
  activeWorkspaceIdentity: string | null;
  activeWorkspacePath: string | null;
  remoteHost: string | null;
  remoteKind: string | null;
  remoteSessionId: string | null;
  secretPersistedInTab: boolean;
  workspaceIdentity: string | null;
  workspacePath: string | null;
}

export async function waitForRemoteTab(options: {
  caseMarker: string;
  expectedIdentity?: string;
  expectedPath: string;
  expectedRemoteSessionId?: string | null;
  requireActive?: boolean;
  timeoutMs?: number;
}): Promise<RemoteTabSnapshot> {
  let snapshot: RemoteTabSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        snapshot = await readRemoteTabSnapshot(options.expectedIdentity, options.expectedPath);
        const parsedIdentity = snapshot.workspaceIdentity
          ? parseRemoteWorkspaceIdentity(snapshot.workspaceIdentity)
          : null;
        const expectedIdentityMatches = options.expectedIdentity
          ? snapshot.workspaceIdentity === options.expectedIdentity
          : parsedIdentity?.kind === "server" &&
            parsedIdentity.workspacePath === options.expectedPath;
        return (
          snapshot.workspacePath === options.expectedPath &&
          expectedIdentityMatches &&
          Boolean(snapshot.remoteSessionId) &&
          (!options.expectedRemoteSessionId ||
            snapshot.remoteSessionId === options.expectedRemoteSessionId) &&
          (options.requireActive === false ||
            (snapshot.activeWorkspacePath === options.expectedPath &&
              snapshot.activeWorkspaceIdentity === snapshot.workspaceIdentity))
        );
      },
      {
        timeout: options.timeoutMs ?? SSH_WORKSPACE_READY_TIMEOUT_MS,
        interval: 1_000,
        timeoutMsg: `${options.caseMarker}: remote tab identity/session 没有收敛`,
      },
    );
  } catch (error) {
    throw new Error(
      `${options.caseMarker}: remote tab identity/session 没有收敛，latest=${JSON.stringify(snapshot)}`,
      { cause: error },
    );
  }
  if (!snapshot) {
    throw new Error(`${options.caseMarker}: remote tab snapshot 缺失`);
  }
  return snapshot;
}

export function readRemoteTabSnapshot(
  expectedIdentity?: string,
  expectedPath?: string,
): Promise<RemoteTabSnapshot> {
  return browser.execute(
    (identity, workspacePath) => {
      type RemoteTab = {
        remoteSessionId?: string;
        remoteTarget?: Record<string, unknown>;
        workspaceIdentity?: string;
        workspacePath?: string;
      };
      const store = (
        window as Window & {
          __zcodeTabStoreE2E?: {
            getState?: () => {
              activeWorkspaceIdentity?: string | null;
              activeWorkspacePath?: string | null;
              tabs?: RemoteTab[];
            };
          };
        }
      ).__zcodeTabStoreE2E;
      const state = store?.getState?.();
      const candidates =
        state?.tabs?.filter((candidate) =>
          identity
            ? candidate.workspaceIdentity === identity
            : workspacePath
              ? candidate.workspacePath === workspacePath
              : candidate.workspaceIdentity === state?.activeWorkspaceIdentity &&
                candidate.workspacePath === state?.activeWorkspacePath,
        ) ?? [];
      // 同一远端路径可能被不同 Source Server 各开一个 tab（双 target 用例）；只按 path 匹配时
      // 必须优先取当前激活的那个，否则会一直命中先连接的 tab，后连接方的 identity 收敛永不成立。
      const tab =
        candidates.find(
          (candidate) => candidate.workspaceIdentity === state?.activeWorkspaceIdentity,
        ) ?? candidates[0];
      const target = tab?.remoteTarget;
      return {
        activeWorkspaceIdentity: state?.activeWorkspaceIdentity ?? null,
        activeWorkspacePath: state?.activeWorkspacePath ?? null,
        remoteHost: typeof target?.host === "string" ? target.host : null,
        remoteKind: typeof target?.kind === "string" ? target.kind : null,
        remoteSessionId: tab?.remoteSessionId ?? null,
        secretPersistedInTab: Boolean(
          target && ("password" in target || "privateKeyPassphrase" in target),
        ),
        workspaceIdentity: tab?.workspaceIdentity ?? null,
        workspacePath: tab?.workspacePath ?? null,
      };
    },
    expectedIdentity ?? null,
    expectedPath ?? null,
  );
}

/** 等待 SSH Source 的 conversation workspace（~/.zcode/workspace/default）进入可用状态。 */
export async function waitForSSHConversation(
  config: SSHConnectionConfig,
  caseMarker: string,
): Promise<RemoteTabSnapshot> {
  let snapshot: RemoteTabSnapshot | null = null;
  await browser.waitUntil(
    async () => {
      snapshot = await browser.execute(
        (host: string, port: number) => {
          type RemoteTab = {
            remoteSessionId?: string;
            remoteTarget?: Record<string, unknown>;
            workspaceIdentity?: string;
            workspacePath?: string;
          };
          const store = (
            window as Window & {
              __zcodeTabStoreE2E?: {
                getState?: () => {
                  activeWorkspaceIdentity?: string | null;
                  activeWorkspacePath?: string | null;
                  tabs?: RemoteTab[];
                };
              };
            }
          ).__zcodeTabStoreE2E;
          const state = store?.getState?.();
          // dual target 场景下,先连接的设备在表单提交时也会自动打开自己的设备级
          // conversation(路径同为 ~/.zcode/workspace/default)。只按路径匹配会把 A 的
          // conversation 错认成 B 的(entry-attribution 实锤:sourceB 被解析成 A 的
          // sourceServerId)。必须同时校验 tab 的连接 target(host+port)。
          const tab = state?.tabs?.find((candidate) => {
            if (
              !candidate.workspacePath?.replace(/\\/gu, "/").endsWith("/.zcode/workspace/default")
            ) {
              return false;
            }
            const target = candidate.remoteTarget;
            return target?.kind === "ssh" && target.host === host && target.port === port;
          });
          const target = tab?.remoteTarget;
          return {
            activeWorkspaceIdentity: state?.activeWorkspaceIdentity ?? null,
            activeWorkspacePath: state?.activeWorkspacePath ?? null,
            remoteHost: typeof target?.host === "string" ? target.host : null,
            remoteKind: typeof target?.kind === "string" ? target.kind : null,
            remoteSessionId: tab?.remoteSessionId ?? null,
            secretPersistedInTab: Boolean(
              target && ("password" in target || "privateKeyPassphrase" in target),
            ),
            workspaceIdentity: tab?.workspaceIdentity ?? null,
            workspacePath: tab?.workspacePath ?? null,
          };
        },
        config.host,
        config.port,
      );
      return Boolean(
        snapshot?.workspacePath && snapshot.remoteSessionId && snapshot.workspaceIdentity,
      );
    },
    {
      timeout: SSH_WORKSPACE_READY_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: `${caseMarker}: SSH conversation workspace 没有进入可用状态`,
    },
  );
  if (!snapshot) throw new Error(`${caseMarker}: SSH conversation workspace snapshot 缺失`);
  return snapshot;
}
