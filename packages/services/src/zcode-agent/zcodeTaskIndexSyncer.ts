/**
 * zcodeTaskIndexSyncer.ts: Публичный API syncer'а task index.
 *
 * Реализация разложена по модулям в `./task-index/`:
 * - `contracts` — публичный контракт и late-bound `TaskIndexRuntime`;
 * - `state` — единственный владелец состояния (workspace ingest, emitters, lifecycle);
 * - `emitters` / `targets` — workspace-события и преобразование target'ов;
 * - `topicFrames` / `topicRecovery` / `topicSubscribe` / `topicWire` — v4 topic-конвейер
 *   (staging, recovery flight, subscribe/retry, ownership + assembly);
 * - `sessionsIndexIngest` / `workspaceConfigIngest` — применение кадров;
 * - `taskFactsBridge` / `snapshotSync` — зеркалирование фактов CLI и запись snapshot;
 * - `workspaceLifecycle` — dormant/attach/restart/dispose;
 * - `createTaskIndexSyncer` — сборка контекста и публичного интерфейса.
 */
export { createZCodeTaskIndexSyncer } from "./task-index/index.js";
export type {
  ZCodeTaskIndexReadyEvent,
  ZCodeTaskIndexSyncer,
  ZCodeTaskIndexTerminalEvent,
} from "./task-index/index.js";
