/* off-peak 进程内 mock 网关的公开入口（barrel）。
   实现按职责拆在 ./off-peak-mock-gateway/，保留原导入路径与公开 API，
   拆分后每个文件都低于 800 行，不再需要 inline max-lines 例外。 */
export { isOffPeakMockEnabled } from "./off-peak-mock-gateway/index.js";
export { startOffPeakMockGateway } from "./off-peak-mock-gateway/index.js";
export type { OffPeakMockGatewayHandle } from "./off-peak-mock-gateway/index.js";
