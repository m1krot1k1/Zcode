// Subagent runner: bound/parse/derive WorkResult и агрегация результатов DAG.

import {
  SessionEventType,
  type AgentCompletedOutput,
  type AgentPresentation,
  type SessionEvent,
  type WorkResult,
  type WorkResultClaimEntry,
  type WorkResultMetrics,
  type WorkResultStatus,
  type WorkResultTestEntry,
} from "@zcode/contracts";
import {
  AgentPresentationSchema,
  WORK_RESULT_LIMITS,
  WorkResultSchema,
} from "@zcode/contracts";
import { type RuntimeTaskRegistry, type RuntimeTaskSnapshot } from "../runtime-task/registry.js";
import { isRecord } from "./runner-artifacts.js";
import { truncateUtf8 } from "./runner-bounded-text.js";
import type { SubagentDagNodeStatus } from "./runner-types.js";

const WORK_RESULT_BLOCK = /<zcode-work-result>\s*([\s\S]*?)\s*<\/zcode-work-result>/gu;
const WORK_RESULT_SUMMARY_MAX_CHARS = 2_000;
const WORK_RESULT_DERIVED_ENTRIES_MAX = 20;
const WORK_RESULT_TEST_SUMMARY_MAX_CHARS = 500;
const WORK_RESULT_FILE_TOOL_NAMES = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const WORK_RESULT_TEST_COMMAND =
  /\b(?:vitest|jest|pytest|(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test|tsc\s+--noEmit|oxlint|eslint|cargo\s+test|go\s+test)\b/u;
/** Заголовок схемы — источник правды для лимитов; summary без текста не проходит min(1). */
const WORK_RESULT_SUMMARY_FALLBACK = "(no textual summary)";

/**
 * Обрезка по UTF-16 code units: zod `.max()` считает именно их, а не байты.
 * Маркер входит в лимит, а последний code unit не разрезается между surrogate pair.
 */
function boundWorkResultText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = "…";
  let end = Math.max(0, maxChars - marker.length);
  if (end > 0) {
    const lastCodeUnit = value.charCodeAt(end - 1);
    if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1;
  }
  return `${value.slice(0, end)}${marker}`;
}

function boundWorkResultEntries(
  values: readonly string[],
  maxEntries: number,
  maxChars: number,
): string[] {
  const bounded: string[] = [];
  for (const value of values) {
    // Пустая строка не проходит min(1) — выбрасываем вместо невалидного элемента.
    if (value.length === 0) continue;
    bounded.push(boundWorkResultText(value, maxChars));
    if (bounded.length >= maxEntries) break;
  }
  return bounded;
}

function boundWorkResultMetrics(metrics: WorkResultMetrics): WorkResultMetrics {
  const bound = (value: number | undefined): number | undefined =>
    value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined;
  const durationMs = bound(metrics.durationMs);
  const toolUses = bound(metrics.toolUses);
  const tokens = bound(metrics.tokens);
  return {
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(toolUses === undefined ? {} : { toolUses }),
    ...(tokens === undefined ? {} : { tokens }),
  };
}

/**
 * Приводит WorkResult к лимитам `WorkResultSchema`.
 *
 * Причина: WorkResult собирается из tool events и DAG-узлов без ограничений, поэтому
 * длинный file_path/Bash-команда или большой fan-out давали результат, который сама
 * схема отклоняла; `validateOutput` бросал ToolExecutionFailed и терял работу child'а.
 */
