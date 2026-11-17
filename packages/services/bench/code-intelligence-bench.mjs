#!/usr/bin/env node
/**
 * Воспроизводимый бенчмарк `code-intelligence` Инкремента 4.3.
 *
 * Измеряет на реальном репозитории и на фикстурах (Python/Go/Rust):
 *  - время первичной индексации, no-op повтор и single-file инкремент;
 *  - размер БД и счётчики файлов/чанков/символов/рёбер;
 *  - латентность поиска avg/p50/p95, `Recall@4/5/12`, `MRR@12`;
 *  - долю усечённых выборок и средний размер ответа;
 *  - валидность JSON при бюджетах 64…4000 токенов.
 *
 * Запуск: `node_modules/.bin/tsx packages/services/bench/code-intelligence-bench.mjs [--repo PATH]`
 */

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

const args = process.argv.slice(2);
const repoArgIndex = args.indexOf("--repo");
const targetRepo = repoArgIndex >= 0 ? resolve(args[repoArgIndex + 1]) : repoRoot;

const { createCodeIntelligenceService } = await import(
  resolve(here, "../src/code-intelligence/codeIntelligenceService.ts")
);
const { IndexWorkerClient } = await import(
  resolve(here, "../src/code-intelligence/worker/workerClient.ts")
);
const { SCHEMA_VERSION } = await import(
  resolve(here, "../src/code-intelligence/worker/storeSchema.ts")
);

/** Сервис в in-process режиме воркера: тот же код, без сборочного шага. */
function createBenchService(indexRootDir) {
  return createCodeIntelligenceService({
    indexRootDir,
    workerFactory: (root) => new IndexWorkerClient({ indexRootDir: root, inProcess: true }),
  });
}

const REPO_QUERIES = [
  { query: "createCodeIntelligenceService", expects: ["codeIntelligenceService.ts"] },
  { query: "workspaceWatcher", expects: ["workspaceWatcher.ts"] },
  { query: "hybridSearch", expects: ["hybridSearch.ts"] },
  { query: "computeFilePageRank", expects: ["graphRank.ts"] },
  { query: "tokenBudgetPacker", expects: ["tokenBudgetPacker.ts"] },
  { query: "searchFts bm25", expects: ["searchChannels.ts"] },
  { query: "local sketch quantize", expects: ["localSketch.ts"] },
  { query: "ast structural chunker scope header", expects: ["astChunker.ts"] },
  { query: "language registry extension mapping", expects: ["languageRegistry.ts"] },
  { query: "worker protocol zod schema", expects: ["workerProtocol.ts"] },
  { query: "index worker sqlite wal", expects: ["indexWorker.ts", "indexEngine.ts"] },
  { query: "code index tool handler", expects: ["code-index.ts"] },
];

const FIXTURE_QUERIES = [
  { query: "resolve_identity", expects: ["app/models.py", "main.go", "lib.rs"] },
  { query: "CodeIntelligenceService index_workspace", expects: ["app/service.py"] },
  { query: "IdentityResolver trait resolve", expects: ["lib.rs"] },
  { query: "WorkspaceIdentity Normalized", expects: ["main.go"] },
  { query: "CodeIndexError workspace path", expects: ["app/models.py"] },
];

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function rankOf(results, expectations) {
  for (let index = 0; index < results.length; index += 1) {
    const path = results[index].path;
    if (expectations.some((expected) => path === expected || path.endsWith(`/${expected}`))) {
      return index + 1;
    }
  }
  return 0;
}

async function measureSearch(service, workspacePath, queries, options = {}) {
  const latencies = [];
  let recall4 = 0;
  let recall5 = 0;
  let recall12 = 0;
  let mrr = 0;
  let partialCount = 0;
  let totalBytes = 0;
  let invalidJson = 0;

  for (const item of queries) {
    const started = process.hrtime.bigint();
    const outcome = await service.search({
      workspacePath,
      query: item.query,
      limit: options.limit ?? 12,
      maxTokens: options.maxTokens ?? 4000,
      ...(options.activeFiles ? { activeFiles: options.activeFiles } : {}),
    });
    latencies.push(Number(process.hrtime.bigint() - started) / 1e6);

    const rank = rankOf(outcome.results, item.expects);
    if (rank > 0 && rank <= 4) recall4 += 1;
    if (rank > 0 && rank <= 5) recall5 += 1;
    if (rank > 0 && rank <= 12) recall12 += 1;
    if (rank > 0) mrr += 1 / rank;
    if (outcome.partial) partialCount += 1;

    const serialized = JSON.stringify(outcome);
    totalBytes += Buffer.byteLength(serialized, "utf8");
    try {
      JSON.parse(serialized);
    } catch {
      invalidJson += 1;
    }
  }

  const count = Math.max(1, queries.length);
  return {
    samples: queries.length,
    avgLatencyMs: Number((latencies.reduce((sum, value) => sum + value, 0) / count).toFixed(3)),
    p50LatencyMs: Number(percentile(latencies, 50).toFixed(3)),
    p95LatencyMs: Number(percentile(latencies, 95).toFixed(3)),
    recall4: Number((recall4 / count).toFixed(4)),
    recall5: Number((recall5 / count).toFixed(4)),
    recall12: Number((recall12 / count).toFixed(4)),
    mrr12: Number((mrr / count).toFixed(4)),
    partialRate: Number((partialCount / count).toFixed(4)),
    avgResponseBytes: Math.round(totalBytes / count),
    invalidJsonResponses: invalidJson,
  };
}

