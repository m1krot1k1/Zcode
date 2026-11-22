/**
 * F-02 / F-03 / F-07: атомарная мультифайловая транзакция инструментов.
 *
 * Три подкейса в одном прогоне runtime:
 *  1) успешный пакет create+edit+delete по трём файлам применяется целиком;
 *  2) транзакция с синтаксически битым результатом отклоняется, и НИ ОДИН файл
 *     не меняется (нет частично записанных файлов);
 *  3) `Edit` со сдвинутым отступом сопоставляется через tolerant-стратегию,
 *     а не падает с `String to replace not found`.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertCondition,
  buildRuntimeConfig,
  chatCompletion,
  cleanupRunRoot,
  collectToolResults,
  collectToolErrors,
  createApp,
  createRunRoot,
  loadZCodeModules,
  openAiToolCall,
  prepareCaseDirs,
  writeCaseConfig,
  writeJson,
} from "./support.mjs";
import { startScriptedProvider, stopScriptedProvider, writeCapture } from "./scripted-provider.mjs";

const CASE_NAME = "multiedit-transaction";
const DONE = "MULTIEDIT_E2E_DONE";

const MOD_A_BEFORE = "export const a = 1;\n";
const MOD_B_BEFORE = "export const b = 2;\n";
const MOD_C_BEFORE = "export const c = 3;\n";

export const multiEditTransactionCase = {
  name: CASE_NAME,
  async run({ artifactsRoot }) {
    const root = await createRunRoot();
    const events = [];
    let app;
    let provider;
    let paths;
    let failed = false;
    try {
      paths = await prepareCaseDirs({ caseName: CASE_NAME, root: artifactsRoot });
      const fileA = join(paths.workspace, "a.mjs");
      const fileB = join(paths.workspace, "b.mjs");
      const fileC = join(paths.workspace, "c.mjs");
      await writeFile(fileA, MOD_A_BEFORE);
      await writeFile(fileB, MOD_B_BEFORE);
      await writeFile(fileC, MOD_C_BEFORE);

      provider = await startScriptedProvider({
        handler: createHandler(paths.workspace),
        name: CASE_NAME,
      });
      await writeCaseConfig(paths.configPath, {
        allowedTools: ["MultiEdit", "Read", "Write", "Edit"],
        baseURL: provider.baseURL,
        storageDir: paths.storageDir,
      });
      const modules = await loadZCodeModules();
      app = await createApp({
        configPath: paths.configPath,
        modules,
        runtimeConfig: buildRuntimeConfig({ maxTurns: 8, workspace: paths.workspace }),
      });

      const result = await app.submitPrompt(
        "Выполни атомарные мультифайловые транзакции строго по шагам из системного задания.",
        { onEvent: async (event) => events.push(event) },
      );

      const report = collectToolResults(events, modules.SessionEventType)
        .filter((entry) => entry.toolName === "MultiEdit" || entry.toolName === "Edit")
        .map((entry) => ({
          outputText: String(entry.content ?? ""),
          success: entry.success,
          toolName: entry.toolName,
        }));

      // Отклонённая транзакция завершается событием ошибки инструмента, а не
      // успешным результатом: обе формы относятся к одному сценарию.
      const errorResults = collectToolErrors(events, modules.SessionEventType).map((entry) => ({
        outputText: String(entry.content ?? ""),
        success: false,
        toolName: entry.toolName,
      }));
      const multiEditOutputs = [
        ...report.filter((entry) => entry.toolName === "MultiEdit"),
        ...errorResults.filter((entry) => entry.toolName === "MultiEdit"),
      ];
      const editOutputs = [
        ...report.filter((entry) => entry.toolName === "Edit"),
        ...errorResults.filter((entry) => entry.toolName === "Edit"),
      ];

      assertCondition(
        String(result?.response ?? "").includes(DONE),
        "агент обязан завершить сценарий маркером",
        { response: result.response },
      );
      assertCondition(
        multiEditOutputs.length >= 2,
        "ожидались успешная и отклонённая транзакции MultiEdit",
        { multiEditOutputs },
      );
      assertCondition(
        multiEditOutputs.some(
          (entry) =>
            entry.outputText.includes("committed") ||
            entry.outputText.includes('"status":"committed"'),
        ),
        "успешная транзакция обязана вернуть статус committed",
        { multiEditOutputs },
      );
      assertCondition(
        multiEditOutputs.some(
          (entry) =>
            entry.outputText.includes("rejected_syntax") ||
            entry.outputText.includes("multi_edit_syntax_validation_failed") ||
            entry.outputText.includes("No files were modified"),
        ),
        "битая по синтаксису транзакция обязана быть отклонена без записи",
        { multiEditOutputs },
      );
      assertCondition(editOutputs.length >= 1, "ожидался вызов Edit с tolerant-совпадением");

      const [contentA, contentB, existsC] = await Promise.all([
        readFile(fileA, "utf8"),
        readFile(fileB, "utf8"),
        readFile(fileC, "utf8").catch(() => null),
      ]);

      assertCondition(
        contentA.includes("export const a = 1;") && contentA.includes("export const added = 42;"),
        "успешный пакет обязан дописать a.mjs",
        { contentA },
      );
      assertCondition(
        contentB.includes("export const b = 2;") && contentB.includes("export const editedB = 7;"),
        "успешный пакет обязан изменить b.mjs",
        { contentB },
      );
      assertCondition(existsC === null, "успешный пакет обязан удалить c.mjs", { existsC });
      assertCondition(
        contentA.includes("export const indentTolerant = true;"),
        "Edit обязан применить tolerant-совпадение по отступу",
        { contentA },
      );
      assertCondition(
        !contentA.includes("SHOULD_NOT_APPEAR"),
        "отклонённая транзакция не должна оставить следов на диске",
        { contentA },
      );

      const payload = {
        assertions: {
          editIndentTolerant: true,
          rejectedTransactionLeftNoTrace: true,
          rejectedTransactionStatusRejectedSyntax: true,
          successfulTransactionCommittedAtomically: true,
        },
        case: CASE_NAME,
        response: result.response,
        status: "passed",
        toolResults: report,
      };
      await writeCapture(provider, paths.capturePath);
      await writeJson(paths.eventsPath, events);
      await writeJson(paths.resultPath, payload);
      await writeJson(join(artifactsRoot, `${CASE_NAME}.json`), payload);
      return payload;
    } catch (error) {
      // Диагностика: артефакты упавшего кейса обязаны сохраниться для разбора.
      failed = true;
      if (paths) {
        await writeCapture(provider, paths.capturePath).catch(() => undefined);
        await writeJson(paths.eventsPath, events).catch(() => undefined);
      }
      throw error;
    } finally {
      await app?.close?.();
      await stopScriptedProvider(provider);
      if (!failed) await cleanupRunRoot(root);
    }
  },
};

function createHandler(workspace) {
  let requestCount = 0;
  const pathOf = (name) => join(workspace, name);
  return async ({ body }) => {
    requestCount += 1;
    const model = body?.model;
    switch (requestCount) {
      case 1:
        // Транзакция требует предварительного чтения: это инвариант инструмента,
        // а не помеха сценарию. Читаем все три файла одним пакетом.
        return {
          body: chatCompletion({
            model,
            toolCalls: ["a.mjs", "b.mjs", "c.mjs"].map((name, index) =>
              openAiToolCall(`call_read_${index}`, "Read", { file_path: pathOf(name) }),
            ),
          }),
        };
      case 2:
        return {
          body: chatCompletion({
            model,
            toolCalls: [
              openAiToolCall("call_tx_ok", "MultiEdit", {
                operations: [
                  { file_path: pathOf("a.mjs"), kind: "edit", edits: [
                    { new_string: `export const a = 1;\nexport const added = 42;\n`, old_string: "export const a = 1;\n" },
                  ] },
                  { file_path: pathOf("b.mjs"), kind: "edit", edits: [
                    { new_string: `export const b = 2;\nexport const editedB = 7;\n`, old_string: "export const b = 2;\n" },
                  ] },
                  { file_path: pathOf("c.mjs"), kind: "delete" },
                ],
              }),
            ],
          }),
        };
      case 3:
        return {
          body: chatCompletion({
            model,
            toolCalls: [
              openAiToolCall("call_tx_bad", "MultiEdit", {
                operations: [
                  { file_path: pathOf("a.mjs"), kind: "edit", edits: [
                    {
                      new_string: "export const a = 1;\nexport const broken = ;\nSHOULD_NOT_APPEAR\n",
                      old_string: "export const added = 42;\n",
                    },
                  ] },
                ],
              }),
            ],
          }),
        };
      case 4:
        return {
          body: chatCompletion({
            model,
            toolCalls: [
              openAiToolCall("call_edit_indent", "Edit", {
                file_path: pathOf("a.mjs"),
                // Отступ намеренно отличается от файла: 4 пробела вместо 0.
                new_string: "    export const added = 42;\n    export const indentTolerant = true;\n",
                old_string: "    export const added = 42;\n",
              }),
            ],
          }),
        };
      default:
        return { body: chatCompletion({ content: DONE, model }) };
    }
  };
}