export function boundWorkResult(result: WorkResult): WorkResult {
  const confidence =
    result.confidence !== undefined && Number.isFinite(result.confidence)
      ? Math.min(1, Math.max(0, result.confidence))
      : undefined;
  const claims: WorkResultClaimEntry[] = [];
  for (const claim of result.claims) {
    if (claim.path.length === 0) continue;
    claims.push({
      path: boundWorkResultText(claim.path, WORK_RESULT_LIMITS.claims.path),
      ...(claim.runId === undefined || claim.runId.length === 0
        ? {}
        : { runId: boundWorkResultText(claim.runId, WORK_RESULT_LIMITS.claims.runId) }),
      ...(claim.attemptId === undefined || claim.attemptId.length === 0
        ? {}
        : {
            attemptId: boundWorkResultText(claim.attemptId, WORK_RESULT_LIMITS.claims.attemptId),
          }),
    });
    if (claims.length >= WORK_RESULT_LIMITS.claims.max) break;
  }
  const tests: WorkResultTestEntry[] = [];
  for (const test of result.tests) {
    if (test.command.length === 0) continue;
    tests.push({
      command: boundWorkResultText(test.command, WORK_RESULT_LIMITS.tests.command),
      status: test.status,
      ...(test.summary === undefined
        ? {}
        : { summary: boundWorkResultText(test.summary, WORK_RESULT_LIMITS.tests.summary) }),
    });
    if (tests.length >= WORK_RESULT_LIMITS.tests.max) break;
  }
  return {
    status: result.status,
    summary: boundWorkResultText(
      result.summary.length === 0 ? WORK_RESULT_SUMMARY_FALLBACK : result.summary,
      WORK_RESULT_LIMITS.summary,
    ),
    files: boundWorkResultEntries(
      result.files,
      WORK_RESULT_LIMITS.files.max,
      WORK_RESULT_LIMITS.files.entry,
    ),
    evidence: boundWorkResultEntries(
      result.evidence,
      WORK_RESULT_LIMITS.evidence.max,
      WORK_RESULT_LIMITS.evidence.entry,
    ),
    tests,
    unresolved: boundWorkResultEntries(
      result.unresolved,
      WORK_RESULT_LIMITS.unresolved.max,
      WORK_RESULT_LIMITS.unresolved.entry,
    ),
    ...(confidence === undefined ? {} : { confidence }),
    claims,
    ...(result.metrics === undefined ? {} : { metrics: boundWorkResultMetrics(result.metrics) }),
  };
}

/** Обрезает только размеры/количества сырого JSON, не подменяя типы и структуру. */
function boundWorkResultCandidate(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const bounded: Record<string, unknown> = { ...value };
  if (typeof bounded.summary === "string") {
    bounded.summary = boundWorkResultText(bounded.summary, WORK_RESULT_LIMITS.summary);
  }
  const boundEntryArray = (raw: unknown, maxEntries: number, maxChars: number): unknown => {
    if (!Array.isArray(raw)) return raw;
    return raw
      .slice(0, maxEntries)
      .map((entry) => (typeof entry === "string" ? boundWorkResultText(entry, maxChars) : entry));
  };
  bounded.files = boundEntryArray(
    bounded.files,
    WORK_RESULT_LIMITS.files.max,
    WORK_RESULT_LIMITS.files.entry,
  );
  bounded.evidence = boundEntryArray(
    bounded.evidence,
    WORK_RESULT_LIMITS.evidence.max,
    WORK_RESULT_LIMITS.evidence.entry,
  );
  bounded.unresolved = boundEntryArray(
    bounded.unresolved,
    WORK_RESULT_LIMITS.unresolved.max,
    WORK_RESULT_LIMITS.unresolved.entry,
  );
  if (Array.isArray(bounded.tests)) {
    bounded.tests = bounded.tests
      .slice(0, WORK_RESULT_LIMITS.tests.max)
      .map((entry) =>
        isRecord(entry)
          ? {
              ...entry,
              ...(typeof entry.command === "string"
                ? { command: boundWorkResultText(entry.command, WORK_RESULT_LIMITS.tests.command) }
                : {}),
              ...(typeof entry.summary === "string"
                ? { summary: boundWorkResultText(entry.summary, WORK_RESULT_LIMITS.tests.summary) }
                : {}),
            }
          : entry,
      );
  }
  if (Array.isArray(bounded.claims)) {
    bounded.claims = bounded.claims
      .slice(0, WORK_RESULT_LIMITS.claims.max)
      .map((entry) =>
        isRecord(entry)
          ? {
              ...entry,
              ...(typeof entry.path === "string"
                ? { path: boundWorkResultText(entry.path, WORK_RESULT_LIMITS.claims.path) }
                : {}),
              ...(typeof entry.runId === "string"
                ? { runId: boundWorkResultText(entry.runId, WORK_RESULT_LIMITS.claims.runId) }
                : {}),
              ...(typeof entry.attemptId === "string"
                ? {
                    attemptId: boundWorkResultText(
                      entry.attemptId,
                      WORK_RESULT_LIMITS.claims.attemptId,
                    ),
                  }
                : {}),
            }
          : entry,
      );
  }
  return bounded;
}

/**
 * Парсит последний блок `<zcode-work-result>JSON</zcode-work-result>`.
 * Невалидный JSON или несоответствие схеме — undefined (вызывающий использует fallback).
 * Превышение лимитов обрезается до валидации: иначе огромный, но корректный итог
 * отбрасывался бы целиком вместе с заявленным статусом.
 */
