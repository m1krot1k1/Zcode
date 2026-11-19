import {
  PROACTIVE_SUGGESTION_MAX_ASSISTANT_RESULT_CHARS,
  PROACTIVE_SUGGESTION_MAX_DIFFS,
  PROACTIVE_SUGGESTION_MAX_DIFF_CHARS,
  PROACTIVE_SUGGESTION_MAX_MESSAGES,
  PROACTIVE_SUGGESTION_MAX_MESSAGE_CHARS,
  PROACTIVE_SUGGESTION_MAX_OPEN_FILES,
  PROACTIVE_SUGGESTION_MAX_TEST_RESULTS,
  PROACTIVE_SUGGESTION_MAX_TEST_RESULT_CHARS,
  PROACTIVE_SUGGESTION_MAX_TEST_RESULT_STATUS_CHARS,
  PROACTIVE_SUGGESTION_MAX_TEST_RESULT_TOOL_NAME_CHARS,
  PROACTIVE_SUGGESTION_MAX_TOOL_NAME_CHARS,
  PROACTIVE_SUGGESTION_MAX_TOOL_RESULTS,
  PROACTIVE_SUGGESTION_MAX_TOOL_RESULT_CHARS,
  type ProactiveSuggestionContext,
} from "@zcode/shared";

import {
  buildTaskSidePaneMemoryKey,
  readTaskSidePaneMemoryState,
} from "@/lib/taskSidePaneMemory.js";

/**
 * Локальный лимит контекста; совпадает с продуктовой спецификацией и shared
 * strict-схемой запроса (UI-side).
 */
export interface ProactiveSuggestionContextLimits {
  messages: number;
  openFiles: number;
  diffs: number;
  toolResults: number;
  testResults: number;
}

/** Значения — shared-константы: расхождение даёт `invalid_request` на реальном снимке. */
export const PROACTIVE_SUGGESTION_CONTEXT_LIMITS: ProactiveSuggestionContextLimits = {
  messages: PROACTIVE_SUGGESTION_MAX_MESSAGES,
  openFiles: PROACTIVE_SUGGESTION_MAX_OPEN_FILES,
  diffs: PROACTIVE_SUGGESTION_MAX_DIFFS,
  toolResults: PROACTIVE_SUGGESTION_MAX_TOOL_RESULTS,
  testResults: PROACTIVE_SUGGESTION_MAX_TEST_RESULTS,
};

export interface ProactiveSuggestionFileChangeLike {
  path?: string | undefined;
  filePath?: string | undefined;
  summary?: string | undefined;
  additions?: number | undefined;
  deletions?: number | undefined;
}

export interface ProactiveSuggestionRowLike {
  kind?: string | undefined;
  turnId?: string | undefined;
  text?: string | undefined;
  content?: string | undefined;
  summary?: string | undefined;
  title?: string | undefined;
  toolName?: string | undefined;
  name?: string | undefined;
  status?: string | undefined;
  command?: string | undefined;
  inputText?: string | undefined;
  outputText?: string | undefined;
  errorText?: string | undefined;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  fileChanges?: readonly ProactiveSuggestionFileChangeLike[] | undefined;
}

export interface ProactiveSuggestionDiffLike {
  path: string;
  summary?: string | undefined;
}

export type ProactiveSuggestionUiContext = ProactiveSuggestionContext;

/**
 * Минимальный структурный вид файловой транзакции для диффов контекста.
 * Реальный источник — `fileTransactionStore`; типом не владеем, чтобы модуль
 * оставался на слое ui и не импортировал store.
 */
export interface ProactiveSuggestionTransactionFileLike {
  path?: string | undefined;
  displayPath?: string | undefined;
  operation?: string | undefined;
  additions?: number | undefined;
  deletions?: number | undefined;
}

export interface ProactiveSuggestionTransactionLike {
  status?: string | undefined;
  files?: readonly ProactiveSuggestionTransactionFileLike[] | undefined;
}

export interface BuildProactiveSuggestionContextInput {
  rows: readonly ProactiveSuggestionRowLike[];
  openFiles?: readonly string[] | undefined;
  diffs?: readonly ProactiveSuggestionDiffLike[] | undefined;
  limits?: Partial<ProactiveSuggestionContextLimits> | undefined;
}

function readRecordString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return "";
}

function readUnknownText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return readRecordString(value as Record<string, unknown>, [
    "text",
    "content",
    "stdout",
    "stderr",
    "output",
    "result",
    "message",
  ]);
}

function readRowText(row: ProactiveSuggestionRowLike): string {
  return (row.text ?? row.content ?? "").trim();
}

function rowKind(row: ProactiveSuggestionRowLike): string {
  return (row.kind ?? "").toLowerCase();
}

function isUserRow(row: ProactiveSuggestionRowLike): boolean {
  return rowKind(row).includes("user");
}

function isAssistantRow(row: ProactiveSuggestionRowLike): boolean {
  return rowKind(row).includes("assistant");
}

