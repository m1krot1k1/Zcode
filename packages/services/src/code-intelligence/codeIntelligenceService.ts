import { isAbsolute, join, resolve } from "node:path";
import { getZCodeDataRootDir } from "../paths.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type {
  CodeGraphOverview,
  CodeIndexStatus,
  CodeIntelligenceService,
  CodeWorkspaceRef,
  EmbeddingTestResult,
} from "./contract.js";
import { createWorkspaceWatcherRegistry } from "./workspaceWatcher.js";
import { IndexWorkerClient } from "./worker/workerClient.js";
import { workspaceIdentityOf, workspaceKeyOf } from "./worker/workspaceIdentity.js";
import {
  searchFromWorker,
  statusFromWorker,
  type WorkerSearchPayload,
  type WorkerStatusPayload,
} from "./serviceMapping.js";
import { probeEmbeddingProvider } from "./embeddingProbe.js";
import {
  embeddingCredentialKey,
  readEmbeddingSettings,
  writeEmbeddingSettings,
  type EmbeddingCredentialStore,
} from "./embeddingSettings.js";
import { validateEmbeddingConfig } from "./embeddings.js";
import {
  createLocalEmbeddingRuntime,
  type LocalEmbeddingRuntime,
} from "./localEmbeddingRuntime.js";

/**
 * `CodeIntelligenceService` v2 — оркестратор на стороне Host.
 *
 * Разделение ответственности:
 *  - **Host (этот файл)**: RPC-контракт, watcher, дебаунс, автоиндексация, настройки
 *    эмбеддингов и креденшелы. Здесь нет ни SQLite, ни AST — Event Loop не блокируется.
 *  - **Worker (`worker/indexWorker.ts`)**: SQLite в WAL, AST-разбор, запись батчами,
 *    гибридный поиск и паковщик бюджета.
 *
 * Инвариант идентичности: ключ всегда `workspaceIdentity?.trim() || workspacePath`.
 */

type WorkspaceParams = { workspacePath: string; workspaceIdentity?: string };
type ManagedCodeIntelligenceService = CodeIntelligenceService & {
  disposeAll(): void;
  disposeAllAndWait(): Promise<void>;
};

const WATCHER_DIAGNOSTIC =
  "Workspace file watching is unavailable; refresh the local code index manually.";
const MIGRATION_DIAGNOSTIC = "The local code index was rebuilt from schema v1 to v2.";

interface CodeIntelligenceServiceOptions {
  indexRootDir?: string;
  fetch?: typeof fetch;
  credentialService?: EmbeddingCredentialStore;
  /** Тестовый seam: воркер может быть подменён на прямой движок. */
  workerFactory?: (indexRootDir: string) => IndexWorkerClient;
  /** Тестовый seam, вызывается после открытия воркера и до чтения прогресса. */
  beforeReadStatusProgress?: () => Promise<void>;
  /** Тестовый seam для локального embedding runtime. */
  localEmbeddingRuntime?: LocalEmbeddingRuntime;
}

interface WorkspaceProgress {
  discoveredFiles: number;
  indexedFiles: number;
  state: "indexing" | "idle";
}