export function parseWorkResultBlock(text: string): WorkResult | undefined {
  let payload: string | undefined;
  for (const match of text.matchAll(WORK_RESULT_BLOCK)) {
    payload = match[1];
  }
  if (payload === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  const result = WorkResultSchema.safeParse(boundWorkResultCandidate(parsed));
  return result.success ? boundWorkResult(result.data) : undefined;
}

const PRESENTATION_BLOCK = /<zcode-presentation>\s*([\s\S]*?)\s*<\/zcode-presentation>/gu;

/**
 * Парсит последний блок `<zcode-presentation>JSON</zcode-presentation>`.
 * Невалидный JSON или несоответствие строгой схеме — undefined: runtime не переписывает
 * ответ агента и использует прежний formatter-вывод.
 */
export function parsePresentationBlock(text: string): AgentPresentation | undefined {
  let payload: string | undefined;
  for (const match of text.matchAll(PRESENTATION_BLOCK)) {
    payload = match[1];
  }
  if (payload === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  const result = AgentPresentationSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

export interface WorkResultDerivationInput {
  text: string;
  events: readonly SessionEvent[];
  durationMs?: number;
  toolUses?: number;
  tokens?: number;
  claims?: readonly WorkResultClaimEntry[];
  fallbackStatus?: WorkResultStatus;
}

interface ScheduledToolFact {
  toolName: string;
  input: unknown;
}

interface ToolOutcomeFact {
  success: boolean;
  summary?: string;
}

function uniqueStrings(values: Iterable<string>, limit: number): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= limit) break;
  }
  return result;
}

function collectToolFacts(events: readonly SessionEvent[]): {
  scheduled: Map<string, ScheduledToolFact>;
  outcomes: Map<string, ToolOutcomeFact>;
} {
  const scheduled = new Map<string, ScheduledToolFact>();
  const outcomes = new Map<string, ToolOutcomeFact>();
  for (const event of events) {
    if (!isRecord(event.payload)) continue;
    const payload = event.payload;
    const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
    if (event.type === SessionEventType.ToolCallScheduled) {
      if (!toolCallId || typeof payload.toolName !== "string") continue;
      scheduled.set(toolCallId, { toolName: payload.toolName, input: payload.input });
      continue;
    }
    if (!toolCallId) continue;
    if (event.type === SessionEventType.ToolCallResult) {
      const result = isRecord(payload.result) ? payload.result : undefined;
      outcomes.set(toolCallId, {
        success: result?.success === true,
        summary:
          typeof result?.content === "string"
            ? result.content.slice(0, WORK_RESULT_TEST_SUMMARY_MAX_CHARS)
            : undefined,
      });
      continue;
    }
    if (event.type === SessionEventType.ToolCallError) {
      const error = isRecord(payload.error) ? payload.error : undefined;
      const detail =
        (typeof error?.underlyingErrorMessage === "string" && error.underlyingErrorMessage) ||
        (typeof error?.detail === "string" && error.detail) ||
        (typeof error?.code === "string" && error.code) ||
        undefined;
      outcomes.set(toolCallId, {
        success: false,
        ...(detail ? { summary: detail.slice(0, WORK_RESULT_TEST_SUMMARY_MAX_CHARS) } : {}),
      });
    }
  }
  return { scheduled, outcomes };
}

function deriveFilesFromToolFacts(scheduled: Map<string, ScheduledToolFact>): string[] {
  const files: string[] = [];
  for (const fact of scheduled.values()) {
    if (!WORK_RESULT_FILE_TOOL_NAMES.has(fact.toolName) || !isRecord(fact.input)) continue;
    const filePath = fact.input.file_path ?? fact.input.path;
    if (typeof filePath === "string") files.push(filePath);
  }
  return uniqueStrings(files, WORK_RESULT_DERIVED_ENTRIES_MAX);
}

function deriveTestsFromToolFacts(
  scheduled: Map<string, ScheduledToolFact>,
  outcomes: Map<string, ToolOutcomeFact>,
): WorkResultTestEntry[] {
  const tests: WorkResultTestEntry[] = [];
  const seenCommands = new Set<string>();
  for (const [toolCallId, fact] of scheduled) {
    if (fact.toolName !== "Bash" && fact.toolName !== "bash" && fact.toolName !== "Shell") {
      continue;
    }
    if (!isRecord(fact.input) || typeof fact.input.command !== "string") continue;
    const command = fact.input.command.trim();
    if (command.length === 0 || seenCommands.has(command)) continue;
    if (!WORK_RESULT_TEST_COMMAND.test(command)) continue;
    seenCommands.add(command);
    const outcome = outcomes.get(toolCallId);
    tests.push({
      command,
      status: outcome === undefined ? "not_run" : outcome.success ? "passed" : "failed",
      ...(outcome?.success === false && outcome.summary ? { summary: outcome.summary } : {}),
    });
    if (tests.length >= WORK_RESULT_DERIVED_ENTRIES_MAX) break;
  }
  return tests;
}

