/**
 * ui-plugins-section 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const uiPluginsSectionModule = {
  id: "ui-plugins-section",
  requires: ["conversation-workspace-target", "services", "shared", "ui", "workspace-config-catalog"],
  provides: ["ui-plugins-section"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