/** `assistantText` — camelCase: сравнение kind обязано быть регистронезависимым. */
function isAssistantTextRow(row: ProactiveSuggestionRowLike): boolean {
  const kind = rowKind(row);
  return kind.includes("assistant") && kind.includes("text");
}

function readToolName(row: ProactiveSuggestionRowLike): string {
  return (row.toolName ?? row.name ?? row.title ?? "tool")
    .trim()
    .slice(0, PROACTIVE_SUGGESTION_MAX_TOOL_NAME_CHARS);
}

function readCommand(row: ProactiveSuggestionRowLike): string {
  if (row.command?.trim()) return row.command.trim();
  if (row.inputText?.trim()) return row.inputText.trim();
  if (row.input && typeof row.input === "object" && !Array.isArray(row.input)) {
    return readRecordString(row.input as Record<string, unknown>, [
      "command",
      "cmd",
      "script",
      "shell",
    ]).trim();
  }
  return "";
}

function readToolResultText(row: ProactiveSuggestionRowLike): string {
  const candidates = [
    row.summary,
    row.outputText,
    readUnknownText(row.output),
    readUnknownText(row.error),
    row.errorText,
    row.text,
    row.content,
  ];
  for (const candidate of candidates) {
    const text = candidate?.trim();
    if (text) return text.slice(0, PROACTIVE_SUGGESTION_MAX_TOOL_RESULT_CHARS);
  }
  return "";
}

const TEST_COMMAND_PATTERN =
  /(?:^|[\s;&|])(?:pnpm|npm|yarn|bun|npx|vitest|jest|pytest|mocha|playwright|cypress|go\s+test|cargo\s+test|test|lint|typecheck)\b/i;
const TEST_TOOL_PATTERN = /test|vitest|jest|pytest|playwright|cypress|check/i;

function isTestToolRow(row: ProactiveSuggestionRowLike): boolean {
  const kind = row.kind ?? "";
  if (!kind.toLowerCase().includes("tool")) return false;
  if (TEST_TOOL_PATTERN.test(readToolName(row))) return true;
  return TEST_COMMAND_PATTERN.test(readCommand(row));
}

function readFileChangePath(change: ProactiveSuggestionFileChangeLike): string {
  return (change.path ?? change.filePath ?? "").trim();
}

function toDiff(change: ProactiveSuggestionFileChangeLike): ProactiveSuggestionDiffLike | null {
  const path = readFileChangePath(change);
  if (!path) return null;
  const descriptor: string[] = [];
  if (typeof change.additions === "number") descriptor.push(`+${change.additions}`);
  if (typeof change.deletions === "number") descriptor.push(`-${change.deletions}`);
  const summary = (change.summary?.trim() || descriptor.join(" ")).slice(
    0,
    PROACTIVE_SUGGESTION_MAX_DIFF_CHARS,
  );
  return summary ? { path, summary } : { path };
}

/** Снимок контекста из проекции; лимиты соблюдаются до сериализации. */
export function buildProactiveSuggestionContext(
  input: BuildProactiveSuggestionContextInput,
): ProactiveSuggestionUiContext {
  const limits = { ...PROACTIVE_SUGGESTION_CONTEXT_LIMITS, ...input.limits };
  const rows = input.rows;

  const messages = rows
    .filter((row) => isUserRow(row) || isAssistantRow(row))
    .filter((row) => readRowText(row).length > 0)
    .slice(-limits.messages)
    .map((row) => ({
      role: isUserRow(row) ? ("user" as const) : ("assistant" as const),
      text: readRowText(row).slice(0, PROACTIVE_SUGGESTION_MAX_MESSAGE_CHARS),
    }));

  const assistantRow = [...rows]
    .reverse()
    .find((row) => isAssistantTextRow(row) && readRowText(row).length > 0);
  const assistantResult = assistantRow
    ? readRowText(assistantRow).slice(0, PROACTIVE_SUGGESTION_MAX_ASSISTANT_RESULT_CHARS)
    : null;

  const toolResults = rows
    .filter((row) => rowKind(row).includes("tool"))
    .filter((row) => !isTestToolRow(row))
    .map((row) => ({
      toolName: readToolName(row),
      summary: readToolResultText(row),
    }))
    .filter((tool) => tool.summary.length > 0)
    .slice(-limits.toolResults);

  const testResults = rows
    .filter(isTestToolRow)
    .map((row) => {
      const command = readCommand(row);
      const name = command ? `${readToolName(row)} ${command}` : readToolName(row);
      return {
        toolName: name.slice(0, PROACTIVE_SUGGESTION_MAX_TEST_RESULT_TOOL_NAME_CHARS),
        status: (row.status ?? "completed").slice(
          0,
          PROACTIVE_SUGGESTION_MAX_TEST_RESULT_STATUS_CHARS,
        ),
        summary: readToolResultText(row).slice(0, PROACTIVE_SUGGESTION_MAX_TEST_RESULT_CHARS),
      };
    })
    .filter((result) => result.summary.length > 0)
    .slice(-limits.testResults);

  const explicitDiffs = (input.diffs ?? []).map((diff) => {
    const summary = diff.summary?.trim().slice(0, PROACTIVE_SUGGESTION_MAX_DIFF_CHARS);
    return {
      path: diff.path.trim(),
      ...(summary ? { summary } : {}),
    };
  });
  const rowDiffs = rows.flatMap((row) =>
    // Реальная проекция хранит на turnHeader агрегат `fileChanges: {files: number}`;
    // списка файлов там нет. Без Array.isArray это падало на `.flatMap`.
    (Array.isArray(row.fileChanges) ? row.fileChanges : []).flatMap((change) => {
      const diff = toDiff(change);
      return diff ? [diff] : [];
    }),
  );
  const diffsByPath = new Map<string, ProactiveSuggestionDiffLike>();
  for (const diff of [...rowDiffs, ...explicitDiffs]) {
    if (diff.path) diffsByPath.set(diff.path, diff);
  }
  const diffs = [...diffsByPath.values()].slice(-limits.diffs);

  const openFiles = [...new Set((input.openFiles ?? []).filter((path) => path.trim()))].slice(
    -limits.openFiles,
  );

  return {
    messages,
    assistantResult,
    toolResults,
    diffs,
    openFiles,
    testResults,
  };
}

