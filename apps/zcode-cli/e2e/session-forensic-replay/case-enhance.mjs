/**
 * `/enhance`: реальный путь `runEnhanceCommand` → `AgentRuntime.generateWorkspaceText`
 * → адаптер → скриптованный провайдер.
 *
 * Проверяем: успешное улучшение с сохранением protected mentions, отмену по
 * AbortSignal и честный отказ `model_unavailable` без выбранной модели.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MODULE_ROOT,
  assertCondition,
  buildRuntimeConfig,
  chatCompletion,
  cleanupRunRoot,
  createApp,
  createRunRoot,
  loadZCodeModules,
  prepareCaseDirs,
  writeCaseConfig,
  writeJson,
} from "./support.mjs";
import { startScriptedProvider, stopScriptedProvider, writeCapture } from "./scripted-provider.mjs";

const CASE_NAME = "enhance-command";
const ENHANCED_MARKER = "ENHANCED_PROMPT_E2E";

export const enhanceCommandCase = {
  name: CASE_NAME,
  async run({ artifactsRoot }) {
    const root = await createRunRoot();
    let app;
    let provider;
    let paths;
    let failed = false;
    try {
      paths = await prepareCaseDirs({ caseName: CASE_NAME, root: artifactsRoot });
      provider = await startScriptedProvider({
        handler: createHandler(),
        name: CASE_NAME,
      });
      await writeCaseConfig(paths.configPath, {
        allowedTools: ["Read"],
        baseURL: provider.baseURL,
        storageDir: paths.storageDir,
      });
      const modules = await loadZCodeModules();
      app = await createApp({
        configPath: paths.configPath,
        modules,
        runtimeConfig: buildRuntimeConfig({ maxTurns: 4, workspace: paths.workspace }),
      });

      const enhanceModule = await import(
        pathToFileURL(join(MODULE_ROOT, "cli", "src", "enhance-command.ts")).href
      );

      // 1) Успешное улучшение: protected mention `@src/app.ts` обязан сохраниться.
      const success = await enhanceModule.runEnhanceCommand(
        "Добавь кэш в @src/app.ts и покрой тестами",
        { runtime: app.runtime, sessionId: app.sessionId, workspacePath: paths.workspace },
      );
      assertCondition(
        typeof success?.enhancedText === "string" && success.enhancedText.includes(ENHANCED_MARKER),
        "enhance обязан вернуть улучшенный текст от модели",
        { outcome: success },
      );
      assertCondition(
        success.enhancedText.includes("@src/app.ts"),
        "protected mention обязан сохраниться в улучшенном промпте",
        { enhancedText: success.enhancedText },
      );
      assertCondition(
        success.result?.modelUsed?.modelId?.length > 0,
        "результат обязан сообщать использованную модель",
        { result: success.result },
      );

      // 2) Отмена: AbortSignal до запроса обязан прервать операцию.
      const controller = new AbortController();
      controller.abort();
      let cancelError;
      try {
        await enhanceModule.runEnhanceCommand("Отменяемая правка @src/app.ts", {
          abortSignal: controller.signal,
          runtime: app.runtime,
          sessionId: app.sessionId,
          workspacePath: paths.workspace,
        });
      } catch (error) {
        cancelError = error;
      }
      assertCondition(
        cancelError !== undefined,
        "отмена обязана прервать enhance, а не вернуть результат",
        { cancelError: String(cancelError) },
      );

      // 3) Пустой ввод отвергается детерминированно, без обращения к модели.
      let invalidError;
      try {
        await enhanceModule.runEnhanceCommand("  ", {
          runtime: app.runtime,
          sessionId: app.sessionId,
          workspacePath: paths.workspace,
        });
      } catch (error) {
        invalidError = error;
      }
      assertCondition(
        invalidError?.code === "invalid_request",
        "пустой ввод обязан давать invalid_request",
        { code: invalidError?.code, message: invalidError?.message },
      );

      // 4) Недоступность модели: runtime без сессионной модели → model_unavailable.
      let unavailableError;
      try {
        await enhanceModule.runEnhanceCommand("Правка @src/app.ts", {
          runtime: {
            generateWorkspaceText: async () => {
              throw new Error("must not be called");
            },
            getSessionModelSelection: () => undefined,
          },
          sessionId: app.sessionId,
          workspacePath: paths.workspace,
        });
      } catch (error) {
        unavailableError = error;
      }
      assertCondition(
        unavailableError?.code === "model_unavailable",
        "отсутствие модели обязано давать model_unavailable",
        { code: unavailableError?.code, message: unavailableError?.message },
      );

      const payload = {
        assertions: {
          cancellationAborts: cancelError !== undefined,
          emptyInputRejected: invalidError?.code === "invalid_request",
          modelUnavailableReported: unavailableError?.code === "model_unavailable",
          mentionsPreserved: success.enhancedText.includes("@src/app.ts"),
          realModelCallReturnedPrompt: success.enhancedText.includes(ENHANCED_MARKER),
        },
        case: CASE_NAME,
        enhancedPreview: success.enhancedText.slice(0, 400),
        providerRequestCount: provider.records.length,
        status: "passed",
      };
      await writeCapture(provider, paths.capturePath);
      await writeJson(paths.eventsPath, []);
      await writeJson(paths.resultPath, payload);
      await writeJson(join(artifactsRoot, `${CASE_NAME}.json`), payload);
      return payload;
    } catch (error) {
      failed = true;
      if (paths) {
        await writeCapture(provider, paths.capturePath).catch(() => undefined);
      }
      throw error;
    } finally {
      await app?.close?.();
      await stopScriptedProvider(provider);
      if (!failed) await cleanupRunRoot(root);
    }
  },
};

function createHandler() {
  let requestCount = 0;
  return async ({ body }) => {
    requestCount += 1;
    const model = body?.model;
    if (requestCount === 1) {
      return {
        body: chatCompletion({
          content: [
            "<analysis>Переформулирую запрос точнее.</analysis>",
            "<enhanced_prompt>",
            `${ENHANCED_MARKER}: добавь кэш в @src/app.ts, покрой изменения регрессионными тестами.`,
            "</enhanced_prompt>",
            "<added_clarifications>- указать стратегию инвалидации</added_clarifications>",
          ].join("\n"),
          model,
        }),
      };
    }
    return {
      body: chatCompletion({
        content: `<enhanced_prompt>${ENHANCED_MARKER}: fallback</enhanced_prompt>`,
        model,
      }),
    };
  };
}