function deriveEvidenceFromToolFacts(
  scheduled: Map<string, ScheduledToolFact>,
  outcomes: Map<string, ToolOutcomeFact>,
): string[] {
  const evidence: string[] = [];
  for (const [toolCallId, outcome] of outcomes) {
    const toolName = scheduled.get(toolCallId)?.toolName ?? "unknown";
    evidence.push(
      `${outcome.success ? "tool_call_result" : "tool_call_error"}:${toolName}:${toolCallId}`,
    );
  }
  return uniqueStrings(evidence, WORK_RESULT_DERIVED_ENTRIES_MAX);
}

function withRuntimeWorkResultFacts(
  result: WorkResult,
  input: WorkResultDerivationInput,
): WorkResult {
  const metrics: WorkResultMetrics = {
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(input.toolUses === undefined ? {} : { toolUses: input.toolUses }),
    ...(input.tokens === undefined ? {} : { tokens: input.tokens }),
  };
  return {
    ...result,
    // Claims принадлежат runtime/ledger, а не worker-тексту: переданный массив
    // (включая пустой) побеждает claims из `<zcode-work-result>`.
    ...(input.claims !== undefined ? { claims: [...input.claims] } : {}),
    ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
  };
}

/**
 * WorkResult из финального текста worker'а с детерминированным fallback:
 * summary — текст, files/tests/evidence — tool events, metrics — usage/toolUseCount.
 * Результат всегда приводится к лимитам `WorkResultSchema`.
 */
export function deriveWorkResult(input: WorkResultDerivationInput): WorkResult {
  const parsed = parseWorkResultBlock(input.text);
  if (parsed) return boundWorkResult(withRuntimeWorkResultFacts(parsed, input));

  const facts = collectToolFacts(input.events);
  const trimmedText = input.text.trim();
  const summary =
    trimmedText.length === 0
      ? "(no textual summary)"
      : trimmedText.length > WORK_RESULT_SUMMARY_MAX_CHARS
        ? `${trimmedText.slice(0, WORK_RESULT_SUMMARY_MAX_CHARS - 1)}…`
        : trimmedText;
  return boundWorkResult({
    status: input.fallbackStatus ?? "completed",
    summary,
    files: deriveFilesFromToolFacts(facts.scheduled),
    evidence: deriveEvidenceFromToolFacts(facts.scheduled, facts.outcomes),
    tests: deriveTestsFromToolFacts(facts.scheduled, facts.outcomes),
    unresolved: [],
    claims: [...(input.claims ?? [])],
    ...(input.durationMs === undefined && input.toolUses === undefined && input.tokens === undefined
      ? {}
      : {
          metrics: {
            ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
            ...(input.toolUses === undefined ? {} : { toolUses: input.toolUses }),
            ...(input.tokens === undefined ? {} : { tokens: input.tokens }),
          },
        }),
  });
}

/** WorkResult готового node output; для моков/старых путей выводится из текста. */
export function deriveWorkResultFromOutput(output: AgentCompletedOutput): WorkResult {
  if (output.workResult) return boundWorkResult(output.workResult);
  return deriveWorkResult({
    text: output.content.map((block) => block.text).join("\n"),
    events: [],
    durationMs: output.totalDurationMs,
    toolUses: output.totalToolUseCount,
    ...(output.totalTokens === undefined ? {} : { tokens: output.totalTokens }),
  });
}

export interface WorkResultNodeInput {
  nodeId: string;
  status: SubagentDagNodeStatus;
  output?: AgentCompletedOutput;
  error?: string;
}

