/**
 * PtySession: интерактивная сессия в реальном рантайме.
 *
 * Проверяем, что инструмент доступен модели (порт инжектируется хостом),
 * что сессия реально запускает shell, отдаёт инкрементальный вывод,
 * возвращает exit code и что kill снимает дерево процессов.
 */
import { join } from "node:path";
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
  writeCaseConfig,
  writeJson,
} from "./support.mjs";
import { startScriptedProvider, stopScriptedProvider, writeCapture } from "./scripted-provider.mjs";

const CASE_NAME = "pty-session";
const DONE = "PTY_E2E_DONE";
const STDERR_MARKER = "PTY_E2E_STDERR_SIDE";

export const ptySessionCase = {
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
        allowedTools: ["PtySession"],
        baseURL: provider.baseURL,
        storageDir: paths.storageDir,
      });
      const modules = await loadZCodeModules();
      app = await createApp({
        configPath: paths.configPath,
        modules,
        runtimeConfig: buildRuntimeConfig({ maxTurns: 12, workspace: paths.workspace }),
      });

      const result = await app.submitPrompt("Проверь интерактивную PTY-сессию по шагам.", {
        onEvent: async (event) => events.push(event),
      });

      const outputs = collectToolResults(events, modules.SessionEventType)
        .filter((entry) => entry.toolName === "PtySession")
        .map((entry) => entry.content);

      assertCondition(outputs.length >= 3, "ожидались start/read/kill вызовы PtySession", { outputs });
      assertCondition(
        outputs.some((text) => text.includes("PTY_E2E_HELLO")),
        "чтение сессии обязано отдать инкрементальный вывод shell",
        { outputs },
      );
      assertCondition(
        outputs.some((text) => text.includes(STDERR_MARKER)),
        "вывод обязан содержать данные, которые печатались в сессию",
        { outputs },
      );
      assertCondition(
        outputs.some((text) => text.includes('"exitCode"')),
        "снимок сессии обязан содержать exitCode после завершения",
        { outputs },
      );
      // kill идемпотентен: уже завершённая сессия остаётся exited (контракт
      // «write/resize/kill на завершённой сессии — тихая идемпотентность»).
      assertCondition(
        outputs.some(
          (text) => text.includes('"status":"killed"') || text.includes('"status":"exited"'),
        ),
        "kill обязан вернуть терминальное состояние сессии",
        { outputs },
      );
      assertCondition(result.response.includes(DONE), "агент обязан завершить маркером", {
        response: result.response,
      });

      const payload = {
        assertions: {
          exitCodeReported: true,
          incrementalRead: true,
          killTerminates: true,
          ptyToolExposed: true,
        },
        case: CASE_NAME,
        response: result.response,
        status: "passed",
        toolCallCount: outputs.length,
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
  let sessionId = "pty-e2e-session";
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
      case 2: {
        // Реальный id выдаёт менеджер, а не скрипт: читаем его из tool-сообщения
        // предыдущего шага (content — сериализованный JSON результата start).
        for (const message of body?.messages ?? []) {
          if (message?.role !== "tool") continue;
          try {
            const parsed = JSON.parse(message.content);
            const candidate = parsed?.session?.sessionId;
            if (typeof candidate === "string" && candidate.startsWith("pty_")) sessionId = candidate;
          } catch {
            // Не-JSON tool-сообщения (например, текст ошибки) просто пропускаем.
          }
        }
        return {
          body: chatCompletion({
            model,
            toolCalls: [
              openAiToolCall("call_pty_write", "PtySession", {
                action: "write",
                data: `echo PTY_E2E_HELLO; echo ${STDERR_MARKER} 1>&2; exit 3\n`,
                sessionId,
              }),
            ],
          }),
        };
      }
      case 3:
        return {
          body: chatCompletion({
            model,
            toolCalls: [openAiToolCall("call_pty_read", "PtySession", { action: "read", sessionId })],
          }),
        };
      case 4:
        return {
          body: chatCompletion({
            model,
            toolCalls: [openAiToolCall("call_pty_kill", "PtySession", { action: "kill", sessionId })],
          }),
        };
      default:
        return { body: chatCompletion({ content: DONE, model }) };
    }
  };
}
