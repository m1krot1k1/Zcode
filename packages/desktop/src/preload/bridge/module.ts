/**
 * desktop-preload-bridge 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const desktopPreloadBridgeModule = {
  id: "desktop-preload-bridge",
  requires: ["desktop", "shared"],
  provides: ["desktop-preload-bridge"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
