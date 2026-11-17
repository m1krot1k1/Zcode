/**
 * cli-model-execution 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cliModelExecutionModule = {
  id: "cli-model-execution",
  requires: ["cli-model-cache-control", "provider", "shared", "zcode-cli"],
  provides: ["cli-model-execution"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
