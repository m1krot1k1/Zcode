import type { ModelRequestSessionType, ModelRetryBudget } from "@zcode/contracts";
import {
  CoreErrorType,
  createCoreError,
  getCurrentModelInvocationContext,
  runWithModelInvocationContext,
  SessionEventType,
  type Model,
  type ModelInvocationContext,
  type ModelRequest,
  type SessionEvent,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeModelFactoryInput } from "../types.js";
import {
  resolveModelRequestSessionTypeFromTaskType,
  resolveModelRetryBudgetFromTaskType,
} from "./model-request-session-type.js";
import { getOffPeakModelBinding } from "../off-peak/model-binding.js";

export function createRuntimeModel(
  runtime: AgentRuntimeInternal,
  input: Omit<RuntimeModelFactoryInput, "selection"> & {
    selection: RuntimeModelFactoryInput["selection"] | undefined;
    scope?: "session" | "workspace";
    /**
     * 覆盖按 taskType 解析的重试预算，只绑定到本次创建的句柄，不进入 Factory 输入。
     * 目前只有带 selectionFallback 声明的执行作用域 Selection 使用 single-attempt。
     */
    retryBudget?: ModelRetryBudget;
  },
): Model {
  const { retryBudget, scope = "session", ...factoryInput } = input;
  // 未绑定 Session 可恢复历史；仅在执行入口拒绝缺失选择，Factory 契约仍严格。
  // Bugfix：历史快照与未校验的协议输入会传 `{ providerId: "glm", modelId: null | "" }`，
  // 旧守卫只判断 selection 是否存在，这种空模型会一路走到 registry（model-not-found 被包成
  // protocol error）或 `selection.options!` 的 TypeError，本轮既不失败也不结束，只能等超时。
  // 修复依据：执行入口只接受 providerId 与 modelId 都非空的完整选择。
  if (!isCompleteModelSelection(factoryInput.selection)) {
    throw createCoreError(CoreErrorType.NoModelSelected, "Select a model before continuing", {
      recoverable: true,
    });
  }
  const model = withRuntimeInvocationLayer(
    runtime,
    runtime.modelFactory({ ...factoryInput, selection: factoryInput.selection }),
    scope === "workspace"
      ? "other"
      : resolveModelRequestSessionTypeFromTaskType(runtime.config.taskType),
    retryBudget,
  );
  return getOffPeakModelBinding(input.requestDependencies)?.wrap(model) ?? model;
}

/**
 * 判断 Selection 是否指向一个真实模型。
 *
 * Selection 可能来自历史快照或未校验的协议输入，类型声明（`providerId: string`）不保证运行时
 * 非空：`{ providerId: "glm", modelId: null }` 在日志里就是 `model = NULL` 的那次挂起。
 */
function isCompleteModelSelection(
  selection: { readonly providerId?: string | null; readonly modelId?: string | null } | undefined,
): selection is RuntimeModelFactoryInput["selection"] {
  const providerId = typeof selection?.providerId === "string" ? selection.providerId.trim() : "";
  const modelId = typeof selection?.modelId === "string" ? selection.modelId.trim() : "";
  return providerId.length > 0 && modelId.length > 0;
}

/** Возвращает ID реально завершившейся успешной provider-попытки для ModelComplete. */
export function getLatestCompletedModelRequestId(
  events: readonly SessionEvent[],
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== SessionEventType.ModelNetworkStatus) continue;
    const payload = event.payload as { type?: string; requestId?: unknown };
    if (payload.type !== "model_request_completed") continue;
    return typeof payload.requestId === "string" && payload.requestId.length > 0
      ? payload.requestId
      : undefined;
  }
  return undefined;
}

/**
 * runtime 层调用上下文。
 *
 * 准入端口与重试预算回答的是「谁在调」（这个 runtime 归哪个治理器管、允许多少次重试），不是
 * 「为什么调」（agent step / web_search / compact / title）。设计缺口：它们若只在 turn step
 * 的调用上下文里注入，WebSearch / WebFetch 处理 / 压缩 / 标题 sidecar 等九处只设「为什么调」的
 * 调用点全部绕过了闸门——实测场景下治理器看不见三分之二的 429。现在这两个字段在句柄
 * 工厂绑定一次；`withModelInvocationContext` 的合并顺序让本层压过调用层，没有逐调用退出口：
 * 想不受闸门约束的 runtime 本来就不带准入端口。
 */
function withRuntimeInvocationLayer(
  runtime: AgentRuntimeInternal,
  model: Model,
  sessionType: ModelRequestSessionType,
  retryBudget?: ModelRetryBudget,
): Model {
  const layer: ModelInvocationContext = {
    // Bugfix: вспомогательные запросы OpenCode (инструменты, compaction, заголовки) обходили
    // основной turn wrapper и теряли workspace. Привязываем каталог к каждому runtime model handle.
    workingDirectory: runtime.workingDirectory,
    // 原因：标题、Memory、工具调用曾按用途覆写 other，丢失宿主分类。
    // 会话类型统一绑定在句柄上；工作区独立请求即使借用会话 runtime 也保持 other。
    modelRequestSessionType: sessionType,
    // 带退回声明的执行句柄显式传入 single-attempt，其余沿用 taskType 默认预算。
    modelRetryBudget: retryBudget ?? resolveModelRetryBudgetFromTaskType(runtime.config.taskType),
    ...(runtime.modelRequestAdmission === undefined
      ? {}
      : { modelRequestAdmission: runtime.modelRequestAdmission }),
  };
  return withModelInvocationContext(model, () => layer);
}

export function withModelInvocationContext(
  model: Model,
  createContext: (request: ModelRequest) => ModelInvocationContext,
): Model {
  const wrapped: Model = {
    providerId: model.providerId,
    modelId: model.modelId,
    displayName: model.displayName,
    properties: model.properties,
    requestCapabilities: model.requestCapabilities,
    optionSpecs: model.optionSpecs,
    options: model.options,
    bind(options) {
      return withModelInvocationContext(model.bind(options), createContext);
    },
    generateText(request) {
      return runWithModelInvocationContext(
        { ...getCurrentModelInvocationContext(), ...createContext(request) },
        () => model.generateText(request),
      );
    },
    streamText(request) {
      return runWithModelInvocationContext(
        { ...getCurrentModelInvocationContext(), ...createContext(request) },
        () => model.streamText(request),
      );
    },
  };
  return Object.freeze(wrapped);
}
