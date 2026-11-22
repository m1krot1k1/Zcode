import type { Logger } from "@zcode/contracts";
import type { V4CommandExecutor } from "../zcode-protocol-v4/commands/executor.js";
import type { V4QueuedTurnExecution } from "../zcode-protocol-v4/commands/types.js";
import type { PersistentCommandIndex } from "../zcode-protocol-v4/persistent-command-index.js";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * v4 桥的共享状态。
 *
 * 原 `createConversationV4Gateway` 用闭包持有会话注册表、持久命令索引和队列驻留表；
 * 拆成多个域模块后，这些闭包变量统一收敛到这里，按引用透传：
 * - `context` / `log` / `persistentCommands` 在桥创建时初始化，之后只读；
 * - `autoDrainRetryTimers` / `queuedTurnExecutions` 是可变运行时表，各域共用同一实例；
 * - `nativeExecutor` 在 coreHost 装配完成后回填，auto-drain 执行命令时惰性读取，
 *   避免构造期自引用。
 */
export interface BridgeState {
  context: ZCodeProtocolAgentServerContext;
  log?: Logger;
  persistentCommands: PersistentCommandIndex;
  autoDrainRetryTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** Highspeed 执行材料含临时凭据：只按 session/sourceCommandId 驻留内存，绝不进入
   * TurnSteerQueued、snapshot 或 transcript。CLI 重启后缺失时队列提升自动走原模型。 */
  queuedTurnExecutions: Map<string, Map<string, V4QueuedTurnExecution>>;
  nativeExecutor?: V4CommandExecutor;
}
