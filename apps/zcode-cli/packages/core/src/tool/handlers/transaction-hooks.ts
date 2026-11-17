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
 * Уведомляет локальный кодовый индекс о зафиксированных путях.
 *
 * Причина отдельного шага вместо ожидания watcher: коммит транзакции уже знает точные пути,
 * а watcher отдаёт их с задержкой дебаунса. Сигнал идёт через `notifyFilesMutated`, то есть
 * тем же инкрементальным путём, что и события файловой системы, — второй путь записи не
 * создаётся. Ошибки не влияют на уже принятое решение о коммите.
 */
async function notifyCodeIndex(
  context: ToolExecutionContext,
  event: FileTransactionLifecycleEvent,
): Promise<void> {
  if (event.status !== "committed") return;
  const port = context.codeIntelligencePort;
  if (!port?.notifyFilesMutated) return;
  const changed: string[] = [];
  const removed: string[] = [];
  for (const file of event.files) {
    if (file.operation === "delete") removed.push(file.displayPath);
    else changed.push(file.displayPath);
    if (file.moveFromPath) removed.push(file.moveFromPath);
  }
  if (changed.length === 0 && removed.length === 0) return;
  try {
    await port.notifyFilesMutated({
      workspacePath: event.workspacePath,
      ...(event.workspaceIdentity ? { workspaceIdentity: event.workspaceIdentity } : {}),
      changed,
      removed,
    });
  } catch {
    // Индекс — производный кеш: его отставание не должно ломать коммит файла.
  }
}

/**
 * Создаёт `onTransactionEvent`-хук. Патчи вычисляются лениво — только когда
 * событие реально эмитится, чтобы не платить за дифф на каждом шаге коммита.
 */
export function createTransactionHooks(
  context: ToolExecutionContext,
): ((event: FileTransactionLifecycleEvent) => Promise<void>) | undefined {
  // 修复原因（Этап 6.1c）：这里接通了「已计算但从未传下去」的投影。
  // `buildPatchProjections` существовал и экспортировался, но emitter вызывался без
  // `structuredPatches`/`lineStats`, поэтому `fileTransaction.updated` уходил в UI
  // без патча и без счётчиков ±: панель показывала «+0 -0» и не открывала diff.
  // Один ленивый расчёт на событие — источники правды по-прежнему `beforeContent`/
  // `afterContent` из коммита, второй путь вычисления не создаётся.
  const projectionsByEvent = new WeakMap<
    FileTransactionLifecycleEvent,
    ReturnType<typeof buildPatchProjections>
  >();
  const readProjections = (event: FileTransactionLifecycleEvent) => {
    const cached = projectionsByEvent.get(event);
    if (cached) return cached;
    const built = buildPatchProjections(event.files);
    projectionsByEvent.set(event, built);
    return built;
  };
  const emitter = createFileTransactionEventEmitter({
    ...(context.emitEvent ? { emitEvent: context.emitEvent } : {}),
    sessionId: context.sessionId,
    ...(context.turnId ? { turnId: context.turnId } : {}),
    traceId: context.traceId,
    deliveryKind: resolveFileTransactionDeliveryKind(context),
    structuredPatches: (event) => readProjections(event).patches,
    lineStats: (event) => readProjections(event).stats,
  });
  // Хук нужен, даже если UI-события не эмитятся: индекс обновляется по факту коммита.
  const indexEnabled = Boolean(context.codeIntelligencePort?.notifyFilesMutated);
  if (!context.emitEvent && !indexEnabled) return undefined;
  return async (event) => {
    if (context.emitEvent) await emitter(event);
    if (indexEnabled) await notifyCodeIndex(context, event);
  };
}
