/**
 * cli-tool-self-repair 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cliToolSelfRepairModule = {
  id: "cli-tool-self-repair",
  requires: ["zcode-cli"],
  provides: ["cli-tool-self-repair"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