/**
 * Открытые code-viewer табы workspace — реальный источник `openFiles`.
 * Side pane memory — renderer-кэш, поэтому читаем его лениво в момент сборки контекста.
 */
export function readProactiveSuggestionOpenFilePaths(input: {
  workspacePath: string;
  workspaceIdentity?: string | undefined;
}): string[] {
  const key = buildTaskSidePaneMemoryKey({
    workspacePath: input.workspacePath,
    workspaceIdentity: input.workspaceIdentity,
    taskId: null,
  });
  const state = readTaskSidePaneMemoryState(key);
  const tabs = (state.sidePaneState as { tabs?: readonly unknown[] } | null)?.tabs ?? [];
  const paths: string[] = [];
  for (const tab of tabs) {
    if (!tab || typeof tab !== "object") continue;
    const source = (tab as { source?: unknown }).source;
    if (!source || typeof source !== "object") continue;
    const path = (source as { path?: unknown }).path;
    if (typeof path === "string" && path.trim().length > 0) paths.push(path);
  }
  return [...new Set(paths)].slice(-PROACTIVE_SUGGESTION_CONTEXT_LIMITS.openFiles);
}

/** Граница проекции: читает только известные поля и не падает на старых snapshot. */
export function readProactiveSuggestionRows(
  snapshot: unknown,
): readonly ProactiveSuggestionRowLike[] {
  const window = (snapshot as { rows?: { window?: unknown } } | null)?.rows?.window;
  if (!Array.isArray(window)) return [];
  const rows: ProactiveSuggestionRowLike[] = [];
  for (const entry of window) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const source = entry as Record<string, unknown>;
    const row: ProactiveSuggestionRowLike = {};
    for (const key of [
      "kind",
      "turnId",
      "text",
      "content",
      "summary",
      "title",
      "toolName",
      "name",
      "status",
      "command",
      "inputText",
      "outputText",
      "errorText",
    ] as const) {
      const value = source[key];
      if (typeof value === "string") row[key] = value;
    }
    if ("input" in source) row.input = source.input;
    if ("output" in source) row.output = source.output;
    if ("error" in source) row.error = source.error;
    if (Array.isArray(source.fileChanges)) {
      row.fileChanges = source.fileChanges as ProactiveSuggestionFileChangeLike[];
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Собирает диффы из транзакций файлов (renderer store) в формат контекста.
 * Откатанные транзакции пропускаются: их изменений в рабочем дереве нет.
 */
export function buildProactiveSuggestionTransactionDiffs(
  transactions: readonly ProactiveSuggestionTransactionLike[],
): ProactiveSuggestionDiffLike[] {
  const diffs = new Map<string, ProactiveSuggestionDiffLike>();
  for (const transaction of transactions) {
    if (transaction.status === "rolled_back") continue;
    for (const file of transaction.files ?? []) {
      const path = (file.path ?? file.displayPath ?? "").trim();
      if (!path) continue;
      const descriptor: string[] = [];
      if (file.operation) descriptor.push(file.operation);
      if (typeof file.additions === "number") descriptor.push(`+${file.additions}`);
      if (typeof file.deletions === "number") descriptor.push(`-${file.deletions}`);
      const summary = descriptor.join(" ").slice(0, PROACTIVE_SUGGESTION_MAX_DIFF_CHARS);
      diffs.set(path, summary ? { path, summary } : { path });
    }
  }
  return [...diffs.values()];
}
