/**
 * ui-model-provider-container 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const uiModelProviderContainerModule = {
  id: "ui-model-provider-container",
  requires: ["agent-workbench", "opencode-agent-settings", "cursor-agent-settings", "shared", "ui"],
  provides: ["ui-model-provider-container"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
