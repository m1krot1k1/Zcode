import type { ActiveAgentStep, AgentStepTelemetryState, PromptTelemetryState } from "./types.js";

export function settlePermissionWait(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState | undefined,
  requestId: string,
  now: number,
): void {
  const permissionWait = prompt.permissionWaitsByRequestId.get(requestId);
  if (!permissionWait) {
    return;
  }

  const waitingMs = Math.max(now - permissionWait.requestedAt, 0);
  prompt.waitingMs += waitingMs;
  if (permissionWait.toolCallId) {
    const toolStep = state?.toolStepsById.get(permissionWait.toolCallId);
    if (toolStep) {
      toolStep.waitingMs += waitingMs;
    } else if (state) {
      const settled = state.settledPermissionWaitsByToolId.get(permissionWait.toolCallId);
      state.settledPermissionWaitsByToolId.set(permissionWait.toolCallId, {
        waitingMs: (settled?.waitingMs ?? 0) + waitingMs,
        earliestRequestedAt: Math.min(
          settled?.earliestRequestedAt ?? permissionWait.requestedAt,
          permissionWait.requestedAt,
        ),
      });
    }
  }
  prompt.permissionWaitsByRequestId.delete(requestId);
}

export function applySettledPermissionWaitAttribution(
  state: AgentStepTelemetryState,
  step: ActiveAgentStep,
): void {
  if (!step.toolId) {
    return;
  }

  const settled = state.settledPermissionWaitsByToolId.get(step.toolId);
  if (!settled) {
    return;
  }

  step.waitingMs += settled.waitingMs;
  step.startedAt = Math.min(step.startedAt, settled.earliestRequestedAt);
  state.settledPermissionWaitsByToolId.delete(step.toolId);
}

export function findEarliestPermissionRequestedAt(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState,
  toolCallId: string,
): number | undefined {
  let earliest = state.settledPermissionWaitsByToolId.get(toolCallId)?.earliestRequestedAt;
  for (const permissionWait of prompt.permissionWaitsByRequestId.values()) {
    if (permissionWait.toolCallId !== toolCallId) {
      continue;
    }
    earliest = Math.min(earliest ?? permissionWait.requestedAt, permissionWait.requestedAt);
  }
  return earliest;
}

export function settlePermissionWaitsForTool(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState,
  toolCallId: string,
  now: number,
): void {
  for (const [requestId, permissionWait] of prompt.permissionWaitsByRequestId) {
    if (permissionWait.toolCallId === toolCallId) {
      settlePermissionWait(prompt, state, requestId, now);
    }
  }
}

export function settleAllPermissionWaits(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState | undefined,
  now: number,
): void {
  for (const requestId of prompt.permissionWaitsByRequestId.keys()) {
    settlePermissionWait(prompt, state, requestId, now);
  }
}
