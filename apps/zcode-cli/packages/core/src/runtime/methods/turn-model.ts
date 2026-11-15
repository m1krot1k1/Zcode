import {
  ModelRetryBudget,
  SESSION_ENTRY_MODEL_SELECTION,
  type Model,
  type ModelSelection,
  type TraceContext,
  type TurnInputIntentMetadata,
} from "@zcode/contracts";
import { getCurrentModelInvocationContext } from "../deps.js";
import {
  resolveExplicitReasoningLevel,
  resolveRootAutoEffort,
} from "../helpers/root-auto-effort.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { cloneModelSelection } from "../model-selection.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { createRuntimeModel, withModelInvocationContext } from "./runtime-model.js";
import { applyRuntimeExecutionState } from "../execution-state.js";
import { acceptOffPeakUserTakeover, selectionForPersistence } from "../off-peak/runtime.js";

const selectionAdmissions = new WeakMap<
  AgentRuntimeInternal,
  {
    sequence: number;
    commandId: string;
    persisted: Promise<void>;
  }
>();
// 只用于 ModelSelected 的前后展示边界，不参与选模、续跑或持久化。
const publishedSelections = new WeakMap<AgentRuntimeInternal, ModelSelection | undefined>();

/** 先固定旧会话候选，再接纳用户选择；声明目标失效时仍能退回原会话模型。 */
export function captureHighspeedFallbackSelection(
  runtime: AgentRuntimeInternal,
  execution: import("../types.js").ModelExecutionContext | undefined,
): import("../types.js").ModelExecutionContext | undefined {
  if (!execution?.selectionFallback) return execution;
  return {
    ...execution,
    highspeedFallbackSelection: structuredClone(runtime.getSessionModelSelection()),
  };
}

export function recordPublishedModelSelection(
  runtime: AgentRuntimeInternal,
  selection: ModelSelection,
): void {
  publishedSelections.set(runtime, cloneModelSelection(selection));
}

/** 串行接纳序号决定续跑选择；队列消费只能执行自己的快照，不能倒写较新的选择。 */
export function acceptSubmissionModelSelection(
  runtime: AgentRuntimeInternal,
  intent: TurnInputIntentMetadata | undefined,
  _traceContext: TraceContext,
  modelExecution?: Pick<
    import("../types.js").ModelExecutionContext,
    "selectionScope" | "selectionFallback"
  > & {
    highspeedFallbackSelection?: ModelSelection;
  },
  options?: { reasoningLevelExplicit?: boolean },
): Promise<void> {
  const selection =
    modelExecution?.selectionScope === "execution"
      ? (modelExecution.selectionFallback?.target ?? modelExecution.highspeedFallbackSelection)
      : intent?.modelSelection;
  if (!selection || !intent) return Promise.resolve();
  const previous = selectionAdmissions.get(runtime);
  if (
    previous &&
    (previous.commandId === intent.sourceCommandId ||
      (Number.isFinite(intent.admissionSeq) && intent.admissionSeq <= previous.sequence))
  ) {
    return previous.persisted;
  }
  const previousSelection = runtime.getSessionModelSelection();
  if (!publishedSelections.has(runtime)) publishedSelections.set(runtime, previousSelection);
  const appliedSelection = cloneModelSelection(selection);
  // Auto-выбор никогда не становится пользовательским пином; execution-scoped модель не
  // меняет явность session. Обычный submission наследует explicit из intent/сессии, а
  // смена уровня в самом submission считается явной.
  const reasoningLevelExplicit =
    options?.reasoningLevelExplicit ??
    (modelExecution?.selectionScope === "execution"
      ? runtime.reasoningLevelExplicit
      : resolveExplicitReasoningLevel({
          intentSelection: intent.modelSelection,
          intentExplicit: readIntentReasoningLevelExplicit(intent),
          sessionSelection: previousSelection,
          sessionExplicit: runtime.reasoningLevelExplicit,
        }));
  runtime.setSessionModelSelection(appliedSelection, { reasoningLevelExplicit });
  acceptOffPeakUserTakeover(runtime);
  // 保存串行化，防止旧异步写入在新选择之后落库；不引入另一份输入队列。
  const persisted = (previous?.persisted ?? Promise.resolve()).then(async () => {
    if (runtime.sessionRowCreated) await persistRuntimeModelSelection(runtime, appliedSelection);
  });
  selectionAdmissions.set(runtime, {
    sequence: Number.isFinite(intent.admissionSeq)
      ? intent.admissionSeq
      : (previous?.sequence ?? 0),
    commandId: intent.sourceCommandId,
    persisted,
  });
  return persisted;
}

