/**
 * Мост `AgentPtyManager` → форма порта, которую ожидает инструмент `PtySession`.
 *
 * Core не знает про adapters: он объявляет узкий порт, а этот файл — единственное
 * место, где реальный менеджер приводится к нему. Никакой дополнительной
 * семантики здесь нет: только переименование `sessionId` в `PtySessionId`.
 */
import { AgentPtyManager, type AgentPtyManagerOptions } from "./agent-pty-manager.js";
import type { PtySessionId } from "./contract.js";

export interface AgentPtySessionPort {
  create: AgentPtyManager["create"];
  write(sessionId: string, data: string): Promise<void>;
  resize(sessionId: string, cols: number, rows: number): Promise<void>;
  read: AgentPtyManager["read"];
  waitFor: AgentPtyManager["waitFor"];
  kill: AgentPtyManager["kill"];
  list: AgentPtyManager["list"];
}

/** Оборачивает менеджер в порт инструмента; строковый id кастуется на границе. */
export function createAgentPtySessionPort(
  manager: AgentPtyManager,
): AgentPtySessionPort {
  return {
    create: (options) => manager.create(options),
    write: (sessionId, data) => manager.write(sessionId as PtySessionId, data),
    resize: (sessionId, cols, rows) =>
      manager.resize(sessionId as PtySessionId, cols, rows),
    read: (sessionId, options) =>
      manager.read(sessionId as PtySessionId, options ?? {}),
    waitFor: (sessionId, options) => manager.waitFor(sessionId as PtySessionId, options),
    kill: (sessionId, options) => manager.kill(sessionId as PtySessionId, options ?? {}),
    list: () => manager.list(),
  };
}

/**
 * Создаёт менеджер и порт одним вызовом — типовой сценарий хоста.
 * `dispose` вызывающего отвечает за освобождение всех сессий.
 */
export function createAgentPtySessionPortWithManager(
  options: AgentPtyManagerOptions = {},
): { manager: AgentPtyManager; port: AgentPtySessionPort; dispose: () => Promise<void> } {
  const manager = new AgentPtyManager(options);
  return {
    manager,
    port: createAgentPtySessionPort(manager),
    dispose: () => manager.dispose(),
  };
}
