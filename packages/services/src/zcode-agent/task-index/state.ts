/**
 * task-index/state.ts: Единственный владелец состояния syncer'а — карты workspace-состояний,
 * emitters, lifecycle-латч и фабрика per-workspace ingest state.
 */
import { Emitter } from "@zcode/rpc";
import { resolveWorkspaceKey } from "@zcode/shared";
import {
  sessionsIndexTopicFrameSchema,
  workspaceConfigTopicFrameSchema,
  TopicWireFrameAssembler,
} from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeWorkspaceEvent } from "@zcode/shared";
import type {
  CreateZCodeTaskIndexSyncerOptions,
  TaskIndexCoreState,
  ZCodeTaskIndexReadyEvent,
  ZCodeTaskIndexTerminalEvent,
  WorkspaceIngestState,
} from "./contracts.js";
import type { ZCodeAgentWorkspaceTarget } from "../zcodeAgent.js";

export function createTaskIndexCoreState(
  options: CreateZCodeTaskIndexSyncerOptions,
): TaskIndexCoreState {
  const { agentService, taskIndexRepo } = options;
  const workspaceIngests = new Map<string, WorkspaceIngestState>();
  const runtimeState = { disposed: false };
  return {
    agentService,
    taskIndexRepo,
    workspaceIngests,
    workspaceEmitters: new Map<string, Emitter<ZCodeWorkspaceEvent>>(),
    terminalEventEmitter: new Emitter<ZCodeTaskIndexTerminalEvent>(),
    readyEventEmitter: new Emitter<ZCodeTaskIndexReadyEvent>(),
    availableRuntimeGenerationByWorkspaceKey: new Map<string, number>(),
    runtimeState,
    hasRuntimeLifecycle: Boolean(agentService.onAgentRuntimeLifecycle),
    isLiveState: (state) =>
      !runtimeState.disposed && workspaceIngests.get(resolveWorkspaceKey(state.target)) === state,
  };
}

export function createWorkspaceIngestState(
  target: ZCodeAgentWorkspaceTarget,
  runtimeGeneration: number | null,
): WorkspaceIngestState {
  return {
    target: {
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
    },
    runtimeGeneration,
    indexSubscriptionId: null,
    configSubscriptionId: null,
    indexSubscriptionGeneration: 0,
    configSubscriptionGeneration: 0,
    indexPending: null,
    configPending: null,
    indexLogEpoch: null,
    indexSeq: 0,
    configLogEpoch: null,
    configSeq: 0,
    indexHasAppliedBase: false,
    configHasAppliedBase: false,
    indexRecovery: null,
    configRecovery: null,
    indexRecoveryGeneration: 0,
    configRecoveryGeneration: 0,
    indexRetryTimer: null,
    configRetryTimer: null,
    indexRetryAttempt: 0,
    configRetryAttempt: 0,
    indexLastWarnAt: null,
    configLastWarnAt: null,
    summaries: new Map(),
    seeded: false,
    frameListenersInstalled: false,
    disposables: [],
    indexAssembler: new TopicWireFrameAssembler(sessionsIndexTopicFrameSchema),
    configAssembler: new TopicWireFrameAssembler(workspaceConfigTopicFrameSchema),
    assemblyTimer: null,
  };
}
