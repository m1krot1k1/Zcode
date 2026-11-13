/**
 * ui-skills-section 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const uiSkillsSectionModule = {
  id: "ui-skills-section",
  requires: ["services", "shared", "ui"],
  provides: ["ui-skills-section"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
