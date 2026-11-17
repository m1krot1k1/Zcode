/**
 * Ключ изоляции индекса. По правилам репозитория это всегда
 * `workspaceIdentity?.trim() || workspacePath` — никогда не выводится из отображаемого имени.
 */
export function workspaceIdentityOf(params: {
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  const identity = params.workspaceIdentity?.trim() || params.workspacePath.trim();
  if (!identity) throw new Error("A workspace path or identity is required.");
  return identity;
}
