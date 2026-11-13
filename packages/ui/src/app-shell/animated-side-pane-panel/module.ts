/**
 * ui-animated-side-pane-panel 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const uiAnimatedSidePanePanelModule = {
  id: "ui-animated-side-pane-panel",
  requires: ["agent-workbench", "plugin-ui", "services", "shared", "side-pane-full-view", "ui"],
  provides: ["ui-animated-side-pane-panel"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
