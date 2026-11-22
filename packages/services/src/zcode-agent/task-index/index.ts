/**
 * task-index/index.ts: Публичный barrel модуля task index syncer.
 *
 * Наружу отдаём только фабрику и контракт событий/интерфейса; внутренние группы
 * (frames/recovery/subscribe/ingest/facts/snapshot/lifecycle) — деталь реализации.
 */
export { createZCodeTaskIndexSyncer } from "./createTaskIndexSyncer.js";
export type {
  ZCodeTaskIndexReadyEvent,
  ZCodeTaskIndexSyncer,
  ZCodeTaskIndexTerminalEvent,
} from "./contracts.js";
