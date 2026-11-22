/**
 * ui-remote-connection-connecting-step 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const uiRemoteConnectionConnectingStepModule = {
  id: "ui-remote-connection-connecting-step",
  requires: ["shared", "ui"],
  provides: ["ui-remote-connection-connecting-step"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
