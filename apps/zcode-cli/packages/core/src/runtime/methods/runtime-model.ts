import type { ModelRequestSessionType, ModelRetryBudget } from "@zcode/contracts";
import type { ModelRequestAdmissionTicket, ModelRequestTarget } from "@zcode/contracts";
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
import { DEFAULT_COMPACT_CONTEXT_WINDOW } from "../../compact/policy.js";
import { resolveRootRunReservationMaxOutputTokens } from "./model-token-limits.js";

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
  if (!factoryInput.selection) {
    throw createCoreError(CoreErrorType.ConfigurationError, "Select a model before continuing", {
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
  return withModelInvocationContext(model, (request) => {
    const context = getCurrentModelInvocationContext();
    const traceContext = context?.traceContext;
    // 子 Agent 的 runtime 句柄可能仍归属根会话；根预算必须按本次请求的子会话查 lineage，
    // 否则会把 child turn 拼成一个不存在的 rootRunId，并在首个模型请求时误判预算耗尽。
    const invocationSessionId = traceContext?.sessionId ?? runtime.sessionId;
    const rootRunId = runtime.runtimeTaskRegistry.getRootRunIdForSession(
      invocationSessionId,
      traceContext?.turnId,
    );
    const contextWindow =
      model.properties.contextWindow === undefined
        ? DEFAULT_COMPACT_CONTEXT_WINDOW
        : model.properties.contextWindow;
    // 根因与修复依据见 resolveRootRunReservationMaxOutputTokens：384k 的模型输出上限
    // 不能原样变成 admission 预留，否则一个 in-flight 请求就吃掉 500k root-run 预算的 77%。
    const maxTokens = resolveRootRunReservationMaxOutputTokens({
      requestedMaxOutputTokens: request.options?.maxOutputTokens ?? model.options.maxOutputTokens,
    });
    if (!rootRunId) {
      return layer;
    }
    return {
      ...layer,
      modelRequestAdmission: withRootRunResourceBudgetAdmission({
        admission: runtime.modelRequestAdmission,
        contextWindow,
        maxTokens,
        rootRunId,
        registry: runtime.runtimeTaskRegistry,
        sessionId: invocationSessionId,
      }),
    };
  });
}

function withRootRunResourceBudgetAdmission(input: {
  admission: ModelInvocationContext["modelRequestAdmission"];
  contextWindow: number;
  maxTokens: number;
  rootRunId: string;
  registry: AgentRuntimeInternal["runtimeTaskRegistry"];
  sessionId: AgentRuntimeInternal["sessionId"];
}): NonNullable<ModelInvocationContext["modelRequestAdmission"]> {
  const reserve = () =>
    input.registry.reserveRootRunTokens({
      contextWindow: input.contextWindow,
      maxTokens: input.maxTokens,
      rootRunId: input.rootRunId,
      sessionId: input.sessionId,
    });
  const withReservation = (
    ticket: ModelRequestAdmissionTicket,
    reservation: ReturnType<typeof reserve>,
  ): ModelRequestAdmissionTicket => {
    // 根因：adapter 的 attempt ticket 会在 ModelComplete 原始事件持久化前 release；
    // 修复依据：token reservation 只能由 registry 观察到的 ModelComplete / model_request_failed 消费，
    // 否则并发请求会在 provider 已返回、usage 尚未入账的窗口重复花费同一预算。
    const wrapped: ModelRequestAdmissionTicket = {
      publish: (event) => {
        reservation.associateRequestId(event.requestId);
        return ticket.publish(event);
      },
      release: () => {
        ticket.release();
      },
    };
    if (ticket.publishFailure) {
      wrapped.publishFailure = (event, error) => {
        reservation.associateRequestId(event.requestId);
        return ticket.publishFailure!(event, error);
      };
    }
    return wrapped;
  };
  const acquire = async (model: ModelRequestTarget, signal?: AbortSignal) => {
    // acquire 失败后 adapter 仍写入 model_request_failed；保留 reservation，
    // 让 durable raw event 负责消费它，避免与后续请求共用同一预算窗口。
    const reservation = reserve();
    const ticket = input.admission
      ? await input.admission.acquire({ model, ...(signal ? { signal } : {}) })
      : { publish() {}, release() {} };
    return withReservation(ticket, reservation);
  };
  return {
    ...(input.admission?.tryAcquire
      ? {
          tryAcquire: (request: { model: ModelRequestTarget }) => {
            const reservation = reserve();
            const ticket = input.admission!.tryAcquire!(request);
            if (!ticket) {
              reservation();
              return undefined;
            }
            return withReservation(ticket, reservation);
          },
        }
      : {}),
    acquire: ({ model, signal }) => acquire(model, signal),
  };
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
