/**
 * cli-browser-telemetry — манифест managed-модуля (architecture-governance).
 * Слой adapters: держит реальные подписки Playwright на живую `Page`.
 * `requires` совпадает с architecture-policy.yaml.
 */
export const cliBrowserTelemetryModule = {
  id: "cli-browser-telemetry",
  requires: ["shared"],
  provides: ["cli-browser-telemetry"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
