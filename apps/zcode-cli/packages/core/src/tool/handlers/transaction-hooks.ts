// ============================================================
// Общие хуки транзакционного редактирования для Edit/Write/ApplyPatch/MultiEdit
// ============================================================
//
// Один владелец решения «что эмитить в UI» — здесь, чтобы все инструменты
// публиковали `fileTransaction.updated` одинаково. Контур доставки определяет
// только форму payload: `desktop-continuous` получает полный патч,
// `web-remote-replayable` — компактную сводку в пределах 2 КБ.

import type { DiffHunk } from "@zcode/contracts";
import { createStructuredPatch } from "../diff.js";
import {
  createFileTransactionEventEmitter,
  type FileTransactionCommittedFile,
  type FileTransactionDeliveryKind,
  type FileTransactionLifecycleEvent,
} from "../file-transaction/index.js";
import type { ToolExecutionContext } from "../types.js";

/** Контур доставки: Electron получает полный патч, Web/Mobile — сводку. */
export function resolveFileTransactionDeliveryKind(
  context: ToolExecutionContext,
): FileTransactionDeliveryKind {
  if (
    context.deliveryKind === "web-remote-replayable" ||
    context.clientMode === "web-remote-replayable"
  ) {
    return "web-remote-replayable";
  }
  return "desktop-continuous";
}

/** Считает ± по готовому патчу — единая метрика для всех инструментов. */
export function countPatchLines(hunks: readonly DiffHunk[]): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      if (line.startsWith("-")) deletions += 1;
    }
  }
  return { additions, deletions };
}

/** Строит полные патчи и статистику по зафиксированным файлам транзакции. */
export function buildPatchProjections(files: readonly FileTransactionCommittedFile[]): {
  patches: Map<string, readonly DiffHunk[]>;
  stats: Map<string, { additions: number; deletions: number }>;
} {
  const patches = new Map<string, readonly DiffHunk[]>();
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const file of files) {
    if (file.operation === "delete") continue;
    const hunks = createStructuredPatch({
      filePath: file.displayPath,
      oldContent: file.beforeContent ?? "",
      newContent: file.afterContent,
    });
    patches.set(file.displayPath, hunks);
    stats.set(file.displayPath, countPatchLines(hunks));
  }
  return { patches, stats };
}

/**
 * Создаёт `onTransactionEvent`-хук. Патчи вычисляются лениво — только когда
 * событие реально эмитится, чтобы не платить за дифф на каждом шаге коммита.
 */
export function createTransactionHooks(
  context: ToolExecutionContext,
): ((event: FileTransactionLifecycleEvent) => Promise<void>) | undefined {
  const emitter = createFileTransactionEventEmitter({
    ...(context.emitEvent ? { emitEvent: context.emitEvent } : {}),
    sessionId: context.sessionId,
    ...(context.turnId ? { turnId: context.turnId } : {}),
    traceId: context.traceId,
    deliveryKind: resolveFileTransactionDeliveryKind(context),
  });
  return context.emitEvent ? emitter : undefined;
}
