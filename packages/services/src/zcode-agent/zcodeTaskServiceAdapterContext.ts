/**
 * zcodeTaskServiceAdapterContext.ts: собранный контекст адаптера — состояние задачи,
 * базовые помощники и под-модули (tool projection, prompt, runtime commands, task index,
 * service events). Собранный service подставляется позже через `service`.
 */
import type { IZCodeTaskService } from "../session/zcodeTaskService.js";
import type {
  CoreHelpers,
  CreateZCodeTaskServiceAdapterOptions,
  TaskAdapterState,
} from "./zcodeTaskServiceAdapterCore.js";
import type { RuntimeCommandHelpers } from "./zcodeTaskServiceAdapterRuntimeCommands.js";
import type { PromptHelpers } from "./zcodeTaskServiceAdapterPrompt.js";
import type { ServiceEventsHelpers } from "./zcodeTaskServiceAdapterServiceEvents.js";
import type { TaskIndexHelpers } from "./zcodeTaskServiceAdapterTaskIndex.js";
import type { ToolProjectionHelpers } from "./zcodeTaskServiceAdapterToolProjection.js";

export type AdapterService = IZCodeTaskService & {
  disposeAll(): void;
  disposeAllAndWait(): Promise<void>;
};

export type TaskAdapterContext = {
  options: CreateZCodeTaskServiceAdapterOptions;
} & TaskAdapterState &
  CoreHelpers &
  ToolProjectionHelpers &
  PromptHelpers &
  RuntimeCommandHelpers &
  TaskIndexHelpers &
  ServiceEventsHelpers & {
    // Поздняя ссылка: методы вызывают друг друга через собранный service
    // (getTaskSnapshotWithEtag/setAssistantMessageFeedback/setConfigOption).
    service: AdapterService;
  };
