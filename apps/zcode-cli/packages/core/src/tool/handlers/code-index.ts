import type { JsonSchema, ModelMessageContent } from "@zcode/contracts";
import { zcodeCodeIndexQueryResultSchema } from "@zcode/shared";
import { z } from "zod";
import type { ToolEntry, ToolHandler, ToolHandlerFailure } from "../types.js";

const relativePath = z.string().min(1).max(1024).refine(
  (value) => !value.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(value) && !value.split(/[\\/]+/u).includes(".."),
  "Paths must be workspace-relative.",
);
const symbolRef = z.string().trim().min(1).max(256);
const CodeIndexInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("search"), query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(12).optional() }).strict(),
  z.object({ action: z.literal("context"), symbol: symbolRef }).strict(),
  z.object({ action: z.literal("impact"), changedPaths: z.array(relativePath).min(1).max(20) }).strict(),
  z.object({ action: z.literal("trace"), fromSymbol: symbolRef, toSymbol: symbolRef }).strict(),
]);

// Provider and runtime contracts share one source. Runtime-only path refinements remain in Zod;
// JSON Schema communicates all representable constraints to the model.
const CodeIndexInputJsonSchema = z.toJSONSchema(CodeIndexInputSchema) as JsonSchema;

function unavailable(): ToolHandlerFailure {
  return {
    result: false,
    errorCode: 41,
    message: "code_index_unavailable: this Host does not provide the local workspace code index. Continue with regular file search tools.",
  };
}

const codeIndexHandler: ToolHandler = async (input, context) => {
  const query = CodeIndexInputSchema.parse(input);
  const port = context.codeIntelligencePort;
  if (!port) return unavailable();
  return port.query(query, { signal: context.abortSignal, trace: context.traceContext });
};

function formatCodeIndexResult(output: unknown): ModelMessageContent {
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return "CodeIndex returned an unreadable result.";
  }
}

export const codeIndexToolEntry: ToolEntry = {
  capability: "Search the local code graph and inspect symbol dependencies, impact, and paths",
  metadata: {
    name: "CodeIndex",
    description: [
      "Queries the local workspace code index for fast symbol and dependency navigation.",
      "Actions: status, search, context, impact, trace.",
      "For a code task, call status, then a targeted search, and use context/impact/trace for relationships. Answer from the excerpt and path:startLine-endLine when the fact is already in the excerpt. Read only to edit, open a test, or when the excerpt is truncated, endLine is missing, or the needed text is absent. Issue those Reads in one parallel batch with offset = startLine and a limit covering the range — not the whole file and not every caller.",
      "Paths for impact must be workspace-relative. This tool never reads or writes outside the current workspace and never changes files.",
      "If the index is unavailable, empty, or stale, report that and use ordinary file search. A partial index does not prove the code is absent.",
    ].join("\n"),
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 120_000,
    maxOutputBytes: 24_000,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
    // Resident-инструмент: схема мала (пять действий), а индекс — основной способ
    // не читать файлы целиком. Пока CodeIndex был deferred, модель его не видела и
    // деградировала до Grep (5 412 вызовов Grep против 241 CodeIndex за прогон).
    alwaysLoad: true,
    shouldDefer: false,
  },
  handler: codeIndexHandler,
  inputSchema: CodeIndexInputJsonSchema,
  runtimeInputSchema: CodeIndexInputSchema,
  outputSchema: z.toJSONSchema(zcodeCodeIndexQueryResultSchema),
  runtimeOutputSchema: zcodeCodeIndexQueryResultSchema,
  formatModelContent: formatCodeIndexResult,
  permission: {
    permission: "read",
    reason: "CodeIndex queries the local workspace's bounded symbol and dependency index.",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: [],
    alwaysAllowPatternSources: [],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 24_000,
    maxModelBytes: 24_000,
    strategy: "truncate",
  },
  timeout: {
    kind: "timed",
    defaultMs: 120_000,
    maxMs: 120_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "CodeIndex request was cancelled; no workspace state was changed.",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
