import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { CodeIndexService, type IndexProgressEvent } from "./indexService.js";
import { parseWorkerResponse, type WorkerRequest, type WorkerEvent } from "./workerProtocol.js";

/**
 * Клиент воркера на стороне Host.
 *
 * Держит одно соединение с воркером, сопоставляет ответы по `id` и рассылает события прогресса.
 * Event Loop Host'а не участвует ни в сканировании, ни в разборе AST, ни в записи SQLite.
 */

type WorkerRequestInput =
  | Omit<Extract<WorkerRequest, { type: "open" }>, "id">
  | Omit<Extract<WorkerRequest, { type: "status" }>, "id">
  | Omit<Extract<WorkerRequest, { type: "index" }>, "id">
  | Omit<Extract<WorkerRequest, { type: "mutate" }>, "id">
  | Omit<Extract<WorkerRequest, { type: "search" }>, "id">
  | Omit<Extract<WorkerRequest, { type: "symbolContext" }>, "id">
  | Omit<Extract<WorkerRequest, { type: "graphOverview" }>, "id">
  | Omit<Extract<WorkerRequest, { type: "impact" }>, "id">
  | Omit<Extract<WorkerRequest, { type: "trace" }>, "id">
  | Omit<Extract<WorkerRequest, { type: "embeddingConfig" }>, "id">
  | Omit<Extract<WorkerRequest, { type: "clear" }>, "id">
  | Omit<Extract<WorkerRequest, { type: "cancel" }>, "id">
  | Omit<Extract<WorkerRequest, { type: "shutdown" }>, "id">;

export interface IndexWorkerClientOptions {
  indexRootDir: string;
  onProgress?: (progress: WorkerEvent["progress"]) => void;
  onError?: (error: Error) => void;
  /** Тайм-аут одного запроса; индексация крупных проектов может занимать минуты. */
  requestTimeoutMs?: number;
  /** Подмена `fetch` для эмбеддингов: нужна тестам и бенчмарку. */
  embeddingFetch?: typeof fetch;
  /**
   * `true` — запросы обслуживаются в текущем потоке тем же `CodeIndexService`.
   * Нужно тестам и бенчмарку: без собранного `.js` воркера нельзя поднять тред,
   * но проверять поведение нужно ровно на продакшн-коде.
   */
  inProcess?: boolean;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Путь к скомпилированному `.js` воркера рядом с этим модулем.
 *
 * Причина отсутствия `.ts`-ветки: `worker_threads` не применяет трансформацию TS-импортов,
 * поэтому `indexWorker.ts` падал на `import "./indexService.js"`. Когда `.js` нет
 * (vitest, tsx, бенчмарк), клиент переключается на тот же `CodeIndexService` в текущем
 * потоке — поведение идентично, а сборка не требуется.
 */
function resolveWorkerEntry(): URL | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const filePath = join(here, "indexWorker.js");
  return existsSync(filePath) ? pathToFileURL(filePath) : null;
}

function isTsRuntimeError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

export class IndexWorkerClient {
  private worker: Worker | undefined;
  private inProcessService: CodeIndexService | undefined;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private disposed = false;
  private readonly indexRootDir: string;
  private readonly onProgress: ((progress: WorkerEvent["progress"]) => void) | undefined;
  private readonly onError: ((error: Error) => void) | undefined;
  private readonly requestTimeoutMs: number;
  private readonly inProcess: boolean;
  private readonly embeddingFetch: typeof fetch | undefined;

  constructor(options: IndexWorkerClientOptions) {
    this.indexRootDir = options.indexRootDir;
    this.onProgress = options.onProgress;
    this.onError = options.onError;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 300_000;
    this.inProcess = options.inProcess === true;
    this.embeddingFetch = options.embeddingFetch;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const entry = resolveWorkerEntry();
    if (!entry) throw new Error("The compiled code index worker entry point is unavailable.");
    // `workerData` передаёт каталог индекса: воркер не должен угадывать путь по cwd.
    const worker = new Worker(entry, {
      workerData: { indexRootDir: this.indexRootDir },
    });
    worker.on("message", (raw: unknown) => this.handleMessage(raw));
    worker.on("error", (error: Error) => {
      this.onError?.(error);
      this.rejectAll(error);
    });
    worker.on("exit", (code) => {
      if (code !== 0 && !this.disposed) {
        const error = new Error(`Code index worker exited with code ${code}.`);
        this.onError?.(error);
        this.rejectAll(error);
      }
      this.worker = undefined;
    });
    this.worker = worker;
    return worker;
  }

