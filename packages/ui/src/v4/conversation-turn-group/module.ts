/**
 * ui-conversation-turn-group 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const uiConversationTurnGroupModule = {
  id: "ui-conversation-turn-group",
  requires: ["shared", "ui"],
  provides: ["ui-conversation-turn-group"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