/**
 * Поле появилось в протоколе позже; старые клиенты его не присылают. Читаем структурно и
 * принимаем только boolean, чтобы рантайм не зависел от расширения contracts в этом изменении.
 */
function readIntentReasoningLevelExplicit(
  intent: TurnInputIntentMetadata | undefined,
): boolean | undefined {
  const intentWithFlag = intent as
    | (TurnInputIntentMetadata & { reasoningLevelExplicit?: unknown })
    | undefined;
  const value = intentWithFlag?.reasoningLevelExplicit;
  return typeof value === "boolean" ? value : undefined;
}

/**
 * 带退回声明且 Selection 指向声明 provider 的执行句柄只允许一次物理请求：失败后由 core 退回会话模型
 * 继续本轮，适配层再按默认预算退避重试只会把降级拖到数分钟之后（spec §2.2「加速请求 0 次重试」）。
 * 其余句柄返回 undefined，沿用按 taskType 解析的默认预算。
 */
export function resolveExecutionModelRetryBudget(input: {
  selection: ModelSelection | undefined;
  selectionFallback: import("../types.js").ModelExecutionContext["selectionFallback"];
}): ModelRetryBudget | undefined {
  if (!input.selection || !input.selectionFallback) return undefined;
  return input.selection.providerId === input.selectionFallback.providerId
    ? ModelRetryBudget.SingleAttempt
    : undefined;
}

export function createTurnModel(
  runtime: AgentRuntimeInternal,
  options: {
    selection?: ModelSelection;
    requestDependencies?: import("@zcode/contracts").ModelRequestDependencies;
    retryBudget?: ModelRetryBudget;
  } = {},
): Model {
  const selection = options.selection ?? runtime.getSessionModelSelection();
  const model = createRuntimeModel(runtime, {
    selection,
    requestDependencies: options.requestDependencies,
    retryBudget: options.retryBudget,
  });
  return withModelInvocationContext(model, (request) => ({
    refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(runtime, {
      abortSignal: request.abortSignal,
      model,
      traceContext: getCurrentModelInvocationContext()?.traceContext ?? runtime.rootTraceContext,
    }),
  }));
}

interface RootAutoSelection {
  selection: ModelSelection;
  previousSelection: ModelSelection;
  supportedLevels: readonly string[];
}

const TASK_GRAPH_HINT = /(?:task_graph|task graph|граф задач)/iu;

/**
 * Явный level пользователя всегда главнее. Явность — отдельное состояние сессии
 * (`reasoningLevelExplicit`), а не наличие `options.reasoningLevel`: default модели,
 * workspace preference и persisted default не должны навсегда выключать auto.
 * Execution-scoped модель (off-peak) не переопределяется.
 */
function resolveRootAutoSelection(options: {
  runtime: AgentRuntimeInternal;
  selection: ModelSelection | undefined;
  intent: TurnInputIntentMetadata | undefined;
  prompt: string | undefined;
  modelExecution: import("../types.js").ModelExecutionContext | undefined;
}): RootAutoSelection | undefined {
  const { runtime, selection, intent, prompt, modelExecution } = options;
  if (!selection || !prompt?.trim()) return undefined;
  if (runtime.config.autoReasoningLevel === false) return undefined;
  if (modelExecution?.selectionScope === "execution") return undefined;
  const explicit = resolveExplicitReasoningLevel({
    intentSelection: intent?.modelSelection,
    intentExplicit: readIntentReasoningLevelExplicit(intent),
    sessionSelection: runtime.getSessionModelSelection(),
    sessionExplicit: runtime.reasoningLevelExplicit,
  });
  if (explicit) return undefined;
  const baseModel = createTurnModel(runtime, {
    selection,
    requestDependencies: modelExecution?.requestDependencies,
    retryBudget: resolveExecutionModelRetryBudget({
      selection,
      selectionFallback: modelExecution?.selectionFallback,
    }),
  });
  const supportedLevels = baseModel.optionSpecs.reasoningLevel.values;
  const auto = resolveRootAutoEffort({
    prompt,
    planEnabled: intent?.planEnabled,
    hasTaskGraph: TASK_GRAPH_HINT.test(prompt),
    supportedLevels,
  });
  if (!auto || auto.level === selection.options?.reasoningLevel) return undefined;
  return {
    selection: {
      ...cloneModelSelection(selection),
      options: { ...selection.options, reasoningLevel: auto.level },
    },
    previousSelection: cloneModelSelection(selection),
    supportedLevels,
  };
}

