/**
 * cli-core-takeover-tools 模块清单（architecture-governance managed 模块）。
 * requires 必须与 architecture-policy.yaml 一致（检查器会校验）。
 */
export const cliCoreTakeoverToolsModule = {
  id: "cli-core-takeover-tools",
  requires: ["cli-core-executor", "cli-uncensored-takeover", "shared", "zcode-cli"],
  provides: ["cli-core-takeover-tools"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
