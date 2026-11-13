import { AutomationRepoRuns } from "./runs.js";

/**
 * automation 存储仓库：automations（定义 + 调度状态）与 automation_runs（运行历史 + runId 幂等台账），
 * 与 task index 同库 tasks-index.sqlite（WAL、多进程安全）。
 *
 * 仓库只做存储与原子状态迁移；cron 表达式解析 / next_run_at 计算由调用方（scheduler / 管理层）
 * 用 cron 库算好后传入，仓库不感知 cron 语义。
 */
export class AutomationRepo extends AutomationRepoRuns {}

export {
  AutomationCreateLimitError,
  CLAIM_STALE_MS,
  DISPATCH_MAX_ATTEMPTS,
  DISPATCH_RETRY_BASE_MS,
  DISPATCH_RETRY_CAP_MS,
  computeRetryAt,
} from "./rows.js";