/** Проверка бюджета: ответ обязан оставаться валидным JSON при любом лимите. */
async function measureBudget(service, workspacePath) {
  const rows = [];
  for (const maxTokens of [64, 128, 256, 512, 1024, 4000]) {
    const outcome = await service.search({
      workspacePath,
      query: "code index workspace identity",
      maxTokens,
    });
    const serialized = JSON.stringify(outcome);
    let valid = true;
    try {
      JSON.parse(serialized);
    } catch {
      valid = false;
    }
    rows.push({
      maxTokens,
      spans: outcome.results.length,
      usedTokens: outcome.budget?.usedTokens ?? 0,
      dropped: outcome.budget?.dropped ?? 0,
      collapsed: outcome.budget?.collapsed ?? 0,
      validJson: valid,
      bytes: Buffer.byteLength(serialized, "utf8"),
    });
  }
  return rows;
}

async function runRepoBenchmark(indexRootDir) {
  const service = createBenchService(indexRootDir);
  const started = process.hrtime.bigint();
  const status = await service.indexWorkspace({ workspacePath: targetRepo, force: true });
  const indexMs = Number(process.hrtime.bigint() - started) / 1e6;

  const search = await measureSearch(service, targetRepo, REPO_QUERIES);
  const budget = await measureBudget(service, targetRepo);

  // no-op: повторная индексация без изменений на диске.
  const noopStarted = process.hrtime.bigint();
  await service.indexWorkspace({ workspacePath: targetRepo });
  const noopMs = Number(process.hrtime.bigint() - noopStarted) / 1e6;

  await service.disposeAllAndWait();
  return {
    workspace: targetRepo,
    indexMs: Number(indexMs.toFixed(1)),
    noopIndexMs: Number(noopMs.toFixed(1)),
    databaseBytes: status.databaseBytes ?? 0,
    counts: status.counts,
    schemaVersion: status.schemaVersion,
    textFallbackFiles: status.textFallbackFiles ?? null,
    partial: status.partial,
    search,
    budget,
  };
}

async function runFixtureBenchmark(indexRootDir) {
  const fixtureRoot = join(here, "fixtures");
  const scratch = await mkdtemp(join(tmpdir(), "zcode-bench-fixture-"));
  const results = [];
  try {
    for (const fixture of ["mini-python", "mini-go", "mini-rust"]) {
      const source = join(fixtureRoot, fixture);
      const workspacePath = join(scratch, fixture);
      await cp(source, workspacePath, { recursive: true });
      const service = createBenchService(join(indexRootDir, fixture));
      const started = process.hrtime.bigint();
      const status = await service.indexWorkspace({ workspacePath, force: true });
      const indexMs = Number(process.hrtime.bigint() - started) / 1e6;
      const search = await measureSearch(service, workspacePath, FIXTURE_QUERIES);

      // single-file инкремент: меняем один файл и просим точечное обновление.
      const probe = join(workspacePath, "app", "models.py");
      const probePath =
        fixture === "mini-go"
          ? join(workspacePath, "main.go")
          : fixture === "mini-rust"
            ? join(workspacePath, "lib.rs")
            : probe;
      const original = await readFile(probePath, "utf8");
      await writeFile(probePath, `${original}\n# bench touch ${Date.now()}\n`, "utf8");
      const mutateStarted = process.hrtime.bigint();
      await service.notifyFilesMutated({
        workspacePath,
        changed: [probePath.slice(workspacePath.length + 1)],
      });
      const singleFileMutateMs = Number(process.hrtime.bigint() - mutateStarted) / 1e6;
      await writeFile(probePath, original, "utf8");
      const revertStarted = process.hrtime.bigint();
      await service.notifyFilesMutated({
        workspacePath,
        changed: [probePath.slice(workspacePath.length + 1)],
      });
      const revertMs = Number(process.hrtime.bigint() - revertStarted) / 1e6;

      // Удаление файла должно уменьшать счётчики, а не оставлять «фантомы» в FTS.
      const removedPath = join(workspacePath, "app", "models.py");
      let deleteVerified = null;
      if (fixture === "mini-python") {
        const before = status.counts.files;
        await rm(removedPath, { force: true });
        const afterDelete = await service.notifyFilesMutated({
          workspacePath,
          removed: ["app/models.py"],
        });
        deleteVerified = { before, after: afterDelete.counts.files };
      }

      await service.disposeAllAndWait();
      results.push({
        fixture,
        indexMs: Number(indexMs.toFixed(1)),
        singleFileMutateMs: Number(singleFileMutateMs.toFixed(1)),
        revertMutateMs: Number(revertMs.toFixed(1)),
        counts: status.counts,
        search,
        deleteVerified,
      });
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return results;
}

async function main() {
  const indexRootDir = await mkdtemp(join(tmpdir(), "zcode-bench-index-"));
  try {
    const repo = await runRepoBenchmark(indexRootDir);
    const fixtures = await runFixtureBenchmark(indexRootDir);
    process.stdout.write(
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          node: process.version,
          schemaVersion: SCHEMA_VERSION,
          repo,
          fixtures,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await rm(indexRootDir, { recursive: true, force: true });
  }
}

await main();
