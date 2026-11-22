/** 租约与 batch 的复合 key 是跨模块共享的拼接口径，集中在一处避免格式漂移。 */
export function getLeaseKey(workspaceKey: string, taskId: string): string {
  return `${workspaceKey}\u0000${taskId}`;
}

export function getBatchKey(workspaceKey: string, taskId: string, runId: string): string {
  return `${getLeaseKey(workspaceKey, taskId)}\u0000${runId}`;
}