/**
 * 在 Submission 真正开始执行或 Guide 被下一次 model step 消费时应用其执行配置。
 * 选择只决定新创建的 Model；已经被其他 Loop 持有的 Model 不会被修改。
 */
export async function applySubmissionExecutionState(
  runtime: AgentRuntimeInternal,
  intent: TurnInputIntentMetadata | undefined,
  traceContext: TraceContext,
  modelExecution?: import("../types.js").ModelExecutionContext,
  preparedModel?: Model,
  prompt?: string,
): Promise<Model | undefined> {
  const requestedSelection = intent?.modelSelection ?? runtime.getSessionModelSelection();
  const auto = resolveRootAutoSelection({
    runtime,
    selection: requestedSelection,
    intent,
    prompt,
    modelExecution,
  });
  const selection = auto?.selection ?? intent?.modelSelection;
  const previousSelection = auto?.previousSelection ?? publishedSelections.get(runtime);
  const supportedThoughtLevels =
    auto?.supportedLevels ?? preparedModel?.optionSpecs.reasoningLevel.values;
  let model = preparedModel;

  if (selection) {
    // Auto меняет reasoningLevel уже после admission-prepared Model: preparedModel
    // собран под исходный selection и сохранил бы старый level. Пересобираем из
    // финального selection; без auto по-прежнему переиспользуем prepared Model.
    const createSelectedModel = () =>
      createTurnModel(runtime, {
        selection,
        requestDependencies: modelExecution?.requestDependencies,
        retryBudget: resolveExecutionModelRetryBudget({
          selection,
          selectionFallback: modelExecution?.selectionFallback,
        }),
      });
    model = auto ? createSelectedModel() : (model ?? createSelectedModel());
    await acceptSubmissionModelSelection(
      runtime,
      intent ? { ...intent, modelSelection: selection } : intent,
      traceContext,
      modelExecution,
      auto ? { reasoningLevelExplicit: false } : undefined,
    );
    if (modelExecution?.selectionScope !== "execution") {
      // ModelSelected 展示实际 Loop 的切换；接纳只保存意图，不提前创建可调用 Model。
      publishedSelections.set(runtime, cloneModelSelection(selection));
      if (!sameModelSelection(previousSelection, selection)) {
        await runtime.emitModelSelected({
          model,
          modelSelection: selection,
          effectiveReasoningLevel: model.options.reasoningLevel,
          previousModelSelection: previousSelection,
          supportedThoughtLevels:
            supportedThoughtLevels ?? model.optionSpecs.reasoningLevel.values,
          traceContext,
        });
      }
    }
  }

  if (intent?.mode !== undefined || intent?.planEnabled !== undefined) {
    await applyRuntimeExecutionState(runtime, intent, { source: "command", traceContext });
  }

  return model;
}

export function sameModelSelection(
  left: ModelSelection | undefined,
  right: ModelSelection,
): boolean {
  return (
    left?.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.options?.reasoningLevel === right.options?.reasoningLevel
  );
}

/**
 * Core-owned sidecar: `runtime/model_selection` хранит только ModelSelection (формат
 * совместим со старыми сборками), а явность уровня живёт отдельной entry.
 */
const SESSION_ENTRY_REASONING_LEVEL_EXPLICIT = "runtime/reasoning_level_explicit" as const;

// Один write-path и один порядок: записи не должны обгонять друг друга при параллельных
// первых сообщениях/`/effort`. Очередь local-runtime, без таймаутов и ретраев.
const modelSelectionPersistenceChains = new WeakMap<AgentRuntimeInternal, Promise<void>>();

