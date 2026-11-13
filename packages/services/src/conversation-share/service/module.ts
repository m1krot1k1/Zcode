/**
 * services-conversation-share 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const servicesConversationShareModule = {
  id: "services-conversation-share",
  requires: ["rpc", "services", "shared"],
  provides: ["services-conversation-share"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
