/**
 * zcodeTaskServiceAdapter.ts: фасад адаптера legacy task projection к ZCode session.
 *
 * Реализация разложена по модулям-соседям:
 * - `zcodeTaskServiceAdapterCore` — опции, состояние задачи и базовые помощники;
 * - `zcodeTaskServiceAdapterToolProjection` — live-проекция tool-вызовов;
 * - `zcodeTaskServiceAdapterPrompt` / `RuntimeCommands` — отправка промпта и очередь команд;
 * - `zcodeTaskServiceAdapterTaskIndex` / `ServiceEvents` — snapshot/resume и события сервиса;
 * - `zcodeTaskServiceAdapter*Methods` — методы IZCodeTaskService;
 * - `zcodeTaskServiceAdapter*Mapping` / `*Payloads` — чистые мапперы протокола.
 */
import type { IZCodeTaskService } from "../session/zcodeTaskService.js";
import {
  createCoreHelpers,
  createTaskAdapterState,
  type CreateZCodeTaskServiceAdapterOptions,
} from "./zcodeTaskServiceAdapterCore.js";
import { createToolProjectionHelpers } from "./zcodeTaskServiceAdapterToolProjection.js";
import { createPromptHelpers } from "./zcodeTaskServiceAdapterPrompt.js";
import { createRuntimeCommandHelpers } from "./zcodeTaskServiceAdapterRuntimeCommands.js";
import { createTaskIndexHelpers } from "./zcodeTaskServiceAdapterTaskIndex.js";
import { createServiceEventsHelpers } from "./zcodeTaskServiceAdapterServiceEvents.js";
import type { AdapterService, TaskAdapterContext } from "./zcodeTaskServiceAdapterContext.js";
import { createTaskLifecycleMethods } from "./zcodeTaskServiceAdapterTaskMethods.js";
import { createBotMethods } from "./zcodeTaskServiceAdapterBotMethods.js";
import { createCommandMethods } from "./zcodeTaskServiceAdapterCommandMethods.js";
import { createTaskSettingsMethods } from "./zcodeTaskServiceAdapterTaskSettingsMethods.js";
import { createTaskAdminMethods } from "./zcodeTaskServiceAdapterAdminMethods.js";

export function createZCodeTaskServiceAdapter(
  options: CreateZCodeTaskServiceAdapterOptions,
): IZCodeTaskService & {
  disposeAll(): void;
  disposeAllAndWait(): Promise<void>;
} {
  const state = createTaskAdapterState(options);
  const base = { options, ...state };
  const core = createCoreHelpers(base);
  const toolProjection = createToolProjectionHelpers({ ...base, ...core });
  const prompt = createPromptHelpers({ ...base, ...core, ...toolProjection });
  const runtimeCommands = createRuntimeCommandHelpers({ ...base, ...core, ...prompt });
  const taskIndex = createTaskIndexHelpers({ ...base, ...core });
  const serviceEvents = createServiceEventsHelpers({
    ...base,
    ...core,
    ...toolProjection,
    ...runtimeCommands,
    ...taskIndex,
  });

  // Методы адаптера вызывают друг друга (getTaskSnapshotWithEtag/setAssistantMessageFeedback/
  // setConfigOption), поэтому собранный service подставляется после композиции групп.
  let service!: AdapterService;
  const context: TaskAdapterContext = {
    ...base,
    ...core,
    ...toolProjection,
    ...prompt,
    ...runtimeCommands,
    ...taskIndex,
    ...serviceEvents,
    get service() {
      return service;
    },
  };

  service = {
    ...createTaskLifecycleMethods(context),
    ...createBotMethods(context),
    ...createCommandMethods(context),
    ...createTaskSettingsMethods(context),
    ...createTaskAdminMethods(context),
  };

  return service;
}
