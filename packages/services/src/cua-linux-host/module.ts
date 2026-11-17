/**
 * services-cua-linux-host — манифест managed-модуля.
 * Слой adapters: реальный FFI к libX11/libXtst, D-Bus-портал и внешние утилиты захвата.
 * `requires` совпадает с architecture-policy.yaml.
 */
export const servicesCuaLinuxHostModule = {
  id: "services-cua-linux-host",
  requires: ["services"],
  provides: ["services-cua-linux-host"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
