/**
 * cli-exec-pty манифест (architecture-governance managed 模块).
 * Слой adapters: держит реальные PTY-дескрипторы и дерево процессов.
 * requires совпадает с architecture-policy.yaml.
 */
export const cliExecPtyModule = {
  id: "cli-exec-pty",
  requires: ["cli-exec-sandbox"],
  provides: ["cli-exec-pty"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
