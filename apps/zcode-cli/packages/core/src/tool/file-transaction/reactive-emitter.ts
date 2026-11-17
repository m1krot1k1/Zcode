// ============================================================
// cli-file-transaction: проекция жизненного цикла транзакции в SessionEvent
// ============================================================
//
// Владелец факта — `FileTransactionManager`. Этот слой только переводит
// `FileTransactionLifecycleEvent` в `fileTransaction.updated` и выбирает
// представление по контуру доставки:
//   - `desktop-continuous` → полный structuredPatch (Electron renderer);
//   - `web-remote-replayable` → компактная сводка в пределах 2 КБ.
// Никакой собственной логики состояния: только сериализация готового факта.

import type { DiffHunk, SessionEvent } from "@zcode/contracts";
import type {
  ZCodeFileTransactionBackgroundTask,
  ZCodeFileTransactionDiffFile,
  ZCodeFileTransactionEventPayload,
} from "@zcode/shared";
import {
  estimateFileTransactionPayloadBytes,
  toCompactFileTransactionPayload,
  zcodeFileTransactionEventPayloadSchema,
} from "@zcode/shared";
import type { FileTransactionCommittedFile, FileTransactionLifecycleEvent } from "./contract.js";

export type FileTransactionDeliveryKind = "desktop-continuous" | "web-remote-replayable";

export interface FileTransactionEventProjectionInput {
  readonly event: FileTransactionLifecycleEvent;
  readonly deliveryKind: FileTransactionDeliveryKind;
  /** Полные диффы по путям; отсутствие записи означает «дифф не вычислялся». */
  readonly structuredPatches?: ReadonlyMap<string, readonly DiffHunk[]>;
  /** Счётчики ± по путям; нужны и в компактной сводке. */
  readonly lineStats?: ReadonlyMap<string, { additions: number; deletions: number }>;
  readonly backgroundTasks?: readonly ZCodeFileTransactionBackgroundTask[];
}

/**
 * Собирает payload `fileTransaction.updated` для конкретного контура.
 * Возвращает `undefined`, если событие не проходит runtime-валидацию —
 * лучше потерять уведомление, чем отправить в renderer невалидный кадр.
 */
export function buildFileTransactionEventPayload(
  input: FileTransactionEventProjectionInput,
): ZCodeFileTransactionEventPayload | undefined {
  const { event, deliveryKind } = input;
  const files: ZCodeFileTransactionDiffFile[] = event.files.map((file) => {
    const patch = input.structuredPatches?.get(file.displayPath) ?? input.structuredPatches?.get(file.path);
    const stats = input.lineStats?.get(file.displayPath) ?? input.lineStats?.get(file.path);
    return {
      path: file.path,
      displayPath: file.displayPath,
      operation: file.operation,
      ...(file.moveFromPath ? { moveFromPath: file.moveFromPath } : {}),
      ...(file.appliedTier ? { appliedTier: file.appliedTier } : {}),
      ...(stats ? { additions: stats.additions, deletions: stats.deletions } : {}),
      ...(file.syntaxDiagnostic ? { syntaxValid: file.syntaxDiagnostic.valid } : {}),
      ...(file.beforeSha256 ? { beforeSha256: file.beforeSha256 } : {}),
      ...(file.afterSha256 ? { afterSha256: file.afterSha256 } : {}),
      ...(file.lineEndings ? { lineEndings: file.lineEndings } : {}),
      ...(deliveryKind === "desktop-continuous"
        ? {
            beforeContent: file.beforeContent,
            afterContent: file.afterContent,
            ...(patch ? { structuredPatch: patch as unknown as Record<string, unknown>[] } : {}),
          }
        : {}),
    };
  });

  const full = {
    transactionId: event.transactionId,
    workspaceKey: event.workspaceKey,
    ...(event.workspacePath ? { workspacePath: event.workspacePath } : {}),
    ...(event.workspaceIdentity ? { workspaceIdentity: event.workspaceIdentity } : {}),
    sessionId: event.sessionId,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.agentId ? { agentId: event.agentId } : {}),
    ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
    toolName: event.toolName,
    status: event.status,
    timestamp: event.timestamp,
    affectedPaths: collectAffectedPaths(event.files),
    ...(input.backgroundTasks && input.backgroundTasks.length > 0
      ? { backgroundTasks: [...input.backgroundTasks] }
      : {}),
    ...(event.errorDetails ? { errorDetails: event.errorDetails } : {}),
    compact: false as const,
    files,
  };

  const candidate = (
    deliveryKind === "web-remote-replayable"
      ? toCompactFileTransactionPayload(full as ZCodeFileTransactionEventPayload)
      : full
  ) as ZCodeFileTransactionEventPayload;

  const validated = zcodeFileTransactionEventPayloadSchema.safeParse(candidate);
  return validated.success ? candidate : undefined;
}

