import { createHash } from "node:crypto";

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

/**
 * Стабильный ключ workspace для файлов настроек и credential store:
 * sha256(identity).hex.slice(0, 32). Значение совпадает у всех потребителей
 * (embedding settings и uncensored settings).
 */
export function workspaceKeyOf(params: {
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  return createHash("sha256").update(workspaceIdentityOf(params)).digest("hex").slice(0, 32);
}
