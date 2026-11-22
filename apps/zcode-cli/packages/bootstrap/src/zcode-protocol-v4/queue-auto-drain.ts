import type { GoalStatus } from "@zcode/contracts";

/**
 * 普通 queue 的唯一自动提升闸门。fail-open 不在这里开旁路：verifier 仍先把
 * target 持久化为 complete，再与显式 pass 共用这一条判断。
 *
 * A paused goal must not block an explicit user sendText: the user already chose
 * to queue a new message while the goal was paused. Goal commands and compact stay
 * gated until the goal is complete/resumed.
 */
export function shouldAutoDrainV4QueueHead(input: {
  autoDrain: boolean;
  dispatchState: "queued" | "reserved" | "promoting";
  kind: "sendText" | "sendGoalCommand" | "compact";
  sessionBusy: boolean;
  targetStatus: GoalStatus | null;
}): boolean {
  const pausedUserSendAllowed =
    input.kind === "sendText" && input.targetStatus === "paused";
  return (
    input.autoDrain &&
    input.dispatchState === "queued" &&
    !input.sessionBusy &&
    (input.targetStatus === null ||
      input.targetStatus === "complete" ||
      pausedUserSendAllowed)
  );
}