  private ensureInProcess(): CodeIndexService {
    this.inProcessService ??= new CodeIndexService({
      indexRootDir: this.indexRootDir,
      ...(this.embeddingFetch ? { embeddingFetch: this.embeddingFetch } : {}),
      onProgress: (progress) =>
        this.onProgress?.({
          state: progress.state,
          discoveredFiles: progress.discoveredFiles,
          indexedFiles: progress.indexedFiles,
          ...(progress.phase ? { phase: progress.phase } : {}),
        }),
    });
    return this.inProcessService;
  }

  private handleMessage(raw: unknown): void {
    const message = parseWorkerResponse(raw);
    if (!message) return;
    if (message.type === "event") {
      this.onProgress?.(message.progress);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) {
      pending.resolve(message.value);
      return;
    }
    pending.reject(new Error(message.error.message));
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private request<T>(input: WorkerRequestInput): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("The code index worker was disposed."));
    const id = this.nextId;
    this.nextId += 1;
    // Без собранного воркера используется тот же движок в текущем потоке: это не заглушка,
    // а единственный доступный транспорт в dev/тестах. Тяжёлая работа всё равно остаётся
    // в SQLite/AST-слое, а в продакшене путь через тред включается автоматически.
    if (this.inProcess || resolveWorkerEntry() === null) {
      const service = this.ensureInProcess();
      return service.handle({ ...input, id } as WorkerRequest).then((outcome) => {
        if (outcome.ok) return outcome.value as T;
        const error = new Error(outcome.error?.message ?? "Index request failed.");
        this.onError?.(error);
        throw error;
      });
    }
    const worker = this.ensureWorker();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The code index worker request timed out."));
      }, this.requestTimeoutMs);
      // Тайм-аут не должен удерживать процесс Host'а при простое.
      if (typeof timer.unref === "function") timer.unref();
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      worker.postMessage({ ...input, id });
    });
  }

  open(params: { workspacePath: string; workspaceIdentity?: string }): Promise<unknown> {
    return this.request({ type: "open", ...params });
  }

  status(params: { workspacePath: string; workspaceIdentity?: string }): Promise<unknown> {
    return this.request({ type: "status", ...params });
  }

  index(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    force?: boolean;
    embeddingApiKey?: string;
  }): Promise<unknown> {
    return this.request({ type: "index", ...params });
  }

  mutate(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    changed: string[];
    removed: string[];
    embeddingApiKey?: string;
  }): Promise<unknown> {
    return this.request({ type: "mutate", ...params });
  }

  search(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    query: string;
    limit?: number;
    maxTokens?: number;
    lexicalOnly?: boolean;
    activeFiles?: string[];
    changedFiles?: string[];
    embeddingApiKey?: string;
  }): Promise<unknown> {
    return this.request({ type: "search", ...params });
  }

  symbolContext(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    symbol: string;
  }): Promise<unknown> {
    return this.request({ type: "symbolContext", ...params });
  }

  graphOverview(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    focus?: { symbol?: string; path?: string; startLine?: number };
    limit?: number;
  }): Promise<unknown> {
    return this.request({ type: "graphOverview", ...params });
  }

  impact(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    changedPaths: string[];
  }): Promise<unknown> {
    return this.request({ type: "impact", ...params });
  }

  trace(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    fromSymbol: string;
    toSymbol: string;
  }): Promise<unknown> {
    return this.request({ type: "trace", ...params });
  }

  embeddingConfig(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: "ollama" | "openai-compatible" | null;
    endpoint?: string | null;
    model?: string | null;
    apiKeyConfigured?: boolean;
    clearVectors?: boolean;
  }): Promise<unknown> {
    return this.request({ type: "embeddingConfig", ...params });
  }

  clear(params: { workspacePath: string; workspaceIdentity?: string }): Promise<unknown> {
    return this.request({ type: "clear", ...params });
  }

  cancel(): Promise<unknown> {
    return this.request({ type: "cancel" });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.inProcessService) {
      await this.inProcessService.handle({ type: "shutdown", id: 0 }).catch(() => undefined);
      this.inProcessService = undefined;
      return;
    }
    const worker = this.worker;
    this.worker = undefined;
    if (!worker) return;
    try {
      await Promise.race([
        this.request({ type: "shutdown" }).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    } catch {
      // Остановка воркера best-effort: процесс всё равно освободит ресурсы.
    }
    try {
      await worker.terminate();
    } catch {
      // Terminate уже завершённого воркера безопасен.
    }
    this.rejectAll(new Error("The code index worker was disposed."));
  }
}

/** Проверка доступности `.ts`-исполнения нужна только тестам; экспорт держит seam явным. */
export { isTsRuntimeError };
