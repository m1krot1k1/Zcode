/**
 * ui-plugin-store-page 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const uiPluginStorePageModule = {
  id: "ui-plugin-store-page",
  requires: ["conversation-workspace-target", "plugin-ui", "services", "shared", "ui"],
  provides: ["ui-plugin-store-page"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
