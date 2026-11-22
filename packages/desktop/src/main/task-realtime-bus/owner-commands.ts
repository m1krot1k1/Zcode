import { HostMessageTypes } from "@zcode/shared";
import type {
  TaskOwnerCommandDelivery,
  TaskOwnerCommandRequest,
  TaskOwnerCommandResult,
} from "@zcode/shared";
import { getLeaseKey } from "./keys.js";
import type { TaskRealtimeBusState } from "./state.js";
import type { RegisteredRealtimeHost } from "./types.js";
import { OWNER_COMMAND_TIMEOUT_MS } from "./types.js";

export function handleOwnerCommandRequest(
  state: TaskRealtimeBusState,
  requester: RegisteredRealtimeHost,
  command: TaskOwnerCommandRequest,
): void {
  const lease = state.leases.get(getLeaseKey(command.workspaceKey, command.taskId));
  if (!lease) {
    postOwnerCommandResult(state, requester.hostId, {
      commandRequestId: command.commandRequestId,
      success: false,
      error: "No active task owner.",
      code: "NO_ACTIVE_TASK_OWNER",
    });
    return;
  }
  if (lease.runId !== command.runId) {
    postOwnerCommandResult(state, requester.hostId, {
      commandRequestId: command.commandRequestId,
      success: false,
      error: "Stale task owner command.",
      code: "STALE_TASK_OWNER_COMMAND",
    });
    return;
  }
  const owner = state.hosts.get(lease.ownerHostId);
  if (!owner) {
    postOwnerCommandResult(state, requester.hostId, {
      commandRequestId: command.commandRequestId,
      success: false,
      error: "No active task owner.",
      code: "NO_ACTIVE_TASK_OWNER",
    });
    return;
  }

  const timeout = setTimeout(() => {
    state.pendingOwnerCommands.delete(command.commandRequestId);
    postOwnerCommandResult(state, requester.hostId, {
      commandRequestId: command.commandRequestId,
      success: false,
      error: "Owner command timed out.",
      code: "OWNER_COMMAND_FAILED",
    });
  }, OWNER_COMMAND_TIMEOUT_MS);
  state.pendingOwnerCommands.set(command.commandRequestId, {
    commandRequestId: command.commandRequestId,
    requesterHostId: requester.hostId,
    ownerHostId: owner.hostId,
    createdAt: Date.now(),
    timeout,
  });

  owner.child.postMessage({
    type: HostMessageTypes.TaskOwnerCommandDeliver,
    command: { ...command, requesterHostId: requester.hostId } satisfies TaskOwnerCommandDelivery,
  });
}

export function handleOwnerCommandResult(
  state: TaskRealtimeBusState,
  owner: RegisteredRealtimeHost,
  result: TaskOwnerCommandResult,
): void {
  const pending = state.pendingOwnerCommands.get(result.commandRequestId);
  if (!pending || pending.ownerHostId !== owner.hostId) {
    return;
  }
  clearTimeout(pending.timeout);
  state.pendingOwnerCommands.delete(result.commandRequestId);
  postOwnerCommandResult(state, pending.requesterHostId, result);
}

export function failPendingOwnerCommandsForHost(
  state: TaskRealtimeBusState,
  hostId: string,
  error: string,
): void {
  const pendingCommands = Array.from(state.pendingOwnerCommands);
  for (const [commandRequestId, pending] of pendingCommands) {
    if (pending.ownerHostId !== hostId && pending.requesterHostId !== hostId) {
      continue;
    }
    clearTimeout(pending.timeout);
    state.pendingOwnerCommands.delete(commandRequestId);
    if (pending.requesterHostId !== hostId) {
      postOwnerCommandResult(state, pending.requesterHostId, {
        commandRequestId,
        success: false,
        error,
        code: "OWNER_COMMAND_FAILED",
      });
    }
  }
}

function postOwnerCommandResult(
  state: TaskRealtimeBusState,
  hostId: string,
  result: TaskOwnerCommandResult,
): void {
  state.hosts.get(hostId)?.child.postMessage({
    type: HostMessageTypes.TaskOwnerCommandResult,
    result,
  });
}
