/**
 * cli-auto-repair-loop — манифест managed-модуля.
 * Слой app: владеет счётчиками/бюджетом цикла, не выполняет IO сам (порты внедряются).
 * `requires` совпадает с architecture-policy.yaml.
 */
export const cliAutoRepairLoopModule = {
  id: "cli-auto-repair-loop",
  requires: [],
  provides: ["cli-auto-repair-loop"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
