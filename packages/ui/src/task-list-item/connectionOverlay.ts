/**
 * 判断任务行是否需要投影远程连接断开的覆盖提示。
 * 仅 remote identity 的 workspace 才需要提示，本地任务不会被连接状态影响。
 */
export function shouldShowRemoteConnectionOverlay(params: {
  workspaceIdentity?: string;
  connectionOverlay?: "disconnected" | "reconnecting";
}): boolean {
  const workspaceIdentity = params.workspaceIdentity?.trim() ?? "";
  return Boolean(workspaceIdentity.startsWith("remote:") && params.connectionOverlay);
}
