/**
 * ui-app-root 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const uiAppRootModule = {
  id: "ui-app-root",
  requires: ["services", "shared", "side-pane-full-view", "ui", "ui-root"],
  provides: ["ui-app-root"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
