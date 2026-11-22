/**
 * desktop-window-host-controller 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const desktopWindowHostControllerModule = {
  id: "desktop-window-host-controller",
  requires: ["desktop", "rpc", "services", "shared"],
  provides: ["desktop-window-host-controller"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
