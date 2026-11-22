/**
 * cli-core-executor 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cliCoreExecutorModule = {
  id: "cli-core-executor",
  requires: ["cli-file-transaction", "cli-tool-self-repair", "mcp-apps-protocol", "shared", "zcode-cli"],
  provides: ["cli-core-executor"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
