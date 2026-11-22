/**
 * ui-git-action-menu 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const uiGitActionMenuModule = {
  id: "ui-git-action-menu",
  requires: ["shared", "ui"],
  provides: ["ui-git-action-menu"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
