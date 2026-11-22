// 稳定性上报按职责拆分到 ./stability-telemetry/*，此文件仅保留稳定的公开入口，
// 避免调用方与测试依赖内部模块布局。导出名称、事件顺序与定时器语义保持不变。
export * from "./stability-telemetry/index.js";
