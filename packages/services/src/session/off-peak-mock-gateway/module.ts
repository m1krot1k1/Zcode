/**
 * services-off-peak-mock-gateway 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const servicesOffPeakMockGatewayModule = {
  id: "services-off-peak-mock-gateway",
  requires: ["services"],
  provides: ["services-off-peak-mock-gateway"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
