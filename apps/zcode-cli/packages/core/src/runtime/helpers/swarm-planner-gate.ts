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
}

export function shouldRunRootSwarmPlanner(input: RootSwarmPlannerGateInput): boolean {
  return (
    input.ownsRootRunBudget &&
    input.orchestrationMode === "swarm" &&
    !input.internalSwarmRootRunId
  );
}
