/**
 * F-01: обрыв генерации по `finishReason === "length"` на большом JSON-аргументе Write.
 *
 * Воспроизводит исходный отказ сессии dee7732e…: провайдер отдаёт tool_call,
 * чей `arguments` обрывается на лимите выходных токенов. Проверяем, что:
 *  1) модель получает детерминированный `TOOL_CALL_TRUNCATED_BY_MAX_TOKENS`
 *     с инструкцией декомпозиции, а не `Unexpected end of JSON input`;
 *  2) на диск не попадает ни одного байта обрезанного файла;
 *  3) после подсказки агент завершает задачу каркасом + дописыванием.
 */
import { readFile } from "node:fs/promises";
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
  openAiToolCallRawArgs,
  parseRecordBody,
  prepareCaseDirs,
  requestText,
  writeCaseConfig,
  writeJson,
} from "./support.mjs";
import { startScriptedProvider, stopScriptedProvider, writeCapture } from "./scripted-provider.mjs";

const CASE_NAME = "truncated-tool-args";
const TRUNCATION_CODE = "TOOL_CALL_TRUNCATED_BY_MAX_TOKENS";
const TARGET_FILE = "big-module.mjs";
const SKELETON = "export function alpha() {\n  return 1;\n}\n";
const DONE = "TRUNCATED_E2E_DONE";
const MAX_OUTPUT_TOKENS = 16_384;

export const truncatedToolArgsCase = {
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
      provider = await startScriptedProvider({
        handler: createHandler(paths.workspace),
        name: CASE_NAME,
      });
      await writeCaseConfig(paths.configPath, {
        baseURL: provider.baseURL,
        contextWindow: 1_000_000,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        storageDir: paths.storageDir,
      });
      const modules = await loadZCodeModules();
      app = await createApp({
        configPath: paths.configPath,
        modules,
        runtimeConfig: buildRuntimeConfig({ workspace: paths.workspace }),
      });

      const result = await app.submitPrompt(
        `Создай ${TARGET_FILE} с функцией alpha. Если вызов инструмента обрывается — следуй инструкции восстановления.`,
        { onEvent: async (event) => events.push(event) },
      );

      const bodies = provider.records.map((record) => parseRecordBody(record));
      const allText = bodies.map((body) => requestText(body)).join("\n");
      const second = bodies[1] ? requestText(bodies[1]) : "";

      assertCondition(
        provider.records.length >= 2,
        "ожидался хотя бы один повторный запрос после обрыва",
        { requestCount: provider.records.length },
      );
      assertCondition(
        second.includes(TRUNCATION_CODE),
        "второй запрос обязан содержать детерминированный код обрыва",
        { secondRequestExcerpt: second.slice(-2000) },
      );
      assertCondition(
        second.includes("Do NOT retry writing the entire large file"),
        "инструкция декомпозиции Write/Edit обязана присутствовать",
        { secondRequestExcerpt: second.slice(-2000) },
      );
      assertCondition(
        !allText.includes("Unexpected end of JSON input"),
        "обрезанный JSON не должен превращаться в ошибку парсинга",
      );
      assertCondition(
        result.response.includes(DONE),
        "агент обязан завершить задачу после инструкции восстановления",
        { response: result.response },
      );

      const diskContent = await readFile(join(paths.workspace, TARGET_FILE), "utf8");
      assertCondition(
        diskContent === SKELETON,
        "на диск должен попасть только валидный каркас, без обрезанных фрагментов",
        { diskContent, skeleton: SKELETON },
      );

      const payload = {
        assertions: {
          deterministicTruncationCode: true,
          decomposedRecovery: true,
          noJsonParseError: true,
          noPartialFileOnDisk: true,
        },
        case: CASE_NAME,
        providerRequestCount: provider.records.length,
        response: result.response,
        status: "passed",
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
  return async ({ body }) => {
    requestCount += 1;
    if (requestCount === 1) {
      // Обрыв ровно на лимите: незакрытая JSON-строка аргументов Write.
      const truncatedArgs = `{"file_path":${JSON.stringify(
        join(workspace, TARGET_FILE),
      )},"content":"export function alpha() {\\n  return 1;\\n}\\nexport function beta() {\\n  // `;
      return {
        body: chatCompletion({
          finishReason: "length",
          model: body?.model,
          toolCalls: [openAiToolCallRawArgs("call_truncated_write", "Write", truncatedArgs)],
        }),
      };
    }
    if (requestCount === 2) {
      return {
        body: chatCompletion({
          model: body?.model,
          toolCalls: [
            openAiToolCall("call_skeleton_write", "Write", {
              content: SKELETON,
              file_path: join(workspace, TARGET_FILE),
            }),
          ],
        }),
      };
    }
    return { body: chatCompletion({ content: DONE, model: body?.model }) };
  };
}

export const __caseInternals = { DONE, MAX_OUTPUT_TOKENS, SKELETON, TARGET_FILE };