/** Агрегирует WorkResult узлов DAG: completed только при полном успехе. */
export function aggregateWorkResults(
  entries: readonly WorkResultNodeInput[],
  options: { description?: string } = {},
): WorkResult {
  const nodes = entries.map((entry) => ({
    entry,
    result: entry.output ? deriveWorkResultFromOutput(entry.output) : undefined,
  }));
  const anyFailed = nodes.some(
    (node) => node.entry.status === "failed" || node.result?.status === "failed",
  );
  const allCompleted =
    nodes.length > 0 &&
    nodes.every(
      (node) =>
        node.entry.status === "completed" && (node.result?.status ?? "completed") === "completed",
    );
  const status: WorkResultStatus = anyFailed ? "failed" : allCompleted ? "completed" : "partial";

  const files = uniqueStrings(
    nodes.flatMap((node) => node.result?.files ?? []),
    WORK_RESULT_DERIVED_ENTRIES_MAX,
  );
  const evidence = uniqueStrings(
    nodes.flatMap((node) => node.result?.evidence ?? []),
    WORK_RESULT_DERIVED_ENTRIES_MAX,
  );
  const testByCommand = new Map<string, WorkResultTestEntry>();
  for (const node of nodes) {
    for (const test of node.result?.tests ?? []) {
      const existing = testByCommand.get(test.command);
      if (!existing || test.status === "failed" || existing.status === "not_run") {
        testByCommand.set(test.command, test);
      }
    }
  }
  const unresolved: string[] = [];
  for (const node of nodes) {
    for (const item of node.result?.unresolved ?? []) {
      unresolved.push(`${node.entry.nodeId}: ${item}`);
    }
    if (!node.result && node.entry.status !== "completed") {
      unresolved.push(
        `${node.entry.nodeId}: ${node.entry.status}${
          node.entry.error ? `: ${node.entry.error}` : ""
        }`,
      );
    }
  }
  const claims = new Map<string, WorkResultClaimEntry>();
  for (const node of nodes) {
    for (const claim of node.result?.claims ?? []) {
      claims.set(`${claim.path}\u0000${claim.runId ?? ""}\u0000${claim.attemptId ?? ""}`, claim);
    }
  }
  const metrics = { durationMs: 0, toolUses: 0, tokens: 0 };
  let sawMetrics = false;
  const confidences: number[] = [];
  for (const node of nodes) {
    const nodeMetrics = node.result?.metrics;
    if (nodeMetrics) {
      sawMetrics = true;
      metrics.durationMs += nodeMetrics.durationMs ?? 0;
      metrics.toolUses += nodeMetrics.toolUses ?? 0;
      metrics.tokens += nodeMetrics.tokens ?? 0;
    }
    if (node.result?.confidence !== undefined) confidences.push(node.result.confidence);
  }
  const summaryLines = [
    ...(options.description ? [`DAG objective: ${truncateUtf8(options.description, 512)}`] : []),
    ...nodes.map((node) => {
      const summary = node.result?.summary ?? node.entry.error ?? "(no result)";
      return `${node.entry.nodeId}: [${node.entry.status}] ${
        node.result?.status ?? "unknown"
      } — ${truncateUtf8(summary.replace(/\s+/gu, " "), 300)}`;
    }),
  ];

  return boundWorkResult({
    status,
    summary: truncateUtf8(summaryLines.join("\n"), 4_000),
    files,
    evidence,
    tests: [...testByCommand.values()],
    unresolved: unresolved.slice(0, WORK_RESULT_DERIVED_ENTRIES_MAX),
    ...(confidences.length > 0 && confidences.length === nodes.length
      ? {
          confidence: confidences.reduce((sum, value) => sum + value, 0) / confidences.length,
        }
      : {}),
    claims: [...claims.values()],
    ...(sawMetrics
      ? {
          metrics: {
            durationMs: metrics.durationMs,
            toolUses: metrics.toolUses,
            tokens: metrics.tokens,
          },
        }
      : {}),
  });
}

/** Runs a validated DAG while leaving each child lifecycle in the shared RuntimeTaskRegistry. */

/**
 * Claims текущего attempt для WorkResult: только активные claim'ы ledger'а этого
 * агента, выданные текущей попытке.
 *
 * Причина: без фильтра released claim'ы прошлых resume накапливались в WorkResult,
 * и результат переставал проходить WorkResultSchema по количеству элементов.
 */
export function collectWorkResultClaims(
  registry: RuntimeTaskRegistry,
  task: RuntimeTaskSnapshot | undefined,
): WorkResultClaimEntry[] {
  const ledger = registry.workLedger;
  const workspacePath = task?.workspacePath?.trim();
  if (!ledger || !task || !workspacePath) return [];
  try {
    return ledger
      .list({ workspacePath, agentId: task.agentId, status: "active" })
      .filter(
        (claim) =>
          claim.attemptId === undefined ||
          // У задачи без attemptId (legacy snapshot) активный claim и есть текущий.
          task.attemptId === undefined ||
          claim.attemptId === task.attemptId,
      )
      .flatMap((claim) =>
        claim.paths.map((path) => ({
          path,
          ...(claim.runId ? { runId: claim.runId } : {}),
          ...(claim.attemptId ? { attemptId: claim.attemptId } : {}),
        })),
      );
  } catch {
    return [];
  }
}

