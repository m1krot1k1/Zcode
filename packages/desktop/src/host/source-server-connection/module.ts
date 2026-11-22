/**
 * desktop-source-server-connection 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const desktopSourceServerConnectionModule = {
  id: "desktop-source-server-connection",
  requires: ["desktop", "rpc", "server", "services", "shared"],
  provides: ["desktop-source-server-connection"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
