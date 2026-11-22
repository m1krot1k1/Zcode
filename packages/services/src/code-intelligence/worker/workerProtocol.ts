import { z } from "zod";

/**
 * Строго типизированный протокол `node:worker_threads` для индексатора.
 *
 * Каждое сообщение валидируется Zod-схемой на обеих сторонах: повреждённое сообщение не
 * должно приводить к молчаливой записи мусора в SQLite. Хост блокируется на 0 мс — вся работа
 * (скан, AST-разбор, запись батчами, поиск) выполняется в воркере.
 *
 * `embeddingApiKey` передаётся только когда провайдер сконфигурирован: ключ живёт в памяти
 * воркера на время запроса и никогда не записывается в SQLite (это проверяется тестом).
 */

const workspaceRefShape = {
  workspacePath: z.string().min(1).max(4096),
  workspaceIdentity: z.string().max(4096).optional(),
};

const embeddingKeyShape = { embeddingApiKey: z.string().max(4096).optional() };

export const WorkerRequestSchema = z.discriminatedUnion("type", [
  z.object({ id: z.number().int(), type: z.literal("open"), ...workspaceRefShape }).strict(),
  z.object({ id: z.number().int(), type: z.literal("status"), ...workspaceRefShape }).strict(),
  z
    .object({
      id: z.number().int(),
      type: z.literal("index"),
      ...workspaceRefShape,
      ...embeddingKeyShape,
      force: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      id: z.number().int(),
      type: z.literal("mutate"),
      ...workspaceRefShape,
      ...embeddingKeyShape,
      changed: z.array(z.string().min(1).max(4096)).max(20_000),
      removed: z.array(z.string().min(1).max(4096)).max(20_000),
    })
    .strict(),
  z
    .object({
      id: z.number().int(),
      type: z.literal("search"),
      ...workspaceRefShape,
      ...embeddingKeyShape,
      query: z.string().min(1).max(2000),
      limit: z.number().int().min(1).max(50).optional(),
      maxTokens: z.number().int().min(64).max(200_000).optional(),
      lexicalOnly: z.boolean().optional(),
      activeFiles: z.array(z.string().max(4096)).max(64).optional(),
      changedFiles: z.array(z.string().max(4096)).max(64).optional(),
    })
    .strict(),
  z
    .object({
      id: z.number().int(),
      type: z.literal("symbolContext"),
      ...workspaceRefShape,
      symbol: z.string().min(1).max(1024),
    })
    .strict(),
  z
    .object({
      id: z.number().int(),
      type: z.literal("graphOverview"),
      ...workspaceRefShape,
      focus: z
        .object({
          symbol: z.string().max(1024).optional(),
          path: z.string().max(4096).optional(),
          startLine: z.number().int().positive().optional(),
        })
        .strict()
        .optional(),
      limit: z.number().int().min(10).max(200).optional(),
    })
    .strict(),
  z
    .object({
      id: z.number().int(),
      type: z.literal("impact"),
      ...workspaceRefShape,
      changedPaths: z.array(z.string().min(1).max(4096)).min(1).max(200),
    })
    .strict(),
  z
    .object({
      id: z.number().int(),
      type: z.literal("trace"),
      ...workspaceRefShape,
      fromSymbol: z.string().min(1).max(1024),
      toSymbol: z.string().min(1).max(1024),
    })
    .strict(),
  z
    .object({
      id: z.number().int(),
      type: z.literal("embeddingConfig"),
      ...workspaceRefShape,
      provider: z.enum(["ollama", "openai-compatible"]).nullable().optional(),
      endpoint: z.string().max(2048).nullable().optional(),
      model: z.string().max(240).nullable().optional(),
      apiKeyConfigured: z.boolean().optional(),
      clearVectors: z.boolean().optional(),
    })
    .strict(),
  z.object({ id: z.number().int(), type: z.literal("clear"), ...workspaceRefShape }).strict(),
  z.object({ id: z.number().int(), type: z.literal("cancel") }).strict(),
  z.object({ id: z.number().int(), type: z.literal("shutdown") }).strict(),
]);

export type WorkerRequest = z.infer<typeof WorkerRequestSchema>;

const progressSchema = z
  .object({
    state: z.enum(["idle", "indexing", "ready", "error"]),
    discoveredFiles: z.number().int().nonnegative(),
    indexedFiles: z.number().int().nonnegative(),
    phase: z.enum(["scan", "parse", "write", "done"]).optional(),
  })
  .strict();

export const WorkerEventSchema = z
  .object({
    type: z.literal("event"),
    event: z.enum(["progress", "state"]),
    progress: progressSchema,
  })
  .strict();

export type WorkerEvent = z.infer<typeof WorkerEventSchema>;

export const WorkerResponseSchema = z.union([
  z
    .object({
      type: z.literal("result"),
      id: z.number().int(),
      ok: z.literal(true),
      value: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal("result"),
      id: z.number().int(),
      ok: z.literal(false),
      error: z
        .object({ message: z.string().max(2000), code: z.string().max(120).optional() })
        .strict(),
    })
    .strict(),
  WorkerEventSchema,
]);

export type WorkerResponse = z.infer<typeof WorkerResponseSchema>;

export function parseWorkerRequest(value: unknown): WorkerRequest | null {
  const parsed = WorkerRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseWorkerResponse(value: unknown): WorkerResponse | null {
  const parsed = WorkerResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
