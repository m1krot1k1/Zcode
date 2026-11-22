// 保留 automation 仓库的公开入口，既有 session/automationService、node/reexports 与测试
// 无需改导入路径；实现按职责拆到 automation-repo/（连接生命周期 / 定义 CRUD /
// 调度状态机 / run 历史），此文件只做 barrel 转发。
export {
  AutomationCreateLimitError,
  AutomationRepo,
  CLAIM_STALE_MS,
  DISPATCH_MAX_ATTEMPTS,
  DISPATCH_RETRY_BASE_MS,
  DISPATCH_RETRY_CAP_MS,
  computeRetryAt,
} from "./automation-repo/index.js";