/** Байты payload — для телеметрии и контроля бюджета. */
export function fileTransactionPayloadBytes(payload: ZCodeFileTransactionEventPayload): number {
  return estimateFileTransactionPayloadBytes(payload);
}

export interface FileTransactionEventSink {
  readonly emitEvent?: (event: SessionEvent) => Promise<void>;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly traceId: string;
  readonly deliveryKind: FileTransactionDeliveryKind;
  /**
   * 修复原因（Этап 6.1c）：патчи и счётчики ± вычисляются лениво — дифф не нужен до
   * реальной эмиссии, а набор файлов известен только из события. Раньше sink принимал
   * готовые Map, и `createTransactionHooks` их просто не передавал: `desktop-continuous`
   * получал файлы без `structuredPatch`/`additions`, поэтому панель показывала «+0 -0»
   * и не могла открыть diff. Теперь sink сам решает, что строить.
   */
  readonly structuredPatches?: (
    event: FileTransactionLifecycleEvent,
  ) => ReadonlyMap<string, readonly DiffHunk[]> | undefined;
  readonly lineStats?: (
    event: FileTransactionLifecycleEvent,
  ) => ReadonlyMap<string, { additions: number; deletions: number }> | undefined;
  readonly backgroundTasks?: () => readonly ZCodeFileTransactionBackgroundTask[];
}

/**
 * Создаёт `onTransactionEvent`-хук для `FileTransactionManager`.
 * Ошибка эмиссии не влияет на уже принятое решение о коммите/откате.
 */
export function createFileTransactionEventEmitter(
  sink: FileTransactionEventSink,
): (event: FileTransactionLifecycleEvent) => Promise<void> {
  return async (event) => {
    if (!sink.emitEvent) return;
    const payload = buildFileTransactionEventPayload({
      event,
      deliveryKind: sink.deliveryKind,
      ...(sink.structuredPatches ? { structuredPatches: sink.structuredPatches(event) } : {}),
      ...(sink.lineStats ? { lineStats: sink.lineStats(event) } : {}),
      ...(sink.backgroundTasks ? { backgroundTasks: sink.backgroundTasks() } : {}),
    });
    if (!payload) return;
    try {
      await sink.emitEvent({
        id: crypto.randomUUID() as SessionEvent["id"],
        sessionId: sink.sessionId as SessionEvent["sessionId"],
        turnId: sink.turnId as SessionEvent["turnId"],
        type: "file_transaction_updated" as SessionEvent["type"],
        timestamp: new Date(),
        traceId: sink.traceId as SessionEvent["traceId"],
        sequenceNumber: 0,
        payload,
      });
    } catch {
      // Реактивное уведомление не должно ломать транзакцию.
    }
  };
}

function collectAffectedPaths(files: readonly FileTransactionCommittedFile[]): string[] {
  const paths = new Set<string>();
  for (const file of files) {
    paths.add(file.displayPath);
    if (file.moveFromPath) paths.add(file.moveFromPath);
  }
  return [...paths];
}
