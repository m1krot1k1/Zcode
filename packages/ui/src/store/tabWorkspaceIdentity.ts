interface WorkspaceTabIdentityLike {
  workspacePath: string;
  remoteSessionId?: string;
  workspaceIdentity?: string;
}

interface WorkspaceTabMatchOptions {
  remoteSessionId?: string;
  workspaceIdentity?: string;
  previousWorkspaceIdentity?: string;
}

function hasRemoteTabIdentity(tab: WorkspaceTabIdentityLike): boolean {
  return Boolean(tab.workspaceIdentity || tab.remoteSessionId);
}

function isLocalWorkspaceTab(tab: WorkspaceTabIdentityLike): boolean {
  return !hasRemoteTabIdentity(tab);
}

export function isSameWorkspaceTab(
  tab: WorkspaceTabIdentityLike,
  workspacePath: string,
  options?: WorkspaceTabMatchOptions,
): boolean {
  // 身份优先：同一远端 workspace 可能以不同文本路径出现（尾斜杠、//、符号链接别名），
  // 只按 path 先行比较会把同一 tab 拆成两个。路径仅在双方都没有身份时兜底。
  const requestedIdentity = options?.workspaceIdentity?.trim();
  if (requestedIdentity) {
    const tabIdentity = tab.workspaceIdentity?.trim();
    const previousIdentity = options?.previousWorkspaceIdentity?.trim();
    return (
      tabIdentity === requestedIdentity ||
      (Boolean(previousIdentity) && tabIdentity === previousIdentity)
    );
  }

  if (options?.remoteSessionId) {
    return tab.remoteSessionId === options.remoteSessionId;
  }

  return tab.workspacePath === workspacePath && isLocalWorkspaceTab(tab);
}
