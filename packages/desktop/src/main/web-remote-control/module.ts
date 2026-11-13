/**
 * desktop-web-remote-control 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const desktopWebRemoteControlModule = {
  id: "desktop-web-remote-control",
  requires: ["client", "desktop", "desktop-web-remote-relay", "rpc", "shared", "web-remote-relay"],
  provides: ["desktop-web-remote-control"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
