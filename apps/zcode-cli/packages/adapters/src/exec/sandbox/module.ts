/**
 * cli-exec-sandbox манифест (architecture-governance managed 模块).
 * Слой adapters: здесь живут реальные процессы, монтирования и сигналы.
 * requires должен совпадать с architecture-policy.yaml.
 */
export const cliExecSandboxModule = {
  id: "cli-exec-sandbox",
  requires: [],
  provides: ["cli-exec-sandbox"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
