/**
 * ui-composer-toolbar 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const uiComposerToolbarModule = {
  id: "ui-composer-toolbar",
  requires: ["agent-workbench", "provider", "services", "shared", "ui"],
  provides: ["ui-composer-toolbar"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
