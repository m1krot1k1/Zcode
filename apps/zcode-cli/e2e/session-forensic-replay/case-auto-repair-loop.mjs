/**
 * Замкнутый цикл самовосстановления в реальном ходе агента.
 *
 * Сценарий: модель пишет файл с намеренной ошибкой типа, гейт запускает
 * `node_modules/.bin/tsc` (реальный процесс через ExecutionPort), получает
 * блокирующий сигнал TS1005, возвращает диагноз модели, модель исправляет
 * файл, второй запуск гейта даёт `clean` и turn завершается.
 *
 * Исполняемый файл tsc создаётся внутри тестовой папки: он детерминированно
 * печатает ошибку, пока в исходнике остаётся маркер `// broken-marker`.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertCondition,
  buildRuntimeConfig,
  chatCompletion,
  cleanupRunRoot,
  createApp,
  createRunRoot,
  loadZCodeModules,
  openAiToolCall,
  prepareCaseDirs,
  requestText,
  writeCaseConfig,
  writeJson,
} from "./support.mjs";
import { startScriptedProvider, stopScriptedProvider, writeCapture } from "./scripted-provider.mjs";

const CASE_NAME = "auto-repair-loop";
const DONE = "AUTO_REPAIR_E2E_DONE";
const TARGET = "app.ts";
const BROKEN = [
  "export function broken(): number {",
  "  return 1 // broken-marker",
  "}",
  "",
].join("\n");
const FIXED = [
  "export function broken(): number {",
  "  return 1;",
  "}",
  "",
].join("\n");

export const autoRepairLoopCase = {
  name: CASE_NAME,
  async run({ artifactsRoot }) {
    const root = await createRunRoot();
    let app;
    let provider;
    let paths;
    let failed = false;
    const events = [];
    try {
      paths = await prepareCaseDirs({ caseName: CASE_NAME, root: artifactsRoot });
      const targetPath = join(paths.workspace, TARGET);
      await writeFile(targetPath, BROKEN);
      await installFakeToolchain(paths.workspace);

      provider = await startScriptedProvider({
        handler: createHandler(targetPath),
        name: CASE_NAME,
      });
      await writeCaseConfig(paths.configPath, {
        allowedTools: ["Write", "Read"],
        baseURL: provider.baseURL,
        storageDir: paths.storageDir,
      });
      const modules = await loadZCodeModules();
      app = await createApp({
        configPath: paths.configPath,
        modules,
        runtimeConfig: buildRuntimeConfig({
          enableAutoRepairLoop: true,
          maxTurns: 12,
          workspace: paths.workspace,
        }),
      });

      const result = await app.submitPrompt(
        "Создай app.ts из шаблона и убедись, что он проходит проверку типов.",
        { onEvent: async (event) => events.push(event) },
      );

      const bodies = provider.records.map((record) => {
        try {
          return JSON.parse(record.requestBody ?? "{}");
        } catch {
          return {};
        }
      });
      // Запрос 1 — Write с ошибкой, запрос 2 — попытка завершить turn (гейт),
      // запрос 3 — исправление после диагноза, запрос 4 — чистое завершение.
      assertCondition(
        bodies.length >= 4,
        "гейт обязан вернуть ход модели после блокирующего сигнала",
        { requests: bodies.length },
      );

      // Отчёт гейта уходит в следующий запрос после «модель сказала готово»,
      // поэтому ищем его по всем запросам, а не по фиксированному индексу.
      const texts = bodies.map((body) => requestText(body));
      const reportIndex = texts.findIndex((text) => text.includes("[auto-repair]"));
      assertCondition(reportIndex >= 0, "модель обязана получить отчёт гейта", {
        requests: texts.length,
      });
      assertCondition(
        texts[reportIndex].includes("TS1005"),
        "в отчёте обязан быть конкретный код ошибки",
        { reportIndex },
      );
      assertCondition(
        reportIndex < texts.length - 1,
        "после диагноза обязан быть ещё один запрос модели (исправление)",
        { reportIndex, requests: texts.length },
      );

      const finalContent = await readFile(targetPath, "utf8");
      assertCondition(
        !finalContent.includes("broken-marker"),
        "агент обязан исправить файл самостоятельно",
        { finalContent },
      );
      assertCondition(
        String(result?.response ?? "").includes(DONE),
        "turn обязан завершиться маркером",
        { response: result?.response },
      );

      const payload = {
        assertions: {
          blockingSignalReturnedToModel: true,
          fileRepairedWithoutUser: true,
          gateRanRealTypecheckProcess: true,
        },
        case: CASE_NAME,
        modelRequests: bodies.length,
        status: "passed",
      };
      await writeCapture(provider, paths.capturePath);
      await writeJson(paths.eventsPath, events);
      await writeJson(paths.resultPath, payload);
      await writeJson(join(artifactsRoot, `${CASE_NAME}.json`), payload);
      return payload;
    } catch (error) {
      failed = true;
      await writeCapture(provider, paths?.capturePath).catch(() => undefined);
      // Артефакты упавшего прогона сохраняются: без них причину не восстановить.
      await writeJson(paths?.eventsPath ?? join(artifactsRoot, `${CASE_NAME}.events.json`), events)
        .catch(() => undefined);
      throw error;
    } finally {
      await app?.close?.();
      await stopScriptedProvider(provider);
      if (!failed) await cleanupRunRoot(root);
    }
  },
};

/**
 * Устанавливает детерминированные исполнители проверок в тестовой папке.
 * `tsc` печатает ошибку, пока в любом .ts-файле остаётся `broken-marker`.
 */
