/**
 * ui-root 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const uiRootModule = {
  id: "ui-root",
  requires: ["conversation-workspace-target", "plugin-ui", "project-sidebar", "provider", "remote-connection-flow", "services", "shared", "ui", "web-remote-control-ui"],
  provides: ["ui-root"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