export function persistRuntimeModelSelection(
  runtime: AgentRuntimeInternal,
  selection: ModelSelection,
): Promise<void> {
  const previous =
    modelSelectionPersistenceChains.get(runtime) ?? Promise.resolve();
  const next = previous.then(() => writeRuntimeModelSelection(runtime, selection));
  modelSelectionPersistenceChains.set(runtime, next);
  return next;
}

async function writeRuntimeModelSelection(
  runtime: AgentRuntimeInternal,
  selection: ModelSelection,
): Promise<void> {
  if (!runtime.sessionStore?.saveSessionEntry) return;
  // FK `session_entry.session_id -> session(id)`: draft-сессия ещё не имеет строки.
  // Выбор остаётся в runtime state и пишется штатным persistSession после createSession.
  if (!runtime.sessionRowCreated) return;
  const persistentSelection = selectionForPersistence(runtime, selection);
  if (!persistentSelection) return;
  const timestamp = Date.now();
  try {
    await runtime.sessionStore.saveSessionEntry({
      id: `${runtime.sessionId}:runtime-model-selection`,
      sessionID: runtime.sessionId,
      type: SESSION_ENTRY_MODEL_SELECTION,
      touchSession: false,
      time: { created: timestamp, updated: timestamp },
      data: persistentSelection,
    });
  } catch (error) {
    runtime.logger?.warn("Session model selection persistence failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "session.model_selection.persist_failed",
      modelId: selection.modelId,
      module: "core.runtime",
      providerId: selection.providerId,
      status: "failed",
      thoughtLevel: selection.options?.reasoningLevel,
    });
    return;
  }
  try {
    await runtime.sessionStore.saveSessionEntry({
      id: `${runtime.sessionId}:runtime-reasoning-level-explicit`,
      sessionID: runtime.sessionId,
      type: SESSION_ENTRY_REASONING_LEVEL_EXPLICIT,
      touchSession: false,
      time: { created: timestamp, updated: timestamp },
      data: {
        explicit: runtime.reasoningLevelExplicit,
        // Уровень фиксируем вместе с явностью: bootstrap `/effort` после первого сообщения
        // пишет только selection entry. Несовпадение означает внешнюю запись выбора —
        // трактуем её как пользовательскую и не перетираем auto.
        level: persistentSelection.options?.reasoningLevel ?? null,
      },
    });
  } catch (error) {
    // Selection уже сохранён; потеря sidecar не должна откатывать выбор и не блокирует turn.
    runtime.logger?.warn("Session reasoning level explicitness persistence failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "session.reasoning_level_explicit.persist_failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}

/**
 * Восстанавливает явность уровня при холодном resume. Новая entry читается первой;
 * старые сессии без sidecar сохраняют прежнее поведение (level в selection = explicit),
 * чтобы auto не перетёр реальный выбор пользователя из прошлой версии.
 */
export async function restoreReasoningLevelExplicitOnResume(
  runtime: AgentRuntimeInternal,
): Promise<void> {
  const selection = runtime.getSessionModelSelection();
  let persisted: boolean | undefined;
  try {
    const entries = await runtime.sessionStore?.sessionEntries?.({
      sessionID: runtime.sessionId,
      type: SESSION_ENTRY_REASONING_LEVEL_EXPLICIT,
      limit: 1,
      order: "desc",
    });
    const data = entries?.at(-1)?.data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const explicit = (data as { explicit?: unknown }).explicit;
      if (typeof explicit === "boolean") {
        const sidecarLevel = (data as { level?: unknown }).level;
        const currentLevel = selection?.options?.reasoningLevel ?? null;
        // Selection entry новее sidecar (его писала не core-точка, например bootstrap
        // `/effort`): сохраняем выбор пользователя, не полагаемся на устаревший флаг.
        persisted =
          sidecarLevel !== undefined && sidecarLevel !== currentLevel ? true : explicit;
      }
    }
  } catch (error) {
    // Чтение sidecar не должно блокировать resume; fallback ниже консервативен.
    runtime.logger?.warn("Session reasoning level explicitness restore failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "session.reasoning_level_explicit.restore_failed",
      module: "core.runtime",
      status: "failed",
    });
  }
  runtime.reasoningLevelExplicit =
    persisted ?? selection?.options?.reasoningLevel !== undefined;
}
