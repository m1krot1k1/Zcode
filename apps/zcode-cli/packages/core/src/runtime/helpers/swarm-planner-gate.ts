/**
 * Root swarm planner gate.
 *
 * 原因：`auto` intent 曾和 явный `swarm` 一样 запускал второй root planner, поэтому
 * сложная задача могла планироваться дважды (planner, затем Start/Orchestrator).
 * 修复依据：runtime planner остаётся только у явного `swarm` на root turn; `auto`
 * продолжает обычный model turn и маршрутизируется через Root → Start → Orchestrator.
 * Потомок с унаследованным `internalSwarmRootRunId` никогда не открывает новый planner.
 */
interface RootSwarmPlannerGateInput {
  ownsRootRunBudget: boolean;
  orchestrationMode?: "auto" | "swarm";
  internalSwarmRootRunId?: string;
  /** 本回合的原文就是一条显式路由命令（`/start`、`/review`、`/evolve`、`/evaluate`）。 */
  explicitRoutingCommand?: boolean;
}

export function shouldRunRootSwarmPlanner(input: RootSwarmPlannerGateInput): boolean {
  return (
    input.ownsRootRunBudget &&
    input.orchestrationMode === "swarm" &&
    !input.internalSwarmRootRunId &&
    // 原因：`/start` 展开成「根只调用 Task(start)、不得用根工具」的提示词，而 Swarm 开关
    // 同时让根 planner 造 DAG 并把根的全部工具塞进 disallowlist——两条编排互相拆台，
    // `/start` 的 Task 调用被本回合自己的禁令挡下，Swarm 也永远拿不到根的编排决定权。
    // 修复依据：显式路由命令拥有本回合的编排；root planner 在它面前与 `auto` 同门（不开），
    // 后代仍由 internalSwarmRootRunId 拦住，不会借这条门重复规划。
    !input.explicitRoutingCommand
  );
}

/**
 * 显式路由命令：用户点名把活交给某个角色。只看命令原文（`displayInput`），不看展开后的
 * 提示词——展开文本里同样会出现 `/start` 字样，用它判定会把普通消息误当命令。
 * `/init` 是一次普通写入任务；`/workflow` 的工具面由动态工作流闸门自己管，两者都不在此列。
 */
const EXPLICIT_ROUTING_COMMAND_PATTERN = /^\/(?:start|review|evolve|evaluate)(?:\s|$)/iu;

export function isExplicitRoutingCommandInput(input: string | undefined): boolean {
  if (typeof input !== "string") return false;
  return EXPLICIT_ROUTING_COMMAND_PATTERN.test(input.trim());
}
