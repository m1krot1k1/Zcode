import type { BufferedFact, SupervisorState } from "@/v4/telemetry/supervisor/state.js";

export const MAX_DEDUPE_KEYS = 2_000;
export const MAX_BUFFERED_FACTS_PER_COMMAND = 128;
export const MAX_BUFFERED_COMMANDS = 200;

export class BoundedKeySet {
  private readonly keys = new Set<string>();

  remember(key: string): boolean {
    if (this.keys.has(key)) {
      return false;
    }
    this.keys.add(key);
    if (this.keys.size > MAX_DEDUPE_KEYS) {
      const oldest = this.keys.values().next().value;
      if (typeof oldest === "string") {
        this.keys.delete(oldest);
      }
    }
    return true;
  }

  clear(): void {
    this.keys.clear();
  }
}

export function bufferFact(
  state: SupervisorState,
  commandId: string,
  buffered: BufferedFact,
): void {
  const current = state.pendingFactsByCommandId.get(commandId) ?? [];
  current.push(buffered);
  if (current.length > MAX_BUFFERED_FACTS_PER_COMMAND) {
    // ACK 极慢时只优先裁普通后续 chunk；turn.started、firstChunk、真实模型状态、工具和
    // terminal 都是旧指标的生命周期锚，不能被高频正文挤掉。
    const ordinaryChunkIndex = current.findIndex(
      (item) => item.fact.kind === "stream.chunk" && !item.fact.firstChunk,
    );
    const removableIndex =
      ordinaryChunkIndex >= 0
        ? ordinaryChunkIndex
        : current.findIndex((item) => item.fact.kind !== "turn.started");
    current.splice(removableIndex >= 0 ? removableIndex : 0, 1);
  }
  // Map 的插入顺序即 LRU：命中 command 时先删除再写回，保证最久未收到事实的整组先淘汰。
  state.pendingFactsByCommandId.delete(commandId);
  state.pendingFactsByCommandId.set(commandId, current);
  if (state.pendingFactsByCommandId.size > MAX_BUFFERED_COMMANDS) {
    const oldestCommandId = state.pendingFactsByCommandId.keys().next().value;
    if (typeof oldestCommandId === "string") {
      state.pendingFactsByCommandId.delete(oldestCommandId);
    }
  }
}

export function drainPendingFacts(state: SupervisorState, commandId: string): void {
  const lifecycle = state.lifecyclesByCommandId.get(commandId);
  const pending = state.pendingFactsByCommandId.get(commandId);
  if (!lifecycle || !pending || pending.length === 0) return;
  state.pendingFactsByCommandId.delete(commandId);
  for (const item of pending) {
    if (!state.lifecyclesByCommandId.has(commandId)) return;
    if (
      item.fact.kind === "turn.started" &&
      hasDeferredTerminalForTask(state, lifecycle.taskKey, lifecycle.sourceCommandId)
    ) {
      bufferFact(state, commandId, item);
      continue;
    }
    if (!lifecycle.active && item.fact.kind !== "turn.started") {
      bufferFact(state, commandId, item);
      continue;
    }
    state.processPromptFact(lifecycle, item.fact, item.receivedAt, item.foregroundAtReceipt);
  }
}

export function hasDeferredTerminalForTask(
  state: SupervisorState,
  taskKey: string,
  exceptCommandId?: string,
): boolean {
  return [...state.deferredTerminalsByCommandId].some(
    ([commandId, deferred]) =>
      commandId !== exceptCommandId && deferred.lifecycle.taskKey === taskKey,
  );
}

export function drainPromptBlockedByDeferredTerminal(
  state: SupervisorState,
  taskKey: string,
): void {
  if (hasDeferredTerminalForTask(state, taskKey)) return;
  const nextLifecycle = [...state.lifecyclesByCommandId.values()]
    .filter(
      (candidate) =>
        candidate.taskKey === taskKey &&
        !candidate.active &&
        state.pendingFactsByCommandId
          .get(candidate.sourceCommandId)
          ?.some((item) => item.fact.kind === "turn.started"),
    )
    .sort((left, right) => left.sendTime - right.sendTime)[0];
  if (nextLifecycle) drainPendingFacts(state, nextLifecycle.sourceCommandId);
}
