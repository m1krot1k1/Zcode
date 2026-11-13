/**
 * task-index/targets.ts: Преобразования workspace/session target в broadcast target.
 */
import type { ZCodeAgentSessionTarget, ZCodeAgentWorkspaceTarget } from "../zcodeAgent.js";
import type { TargetHelpers, WorkspaceBroadcastTarget } from "./contracts.js";

export function createTargetHelpers(): TargetHelpers {
  function sessionTargetFrom(
    workspace: ZCodeAgentWorkspaceTarget,
    sessionId: string,
  ): ZCodeAgentSessionTarget {
    return {
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      sessionId,
    };
  }

  function broadcastTargetFrom(target: ZCodeAgentSessionTarget): WorkspaceBroadcastTarget {
    return {
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      taskId: target.sessionId,
    };
  }

  return { sessionTargetFrom, broadcastTargetFrom };
}
