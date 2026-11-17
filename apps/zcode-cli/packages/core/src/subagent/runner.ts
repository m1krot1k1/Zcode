// ============================================================
// Subagent Runner (точка входа)
// ============================================================

import {
  AgentErrorCode,
  CoreErrorType,
  createCoreError,
  type AgentOutput,
  type SubagentLaunchOptions,
  type SubagentLaunchRequest,
  type SubagentPort,
  type SubagentSendMessageOptions,
  type SubagentSendMessageRequest,
  type SubagentSendMessageResult,
  type SubagentStopOptions,
  type SubagentTaskSnapshot,
  type SubagentWaitOptions,
} from "@zcode/contracts";
import { normalizeAgentProfiles } from "./profile.js";
import { InMemoryRuntimeTaskRegistry } from "../runtime-task/registry.js";
import {
  type ExploreRunnerContext,
  type ExploreSubagentPort,
  type ExploreSubagentPortOptions,
  BACKGROUND_AGENT_STOPPED_STATE,
} from "./runner-types.js";
import {
  normalizeAutoBackgroundMs,
  resolveAgentProfileForRequest,
  toSubagentExecutionRequest,
} from "./runner-admission.js";
import { runSubagentTaskDag } from "./runner-dag.js";
import { sendMessageToLocalAgent } from "./runner-messages.js";
import { runExploreSubagent } from "./runner-run.js";
import { startExploreSubagentInBackground } from "./runner-start.js";

async function launchSubagent(
  ctx: ExploreRunnerContext,
  port: ExploreSubagentPort,
  rawRequest: SubagentLaunchRequest,
  launchOptions?: SubagentLaunchOptions,
): Promise<AgentOutput> {
  const { profile, request } = resolveAgentProfileForRequest(ctx.getProfiles(), rawRequest);
  const executionRequest = toSubagentExecutionRequest(request);
  const backgroundRequested =
    rawRequest.runInBackground === true || profile.background === true;
  if (backgroundRequested) {
    if (launchOptions?.modelOverride?.background === "deny") {
      // 单次执行的模型与动态鉴权不能脱离父 loop 生命周期进入后台。
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        "Idle-time tasks do not support background agents. Run this agent in the foreground.",
        {
          context: {
            code: AgentErrorCode.BACKGROUND_UNAVAILABLE,
            agentType: rawRequest.agentType,
            parentToolCallId: rawRequest.parentToolCallId,
          },
          recoverable: true,
        },
      );
    }
    return port.start(executionRequest, {
      signal: launchOptions?.signal,
      ...(launchOptions?.model ? { model: launchOptions.model } : {}),
      ...(launchOptions?.modelOverride ? { modelOverride: launchOptions.modelOverride } : {}),
    });
  }
  return port.run(executionRequest, launchOptions);
}

export function createExploreSubagentPort(options: ExploreSubagentPortOptions): SubagentPort {
  const registry = options.runtimeTaskRegistry ?? new InMemoryRuntimeTaskRegistry();
  const initialProfiles = normalizeAgentProfiles(options.profiles ?? [], {
    builtInModelSelectionOverrides: options.builtInModelSelectionOverrides,
  });
  const ctx: ExploreRunnerContext = {
    options,
    registry,
    borrowedForegroundAgentIds: new Set<string>(),
    getProfiles: () => options.getAgentDefinitions?.().activeAgents ?? initialProfiles,
    autoBackgroundMs: normalizeAutoBackgroundMs(options.autoBackgroundMs),
  };

  const port: ExploreSubagentPort = {
    launch: (rawRequest, launchOptions) => launchSubagent(ctx, port, rawRequest, launchOptions),
    runTaskDag: (rawRequest, runOptions) => runSubagentTaskDag(ctx, port, rawRequest, runOptions),
    run: (rawRequest, runOptions) => runExploreSubagent(ctx, rawRequest, runOptions),
    start: (rawRequest, startOptions) => startExploreSubagentInBackground(ctx, rawRequest, startOptions),
    async getTask(taskId: string): Promise<SubagentTaskSnapshot | undefined> {
      return ctx.registry.get(taskId) ?? (await ctx.options.resolveTerminalTaskCatalog?.(taskId));
    },

    async backgroundTask(taskId: string): Promise<SubagentTaskSnapshot | undefined> {
      if (ctx.borrowedForegroundAgentIds.has(taskId)) {
        return ctx.registry.get(taskId);
      }
      if (!ctx.registry.get(taskId)) return ctx.options.resolveTerminalTaskCatalog?.(taskId);
      ctx.registry.requestBackground(taskId);
      return ctx.registry.get(taskId);
    },

    async waitForTask(
      taskId: string,
      waitOptions?: SubagentWaitOptions,
    ): Promise<SubagentTaskSnapshot | undefined> {
      if (!ctx.registry.get(taskId)) return ctx.options.resolveTerminalTaskCatalog?.(taskId);
      return ctx.registry.waitForTerminal(taskId, { signal: waitOptions?.signal });
    },

    async stopTask(
      taskId: string,
      stopOptions?: SubagentStopOptions,
    ): Promise<SubagentTaskSnapshot | undefined> {
      if (stopOptions?.signal?.aborted) {
        throw stopOptions.signal.reason ?? new Error("Subagent stop aborted");
      }
      const task = ctx.registry.get(taskId);
      if (!task || task.type !== "local_agent") return task;
      return ctx.registry.cancelSubagentSubtree(
        taskId,
        new Error(`${BACKGROUND_AGENT_STOPPED_STATE.message}: ${taskId}`),
      );
    },

    async sendMessage(
      request: SubagentSendMessageRequest,
      sendOptions?: SubagentSendMessageOptions,
    ): Promise<SubagentSendMessageResult> {
      return sendMessageToLocalAgent(ctx.options, ctx.getProfiles, ctx.registry, request, sendOptions);
    },
  };

  return port;
}

export type {
  EnqueueParentTaskNotification,
  ExploreSubagentPortOptions,
  ExploreSubagentRuntimeRequest,
  ExploreSubagentRuntimeResult,
  ParentTaskNotificationCommand,
  SubagentDagNodeStatus,
} from "./runner-types.js";
export {
  resolveActualMaxParallel,
  resolveChildMaxParallel,
  resolveSwarmParallelismWithCapacity,
} from "./runner-parallel.js";
export {
  aggregateWorkResults,
  boundWorkResult,
  collectWorkResultClaims,
  deriveWorkResult,
  deriveWorkResultFromOutput,
  parsePresentationBlock,
  parseWorkResultBlock,
} from "./runner-work-result.js";
export type {
  WorkResultDerivationInput,
  WorkResultNodeInput,
} from "./runner-work-result.js";
export { executeSubagentTaskDag, planSubagentDagWaves } from "./runner-dag.js";
export { restorePreviousTerminalTaskAfterResumeFailure } from "./runner-messages.js";
export {
  isAgentProfileWriteCapable,
  isEffectiveWriteCapable,
} from "./runner-admission.js";