async function installFakeToolchain(workspace) {
  const binDir = join(workspace, "node_modules", ".bin");
  await mkdir(binDir, { recursive: true });
  const tscPath = join(binDir, "tsc");
  await writeFile(
    tscPath,
    [
      "#!/usr/bin/env node",
      'const { readdirSync, readFileSync, statSync } = require("node:fs");',
      'const { join } = require("node:path");',
      "const root = process.cwd();",
      "const hits = [];",
      "const walk = (dir) => {",
      "  for (const entry of readdirSync(dir)) {",
      '    if (entry === "node_modules" || entry.startsWith(".")) continue;',
      "    const full = join(dir, entry);",
      "    if (statSync(full).isDirectory()) { walk(full); continue; }",
      '    if (!entry.endsWith(".ts")) continue;',
      '    const text = readFileSync(full, "utf8");',
      '    if (text.includes("broken-marker")) {',
      '      hits.push(entry + "(2,10): error TS1005: \';\' expected.");',
      "    }",
      "  }",
      "};",
      "walk(root);",
      "if (hits.length > 0) {",
      '  process.stdout.write(hits.join("\\n") + "\\n");',
      "  process.exit(1);",
      "}",
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  await chmod(tscPath, 0o755);
  const oxlintPath = join(binDir, "oxlint");
  await writeFile(
    oxlintPath,
    ['#!/usr/bin/env node', "process.exit(0);", ""].join("\n"),
  );
  await chmod(oxlintPath, 0o755);
}

function createHandler(targetPath) {
  let turn = 0;
  return async ({ body }) => {
    turn += 1;
    const model = body?.model;
    // `Write` требует предварительного `Read` — читаем файл перед каждой записью.
    if (turn === 1) {
      return {
        body: chatCompletion({
          model,
          toolCalls: [openAiToolCall("call_read_initial", "Read", { file_path: targetPath })],
        }),
      };
    }
    if (turn === 2) {
      return {
        body: chatCompletion({
          model,
          toolCalls: [
            openAiToolCall("call_write_broken", "Write", {
              content: BROKEN,
              file_path: targetPath,
            }),
          ],
        }),
      };
    }
    if (turn === 3) {
      return { body: chatCompletion({ content: "Готово, файл создан.", model }) };
    }
    if (turn === 4) {
      return {
        body: chatCompletion({
          model,
          toolCalls: [openAiToolCall("call_read_broken", "Read", { file_path: targetPath })],
        }),
      };
    }
    if (turn === 5) {
      return {
        body: chatCompletion({
          model,
          toolCalls: [
            openAiToolCall("call_write_fixed", "Write", {
              content: FIXED,
              file_path: targetPath,
            }),
          ],
        }),
      };
    }
    return { body: chatCompletion({ content: DONE, model }) };
  };
}