export function createCodeIntelligenceService(
  options: CodeIntelligenceServiceOptions = {},
): ManagedCodeIntelligenceService {
  const logger = createServiceLogger("code-intelligence");
  const indexRootDir = options.indexRootDir ?? join(getZCodeDataRootDir(), "code-intelligence");
  const fetchImpl = options.fetch ?? fetch;
  const credentialService = options.credentialService;
  const localEmbedding =
    options.localEmbeddingRuntime ?? createLocalEmbeddingRuntime({ fetch: fetchImpl });
  const progressByIdentity = new Map<string, WorkspaceProgress>();
  // Пока идёт полный проход, worker занят и не отвечает на status. Держим последний
  // успешный payload, чтобы status/getStatus не вставал в очередь за индексацией:
  // иначе Host RPC (включая CodeIndex hint перед main_turn) ждёт десятки секунд.
  const lastStatusByIdentity = new Map<string, WorkerStatusPayload>();
  const diagnosticsByIdentity = new Map<string, string[]>();
  const activePasses = new Map<string, Promise<CodeIndexStatus>>();
  const activatedRoots = new Map<string, string>();
  const activationPromises = new Map<string, { root: string; promise: Promise<void> }>();
  const pendingBatches = new Map<string, { changed: Set<string>; removed: Set<string> }>();
  const clearing = new Set<string>();
  // Воркер один на сервис, поэтому прогресс маркируется текущим активным identity.
  let currentProgressIdentity: string | undefined;

  const client =
    options.workerFactory?.(indexRootDir) ??
    new IndexWorkerClient({
      indexRootDir,
      embeddingFetch: fetchImpl,
      onProgress: (progress) => {
        const identity = currentProgressIdentity;
        if (!identity) return;
        if (progress.state === "indexing") {
          progressByIdentity.set(identity, {
            discoveredFiles: progress.discoveredFiles,
            indexedFiles: progress.indexedFiles,
            state: "indexing",
          });
          return;
        }
        progressByIdentity.delete(identity);
      },
    });

  const resolveWorkspace = (params: WorkspaceParams) => {
    if (!params.workspacePath.trim() || !isAbsolute(params.workspacePath))
      throw new Error("Workspace path must be absolute.");
    const identity = workspaceIdentityOf(params);
    const key = workspaceKeyOf(params);
    const root = resolve(params.workspacePath);
    return { identity, key, root };
  };

  const refOf = (params: WorkspaceParams): CodeWorkspaceRef => ({
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
  });

  const pushDiagnostic = (key: string, diagnostic: string): void => {
    const list = diagnosticsByIdentity.get(key) ?? [];
    if (list.includes(diagnostic)) return;
    diagnosticsByIdentity.set(key, [...list, diagnostic]);
  };

  const clearDiagnostic = (key: string, diagnostic: string): void => {
    const list = diagnosticsByIdentity.get(key) ?? [];
    const remaining = list.filter((item) => item !== diagnostic);
    if (remaining.length > 0) diagnosticsByIdentity.set(key, remaining);
    else diagnosticsByIdentity.delete(key);
  };

  /**
   * Собирает статус провайдера. `workerStatus` передаётся вызывающим, чтобы один вызов
   * `statusOf` не порождал два обращения к воркеру за одним и тем же состоянием.
   */
  const embeddingStatus = async (
    key: string,
    workerStatus: WorkerStatusPayload | undefined,
  ): Promise<CodeIndexStatus["embedding"]> => {
    const settings = await readEmbeddingSettings(credentialService, key, indexRootDir);
    const configured = Boolean(settings.endpoint && settings.model);
    // Фаза из воркера авторитетнее статической: она отражает фактический исход последнего
    // прохода (включая сбой провайдера), а не только наличие настроек.
    const workerPhase = workerStatus?.embeddingPhase;
    const phase: CodeIndexStatus["embedding"]["phase"] = !configured
      ? "not-configured"
      : workerPhase === "failed"
        ? "failed"
        : workerPhase === "ready"
          ? "ready"
          : "pending";
    const errorCodeRaw = workerStatus?.embeddingErrorCode;
    const errorStatus = workerStatus?.embeddingErrorStatus
      ? Number(workerStatus.embeddingErrorStatus)
      : undefined;
    return {
      configured,
      ...(settings.provider ? { provider: settings.provider } : {}),
      ...(settings.endpoint ? { endpoint: settings.endpoint } : {}),
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.apiKeyConfigured !== undefined
        ? { apiKeyConfigured: settings.apiKeyConfigured }
        : {}),
      // `available` означает «векторный канал сейчас даёт результаты»: без провайдера это
      // локальный скетч (всегда), с провайдером — только после успешного прохода.
      available: !configured || phase === "ready",
      phase,
      ...(phase === "failed" && errorCodeRaw
        ? {
            lastError: {
              code: errorCodeRaw as NonNullable<CodeIndexStatus["embedding"]["lastError"]>["code"],
              ...(errorStatus !== undefined && Number.isFinite(errorStatus)
                ? { httpStatus: errorStatus }
                : {}),
            },
          }
        : {}),
    };
  };

  /**
   * Секрет провайдера читается из `ICredentialService` только для конкретного запроса и
   * передаётся воркеру в памяти. Передавать его в `status`/`graph` незачем: сеть там не нужна.
   */
  const embeddingKeyOf = async (key: string): Promise<string | undefined> => {
    if (!credentialService) return undefined;
    const stored = await credentialService.load(embeddingCredentialKey(key)).catch(() => null);
    return stored && stored.length > 0 ? stored : undefined;
  };

  const statusOf = async (params: WorkspaceParams): Promise<CodeIndexStatus> => {
    const workspace = resolveWorkspace(params);
    const progress = progressByIdentity.get(workspace.key);
    // Bug 原因: status уходил в worker и ждал весь активный index-pass; на большом
    // workspace это 14+ секунд, и main_turn/UI RPC стояли в очереди. Пока проход
    // идёт, отдаём последний известный payload и progress фоном, не ожидая worker.
    if (progress?.state === "indexing") {
      const cached = lastStatusByIdentity.get(workspace.key);
      const embedding = await embeddingStatus(workspace.key, cached);
      return statusFromWorker(
        cached ?? { state: "indexing", counts: {} },
        embedding,
        diagnosticsByIdentity.get(workspace.key) ?? [],
        { discoveredFiles: progress.discoveredFiles, indexedFiles: progress.indexedFiles },
      );
    }
    // Оба источника читаются ПОСЛЕ хука: если проход завершился, пока ответ готовился,
    // статус обязан показать актуальное `ready`, а не устаревшее `indexing`/`unindexed`.
    await options.beforeReadStatusProgress?.();
    const payload = (await client.status(refOf(params)).catch(() => undefined)) as
      | WorkerStatusPayload
      | undefined;
    if (payload) lastStatusByIdentity.set(workspace.key, payload);
    const embedding = await embeddingStatus(workspace.key, payload);
    return statusFromWorker(
      payload ?? { state: "unindexed", counts: {} },
      embedding,
      diagnosticsByIdentity.get(workspace.key) ?? [],
    );
  };

  const runPass = async (
    params: WorkspaceParams,
    mode: "full" | "partial",
    batch?: { changed: string[]; removed: string[] },
  ): Promise<CodeIndexStatus> => {
    const workspace = resolveWorkspace(params);
    const existing = activePasses.get(workspace.key);
    if (existing) return existing;
    const pass = (async () => {
      currentProgressIdentity = workspace.key;
      progressByIdentity.set(workspace.key, {
        discoveredFiles: 0,
        indexedFiles: 0,
        state: "indexing",
      });
      try {
        const embeddingApiKey = await embeddingKeyOf(workspace.key);
        const payload = (await (mode === "full"
          ? client.index({
              ...refOf(params),
              ...(embeddingApiKey ? { embeddingApiKey } : {}),
            })
          : client.mutate({
              ...refOf(params),
              changed: batch?.changed ?? [],
              removed: batch?.removed ?? [],
              ...(embeddingApiKey ? { embeddingApiKey } : {}),
            }))) as WorkerStatusPayload;
        if (payload.migratedFromV1) pushDiagnostic(workspace.key, MIGRATION_DIAGNOSTIC);
        lastStatusByIdentity.set(workspace.key, payload);
        const embedding = await embeddingStatus(workspace.key, payload);
        return statusFromWorker(payload, embedding, diagnosticsByIdentity.get(workspace.key) ?? []);
      } catch (error) {
        logger.warn(undefined, "code index pass failed", {
          mode,
          reason: error instanceof Error ? error.message : String(error),
        });
        pushDiagnostic(workspace.key, "Indexing failed; the last committed generation remains.");
        const embedding = await embeddingStatus(workspace.key, undefined);
        return statusFromWorker(
          { state: "degraded", counts: {} },
          embedding,
          diagnosticsByIdentity.get(workspace.key) ?? [],
        );
      } finally {
        progressByIdentity.delete(workspace.key);
        if (currentProgressIdentity === workspace.key) currentProgressIdentity = undefined;
      }
    })();
    activePasses.set(workspace.key, pass);
    void pass.finally(() => {
      activePasses.delete(workspace.key);
      flushPendingBatch(workspace.key, params);
    });
    return pass;
  };

  const flushPendingBatch = (key: string, params: WorkspaceParams): void => {
    const pending = pendingBatches.get(key);
    if (!pending || clearing.has(key) || activePasses.has(key)) return;
    pendingBatches.delete(key);
    const changed = [...pending.changed];
    const removed = [...pending.removed];
    if (changed.length === 0 && removed.length === 0) return;
    void runPass(params, "partial", { changed, removed }).catch(() => undefined);
  };

  const queueBatch = (
    key: string,
    params: WorkspaceParams,
    batch: {
      changed: readonly string[];
      removed: readonly string[];
    },
  ): void => {
    const pending = pendingBatches.get(key) ?? { changed: new Set(), removed: new Set() };
    for (const path of batch.changed) {
      if (pending.removed.delete(path)) continue;
      pending.changed.add(path);
    }
    for (const path of batch.removed) {
      pending.changed.delete(path);
      pending.removed.add(path);
    }
    pendingBatches.set(key, pending);
    flushPendingBatch(key, params);
  };

  const watcherRegistry = createWorkspaceWatcherRegistry({
    onChange(workspace, batch) {
      const resolved = resolveWorkspace(workspace);
      if (clearing.has(resolved.key)) return;
      if (batch.overflow) {
        // Переполнение (переименование каталога, массовый git checkout): полный проход
        // корректен и дешевле, чем попытка угадать набор путей.
        void runPass(workspace, "full").catch(() => undefined);
        return;
      }
      queueBatch(resolved.key, workspace, { changed: batch.changed, removed: batch.removed });
    },
    onError(workspace, error) {
      const resolved = resolveWorkspace(workspace);
      pushDiagnostic(resolved.key, WATCHER_DIAGNOSTIC);
      logger.warn(undefined, "code index watcher failed", { reason: error.message });
    },
    onReady(workspace) {
      const resolved = resolveWorkspace(workspace);
      clearDiagnostic(resolved.key, WATCHER_DIAGNOSTIC);
    },
  });

  const armWatcher = async (params: WorkspaceParams): Promise<void> => {
    const workspace = resolveWorkspace(params);
    if (clearing.has(workspace.key)) throw new Error("The workspace code index is being cleared.");
    await watcherRegistry.ensure(refOf(params));
  };

  const watchWorkspace = async (
    params: WorkspaceParams & { autoIndexOnOpen?: boolean },
  ): Promise<void> => {
    const workspace = resolveWorkspace(params);
    if (clearing.has(workspace.key)) throw new Error("The workspace code index is being cleared.");
    const existing = activationPromises.get(workspace.key);
    if (existing) {
      if (existing.root === workspace.root) return existing.promise;
      await existing.promise.catch(() => undefined);
      return watchWorkspace(params);
    }
    if (activatedRoots.get(workspace.key) === workspace.root) {
      await armWatcher(params);
      return;
    }
    const activation = (async () => {
      await armWatcher(params);
      if (clearing.has(workspace.key)) return;
      const status = await statusOf(params);
      const autoIndex = params.autoIndexOnOpen ?? true;
      // Устраняемый дефект F-05: v1 никогда не строила первичный индекс автоматически,
      // поэтому «пустой» проект оставался пустым навсегда. Здесь индекс строится в фоне.
      if (status.generation > 0 || (autoIndex && status.counts.files === 0)) {
        void runPass(params, "full").catch(() => undefined);
      }
      if (!clearing.has(workspace.key)) activatedRoots.set(workspace.key, workspace.root);
    })();
    activationPromises.set(workspace.key, { root: workspace.root, promise: activation });
    try {
      await activation;
    } finally {
      if (activationPromises.get(workspace.key)?.promise === activation)
        activationPromises.delete(workspace.key);
    }
  };

  const service: ManagedCodeIntelligenceService = {
    getStatus: statusOf,

    watchWorkspace,

    async indexWorkspace(params) {
      const workspace = resolveWorkspace(params);
      if (clearing.has(workspace.key))
        throw new Error("The workspace code index is being cleared.");
      await armWatcher(params);
      // Проход идёт через тот же `runPass`, что и фоновые обновления: только так статус
      // видит прогресс (`indexing`) и мутации не обгоняют полный проход.
      return runPass(params, "full");
    },

    async notifyFilesMutated(params) {
      const workspace = resolveWorkspace(params);
      if (clearing.has(workspace.key))
        throw new Error("The workspace code index is being cleared.");
      const changed = params.changed ?? [];
      const removed = params.removed ?? [];
      if (changed.length === 0 && removed.length === 0) return statusOf(params);
      // Единственный путь записи — очередь проходов. Прямой вызов воркера из этого метода
      // раньше шёл параллельно с watcher-проходом и падал на вложенной транзакции
      // («cannot start a transaction within a transaction»), потому что SQLite-соединение
      // одно. Здесь сигнал только ставится в очередь и дожидается своего прохода.
      queueBatch(workspace.key, params, { changed, removed });
      // Дожидаемся именно своего прохода: он ставится синхронно внутри queueBatch,
      // поэтому activePasses уже содержит промис этой мутации.
      await activePasses.get(workspace.key)?.catch(() => undefined);
      return statusOf(params);
    },

    async search(params) {
      const query = params.query.trim();
      if (!query) return { results: [], semantic: false, partial: false };
      const workspace = resolveWorkspace(params);
      const embeddingApiKey = await embeddingKeyOf(workspace.key);
      const payload = (await client
        .search({
          ...refOf(params),
          query,
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
          ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
          ...(params.lexicalOnly !== undefined ? { lexicalOnly: params.lexicalOnly } : {}),
          ...(params.activeFiles ? { activeFiles: [...params.activeFiles] } : {}),
          ...(params.changedFiles ? { changedFiles: [...params.changedFiles] } : {}),
          ...(embeddingApiKey ? { embeddingApiKey } : {}),
        })
        .catch((error: unknown) => {
          logger.warn(undefined, "code index search failed", {
            reason: error instanceof Error ? error.message : String(error),
          });
          return { spans: [] } satisfies WorkerSearchPayload;
        })) as WorkerSearchPayload;
      const status = await client.status(refOf(params)).catch(() => undefined);
      void workspace;
      const mapped = searchFromWorker(
        payload,
        (status as WorkerStatusPayload | undefined)?.state === "degraded",
      );
      return {
        results: mapped.results,
        semantic: mapped.semantic,
        partial: mapped.partial,
        budget: {
          usedTokens: mapped.metrics.usedTokens,
          budgetTokens: mapped.metrics.budgetTokens,
          dropped: mapped.metrics.dropped,
          collapsed: mapped.metrics.collapsed,
          candidateCount: mapped.metrics.candidateCount,
          truncated: mapped.metrics.truncated,
        },
      };
    },

    async getSymbolContext(params) {
      const payload = await client
        .symbolContext({ ...refOf(params), symbol: params.symbol })
        .catch(() => null);
      return payload as Awaited<ReturnType<CodeIntelligenceService["getSymbolContext"]>>;
    },

    async getGraphOverview(params): Promise<CodeGraphOverview> {
      const payload = await client
        .graphOverview({
          ...refOf(params),
          ...(params.focus ? { focus: params.focus } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        })
        .catch(() => ({ nodes: [], edges: [], partial: true }));
      return payload as CodeGraphOverview;
    },

    async getImpact(params) {
      const payload = await client
        .impact({ ...refOf(params), changedPaths: [...params.changedPaths] })
        .catch(() => ({ changedPaths: params.changedPaths, affectedSymbols: [], partial: true }));
      return payload as Awaited<ReturnType<CodeIntelligenceService["getImpact"]>>;
    },

    async trace(params) {
      const payload = await client
        .trace({ ...refOf(params), fromSymbol: params.fromSymbol, toSymbol: params.toSymbol })
        .catch(() => ({ found: false, path: [], partial: true }));
      return payload as Awaited<ReturnType<CodeIntelligenceService["trace"]>>;
    },

    localEmbeddings: {
      getStatus: () => localEmbedding.getStatus(),
      install: () => localEmbedding.install(),
      start: () => localEmbedding.start(),
      pull: (model) => localEmbedding.pull(model),
    },
    async localRuntime(request) {
      if (request.action === "status")
        return { action: "status", status: await localEmbedding.getStatus() };
      if (request.action === "install")
        return { action: "install", result: await localEmbedding.install() };
      if (request.action === "start")
        return { action: "start", running: await localEmbedding.start() };
      return { action: "pull", result: await localEmbedding.pull(request.model) };
    },

    async testEmbeddingConfig(params): Promise<EmbeddingTestResult> {
      const workspace = resolveWorkspace(params);
      return probeEmbeddingProvider(
        params,
        embeddingCredentialKey(workspace.key),
        credentialService,
        fetchImpl,
      );
    },

    async setEmbeddingConfig(params) {
      const workspace = resolveWorkspace(params);
      // Валидация до записи: контракт обещает отказ на недопустимый endpoint/model.
      const cleared = params.provider === null || params.endpoint === null || params.model === null;
      if (!cleared && params.endpoint && params.model) {
        validateEmbeddingConfig(params.provider, params.endpoint, params.model);
      }
      await writeEmbeddingSettings(credentialService, workspace.key, params, indexRootDir);
      await client
        .embeddingConfig({
          ...refOf(params),
          ...(params.provider !== undefined ? { provider: params.provider } : {}),
          ...(params.endpoint !== undefined ? { endpoint: params.endpoint } : {}),
          ...(params.model !== undefined ? { model: params.model } : {}),
          ...(params.apiKey !== undefined ? { apiKeyConfigured: params.apiKey !== null } : {}),
          clearVectors: cleared,
        })
        .catch(() => undefined);
      return statusOf(params);
    },

    async clearIndex(params) {
      const workspace = resolveWorkspace(params);
      clearing.add(workspace.key);
      try {
        await watcherRegistry.stop(refOf(params));
        const active = activePasses.get(workspace.key);
        if (active) await active.catch(() => undefined);
        pendingBatches.delete(workspace.key);
        const activation = activationPromises.get(workspace.key);
        if (activation) await activation.promise.catch(() => undefined);
        activatedRoots.delete(workspace.key);
        await credentialService?.delete(embeddingCredentialKey(workspace.key));
        await client.clear(refOf(params));
        diagnosticsByIdentity.delete(workspace.key);
        progressByIdentity.delete(workspace.key);
        lastStatusByIdentity.delete(workspace.key);
      } finally {
        clearing.delete(workspace.key);
      }
    },

    disposeAll() {
      localEmbedding.dispose();
      watcherRegistry.disposeAll();
      void client.dispose().catch(() => undefined);
    },

    async disposeAllAndWait() {
      localEmbedding.dispose();
      await watcherRegistry.disposeAllAndWait();
      await client.dispose().catch(() => undefined);
    },
  };

  return service;
}
