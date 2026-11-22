// Subagent runner: расчёт фактического параллелизма и ёмкости runtime.

import { resolveSwarmParallelism, type SwarmParallelismDecision } from "./profile.js";

/**
 * Фактический параллелизм DAG: max(1, min(nodeCount, requested, freeSlots)).
 * `max(1)` нужен, чтобы узел мог дойти до admission и вернуть видимую причину отказа.
 */
export function resolveActualMaxParallel(input: {
  nodeCount: number;
  requestedMaxParallel?: number;
  activeCount?: number;
  activeCap?: number;
}): number {
  const nodeCount = Math.max(1, Math.floor(input.nodeCount));
  const requested = input.requestedMaxParallel === undefined
    ? (input.activeCap ?? nodeCount)
    : Math.max(1, Math.floor(input.requestedMaxParallel));
  const candidates = [nodeCount, requested];
  if (input.activeCount !== undefined && input.activeCap !== undefined) {
    candidates.push(Math.max(1, Math.floor(input.activeCap - input.activeCount)));
  }
  return Math.max(1, Math.min(...candidates));
}

/** Max_parallel конверта ребёнка учитывает свободные worker slots, но не будущий объём задач. */
export function resolveChildMaxParallel(input: {
  activeCount?: number;
  activeCap?: number;
  parentOccupiesSlot?: boolean;
}): number | undefined {
  if (input.activeCount === undefined || input.activeCap === undefined) return undefined;
  const freeSlots =
    input.activeCount === undefined || input.activeCap === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(
          0,
          input.activeCap - input.activeCount + (input.parentOccupiesSlot === true ? 1 : 0),
        );
  return Math.max(0, freeSlots);
}

/**
 * Обёртка над routing gate из profile.ts: учитывает текущую конкурентную ёмкость.
 */
export function resolveSwarmParallelismWithCapacity(input: {
  nodeCount: number;
  requestedMaxParallel?: number;
  userMaxParallel?: number;
  activeCount?: number;
  activeCap?: number;
}): SwarmParallelismDecision {
  const freeSlots =
    input.activeCount === undefined || input.activeCap === undefined
      ? undefined
      : Math.max(0, Math.floor(input.activeCap - input.activeCount));
  const decision = resolveSwarmParallelism({
    nodeCount: input.nodeCount,
    userMaxParallel: input.userMaxParallel ?? input.requestedMaxParallel ?? input.activeCap,
    ...(input.requestedMaxParallel === undefined
      ? {}
      : { requestedMaxParallel: input.requestedMaxParallel }),
  });
  if (decision.route === "integrate_inline") return decision;
  const maxParallel = Math.max(
    1,
    Math.min(decision.maxParallel, freeSlots ?? Number.POSITIVE_INFINITY),
  );
  return maxParallel === decision.maxParallel
    ? decision
    : {
        route: maxParallel < 2 ? "delegate_single" : decision.route,
        reason: `${decision.reason}; clamped by active capacity`,
        maxParallel,
      };
}

