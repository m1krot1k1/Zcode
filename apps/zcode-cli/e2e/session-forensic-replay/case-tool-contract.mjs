/**
 * Публичный контракт инструментов: модель видит Read/Bash, но не PtySession.
 *
 * Регрессия: скриптованный провайдер сначала пытается вызвать `PtySession`
 * (как это делала модель при трёх карточках start → write → read) и получает
 * «Tool not found», затем выполняет ту же диагностику одним вызовом `Bash`.
 * Кейс проверяет и provider-visible список инструментов, и однораундовое
 * выполнение команды.
 */
import { join } from "node:path";
import {
  assertCondition,
  buildRuntimeConfig,
  chatCompletion,
  cleanupRunRoot,
  collectToolErrors,
  collectToolResults,
  createApp,
  createRunRoot,
  loadZCodeModules,
  openAiToolCall,
  prepareCaseDirs,
  writeCaseConfig,
  writeJson,
} from "./support.mjs";
import { startScriptedProvider, stopScriptedProvider, writeCapture } from "./scripted-provider.mjs";

const CASE_NAME = "tool-contract";
const DONE = "TOOL_CONTRACT_E2E_DONE";
const ONE_CALL_MARKER = "E2E_ONE_CALL";

export const toolContractCase = {
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
        handler: createHandler(),
        name: CASE_NAME,
      });
      await writeCaseConfig(paths.configPath, {
        allowedTools: ["PtySession", "Bash"],
        baseURL: provider.baseURL,
        storageDir: paths.storageDir,
      });
      const modules = await loadZCodeModules();
      app = await createApp({
        configPath: paths.configPath,
        modules,
        runtimeConfig: buildRuntimeConfig({ maxTurns: 6, workspace: paths.workspace }),
      });

      const result = await app.submitPrompt("Проверь диагностику команды.", {
        onEvent: async (event) => events.push(event),
      });

      const bodies = provider.records.map((record) => {
        try {
          return JSON.parse(record.requestBody ?? "{}");
        } catch {
          return {};
        }
      });
      const providerToolNames = (bodies[0]?.tools ?? []).map(
        (tool) => tool.function?.name ?? tool.name,
      );
      assertCondition(
        !providerToolNames.includes("PtySession"),
        "PtySession не должен попадать в provider-visible набор",
        { providerToolNames },
      );
      assertCondition(
        providerToolNames.includes("Bash") && providerToolNames.includes("Read"),
        "Read и Bash обязаны остаться в provider-visible наборе",
        { providerToolNames },
      );

      const toolResults = collectToolResults(events, modules.SessionEventType);
      const bashResults = toolResults.filter((entry) => entry.toolName === "Bash");
      const ptyResults = toolResults.filter((entry) => entry.toolName === "PtySession");
      const errors = collectToolErrors(events, modules.SessionEventType);

      assertCondition(
        errors.some((entry) => entry.content.includes("Tool not found: PtySession")),
        "вызов скрытого PtySession обязан вернуть Tool not found",
        { errors },
      );
      assertCondition(
        ptyResults.length === 0,
        "PtySession не должен возвращать результат выполнения",
        { ptyResults },
      );
      assertCondition(
        bashResults.length === 1,
        "диагностика обязана выполняться одним вызовом Bash",
        { bashResults },
      );
      assertCondition(
        bashResults[0]?.success === true && bashResults[0].content.includes(ONE_CALL_MARKER),
        "Bash обязан вернуть вывод команды в том же вызове",
        { bashResults },
      );
      assertCondition(result.response.includes(DONE), "агент обязан завершить маркером", {
        response: result.response,
      });

      const payload = {
        assertions: {
          bashSingleCall: true,
          ptyToolExposed: false,
          readAndBashVisible: true,
        },
        case: CASE_NAME,
        response: result.response,
        status: "passed",
        toolCallCount: toolResults.length,
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

function createHandler() {
  let requestCount = 0;
  return async ({ body }) => {
    requestCount += 1;
    const model = body?.model;
    switch (requestCount) {
      case 1:
        return {
          body: chatCompletion({
            model,
            toolCalls: [
              openAiToolCall("call_pty_start", "PtySession", {
                action: "start",
                sandboxProfile: "off",
                shell: "/bin/sh",
              }),
            ],
          }),
        };
      case 2:
        return {
          body: chatCompletion({
            model,
            toolCalls: [
              openAiToolCall("call_bash_once", "Bash", {
                command: `printf '${ONE_CALL_MARKER}\\n'`,
              }),
            ],
          }),
        };
      default:
        return { body: chatCompletion({ content: DONE, model }) };
    }
  };
}
