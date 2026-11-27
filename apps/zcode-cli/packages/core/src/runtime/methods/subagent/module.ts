/**
 * cli-core-subagent 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cliCoreSubagentModule = {
  id: "cli-core-subagent",
  requires: ["cli-core-takeover-tools", "cli-uncensored-takeover", "cli-file-transaction", "zcode-cli"],
  provides: ["cli-core-subagent"],
  publicEntrypoints: ["index.ts", "contract.ts", "port.ts", "spawn-envelope.ts", "model-factory.ts", "child-tool-policy.ts"],
} as const;
