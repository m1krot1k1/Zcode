/**
 * ui-lexical-chat-input 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const uiLexicalChatInputModule = {
  id: "ui-lexical-chat-input",
  requires: ["shared", "ui"],
  provides: ["ui-lexical-chat-input"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
