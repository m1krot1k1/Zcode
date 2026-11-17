/**
 * F-05: код-индекс в реальном рантайме.
 *
 * Проверяется настоящий `CodeIntelligenceService` (реальный SQLite, реальный
 * обход ФС, реальный AST-чанкер) и настоящий tool-путь `CodeIndex` в ходе
 * агента: инструмент виден модели, поиск возвращает релевантный фрагмент,
 * инкрементальное обновление после правки файла видно следующему запросу.
 *
 * Host в проде владеет индексом; здесь Host заменён прямым вызовом сервиса —
 * это тот же продакшн-код, без моков.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertCondition,
  buildRuntimeConfig,
  chatCompletion,
  cleanupRunRoot,
  collectToolResults,
  createApp,
  createRunRoot,
  loadZCodeModules,
  openAiToolCall,
  prepareCaseDirs,
  requestText,
  repoRoot,
  writeCaseConfig,
  writeJson,
} from "./support.mjs";
import { startScriptedProvider, stopScriptedProvider, writeCapture } from "./scripted-provider.mjs";

const CASE_NAME = "code-index";
const DONE = "CODE_INDEX_E2E_DONE";
const SYMBOL = "resolveQuantumFluxCoefficient";
const INITIAL_BODY = [
  "export function resolveQuantumFluxCoefficient(input: number): number {",
  "  const scaled = input * 42.5;",
  "  return scaled / (input + 1);",
  "}",
  "",
].join("\n");
const UPDATED_BODY = [
  "export function resolveQuantumFluxCoefficient(input: number): number {",
  "  const scaled = input * 99.5; // incremental-marker-ok",
  "  return scaled / (input + 1);",
  "}",
  "",
].join("\n");

export const codeIndexCase = {
  name: CASE_NAME,
  async run({ artifactsRoot }) {
    const root = await createRunRoot();
    let app;
    let provider;
    let paths;
    let service;
    let failed = false;
    try {
      paths = await prepareCaseDirs({ caseName: CASE_NAME, root: artifactsRoot });
      const sourceDir = join(paths.workspace, "src");
      await mkdir(sourceDir, { recursive: true });
      const targetPath = join(sourceDir, "flux.ts");
      await writeFile(targetPath, INITIAL_BODY);
      await writeFile(
        join(sourceDir, "unrelated.ts"),
        "export const unrelatedConstant = 7;\n",
      );

      const services = await import(
        pathToFileURL(
          join(repoRoot, "packages", "services", "dist", "code-intelligence", "index.js"),
        ).href
      );
      service = services.createCodeIntelligenceService({
        indexRootDir: join(paths.storageDir, "code-intelligence"),
      });

      // F-05: первичный индекс строится автоматически, без ручной команды.
      const beforeStatus = await service.getStatus({ workspacePath: paths.workspace });
      await service.watchWorkspace({ workspacePath: paths.workspace, autoIndexOnOpen: true });
      const afterWatch = await waitForReady(service, paths.workspace);
      assertCondition(
        beforeStatus.state === "unindexed",
        "до активации индекс обязан быть unindexed",
        { beforeStatus },
      );
      assertCondition(
        afterWatch.state === "ready" && afterWatch.counts.files >= 2,
        "автостарт обязан построить индекс в фоне",
        { afterWatch },
      );

      // Порт кодового индекса: тот же контракт, что Host отдаёт агенту через RPC.
      const port = {
        async query(request) {
          if (request.action === "status") {
            return { action: "status", status: await service.getStatus(ref()) };
          }
          if (request.action === "search") {
            const found = await service.search({ ...ref(), query: request.query, limit: 5 });
            return {
              action: "search",
              results: found.results,
              semantic: found.semantic,
              partial: found.partial,
            };
          }
          if (request.action === "context") {
            return {
              action: "context",
              context: await service.getSymbolContext({ ...ref(), symbol: request.symbol }),
            };
          }
          if (request.action === "impact") {
            return {
              action: "impact",
              impact: await service.getImpact({ ...ref(), changedPaths: request.changedPaths }),
            };
          }
          return {
            action: "trace",
            trace: await service.trace({
              ...ref(),
              fromSymbol: request.fromSymbol,
              toSymbol: request.toSymbol,
            }),
          };
        },
      };
      const ref = () => ({ workspacePath: paths.workspace });

      provider = await startScriptedProvider({ handler: createHandler(targetPath), name: CASE_NAME });
      await writeCaseConfig(paths.configPath, {
        allowedTools: ["Read", "CodeIndex"],
        baseURL: provider.baseURL,
        storageDir: paths.storageDir,
      });
      const modules = await loadZCodeModules();
      app = await createApp({
        codeIntelligencePort: port,
        configPath: paths.configPath,
        modules,
        runtimeConfig: buildRuntimeConfig({ maxTurns: 8, workspace: paths.workspace }),
      });

      await app.submitPrompt(
        "Найди в индексе, где вычисляется scaled, и назови путь и строку.",
        { onEvent: async () => undefined },
      );

      const bodies = provider.records.map((record) => {
        try {
          return JSON.parse(record.requestBody ?? "{}");
        } catch {
          return {};
        }
      });
      const toolNames = (bodies[0]?.tools ?? []).map((tool) => tool.function?.name ?? tool.name);
      assertCondition(toolNames.includes("CodeIndex"), "CodeIndex обязан быть в списке инструментов", {
        toolNames,
      });
      const firstSearchBody = bodies[1] ?? {};
      assertCondition(
        requestText(firstSearchBody).includes("flux.ts"),
        "результат поиска обязан попасть в контекст следующего запроса",
        { requests: bodies.length },
      );
      assertCondition(
        requestText(firstSearchBody).includes("scaled"),
        "фрагмент результата обязан содержать искомое выражение",
        {},
      );

      // Инкрементальное обновление: правка файла → notifyFilesMutated → новый поиск.
      await writeFile(targetPath, UPDATED_BODY);
      await service.notifyFilesMutated({
        workspacePath: paths.workspace,
        changed: ["src/flux.ts"],
      });
      const updated = await service.search({
        workspacePath: paths.workspace,
        query: "incremental-marker-ok",
      });
      assertCondition(
        updated.results.length > 0 && updated.results[0].path.includes("flux.ts"),
        "инкрементальный проход обязан отразить правку файла",
        { results: updated.results.map((item) => item.path) },
      );

      const payload = {
        assertions: {
          autoStartBuiltIndexInBackground: true,
          codeIndexToolVisibleToModel: true,
          incrementalUpdateApplied: true,
          searchSnippetMatched: true,
        },
        case: CASE_NAME,
        counts: afterWatch.counts,
        status: "passed",
        toolCount: toolNames.length,
      };
      await writeCapture(provider, paths.capturePath);
      await writeJson(paths.resultPath, payload);
      await writeJson(join(artifactsRoot, `${CASE_NAME}.json`), payload);
      return payload;
    } catch (error) {
      failed = true;
      await writeCapture(provider, paths?.capturePath).catch(() => undefined);
      throw error;
    } finally {
      await app?.close?.();
      await stopScriptedProvider(provider);
      service?.disposeAll();
      if (!failed) await cleanupRunRoot(root);
    }
  },
};

async function waitForReady(service, workspacePath, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let status = await service.getStatus({ workspacePath });
  while (Date.now() < deadline) {
    if (status.state === "ready" || status.state === "degraded") return status;
    await new Promise((resolve) => setTimeout(resolve, 150));
    status = await service.getStatus({ workspacePath });
  }
  return status;
}

function createHandler(targetPath) {
  let turn = 0;
  return async ({ body }) => {
    turn += 1;
    const model = body?.model;
    if (turn === 1) {
      return {
        body: chatCompletion({
          model,
          toolCalls: [
            openAiToolCall("call_ci_search", "CodeIndex", {
              action: "search",
              query: "scaled",
              limit: 3,
            }),
          ],
        }),
      };
    }
    if (turn === 2) {
      return {
        body: chatCompletion({
          model,
          toolCalls: [
            openAiToolCall("call_ci_read", "Read", { file_path: targetPath, limit: 5 }),
          ],
        }),
      };
    }
    return { body: chatCompletion({ content: DONE, model }) };
  };
}
