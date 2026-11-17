/**
 * Песочница Bash: реальный `sandboxMode` в результате инструмента, и запись
 * вне workspace либо блокируется, либо честно помечена `degraded` с причиной.
 */
import { homedir } from "node:os";
import { rm } from "node:fs/promises";
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

const CASE_NAME = "bash-sandbox";
const DONE = "SANDBOX_E2E_DONE";
const OUTSIDE_MARKER = "SANDBOX_ESCAPE_WRITTEN";

export const bashSandboxCase = {
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
      // /tmp внутри bwrap — tmpfs (запись туда не видна на хосте, но и не является
      // «побегом»). Проверяем настоящую границу: $HOME смонтирован read-only.
      const outsidePath = join(homedir(), `.zcode-sandbox-escape-${process.pid}-${Date.now()}.txt`);
      provider = await startScriptedProvider({
        handler: createHandler(outsidePath),
        name: CASE_NAME,
      });
      await writeCaseConfig(paths.configPath, {
        allowedTools: ["Bash"],
        baseURL: provider.baseURL,
        storageDir: paths.storageDir,
      });
      const modules = await loadZCodeModules();
      app = await createApp({
        configPath: paths.configPath,
        modules,
        runtimeConfig: buildRuntimeConfig({ maxTurns: 6, workspace: paths.workspace }),
      });

      const result = await app.submitPrompt("Проверь песочницу Bash.", {
        onEvent: async (event) => events.push(event),
      });

      const bashResults = collectToolResults(events, modules.SessionEventType).filter(
        (entry) => entry.toolName === "Bash",
      );
      const bashOutputs = bashResults.map((entry) => entry.content);

      assertCondition(bashResults.length >= 1, "ожидался результат Bash", { bashOutputs });
      // Модель видит фактический режим изоляции в тексте результата: именно этот
      // текст уходит в провайдер, поэтому проверяем его, а не внутренние поля события.
      const combined = bashOutputs.join("\n");
      const sandboxMatch = combined.match(/\[sandbox: mode=([a-z]+)(?:, reason: ([^\]]+))?/);
      assertCondition(
        sandboxMatch !== null,
        "текст результата Bash обязан сообщать фактический sandbox.mode",
        { outputs: bashOutputs },
      );
      const sandboxMode = sandboxMatch[1];
      const sandboxReason = sandboxMatch[2];
      assertCondition(
        ["bwrap", "seatbelt", "degraded", "none"].includes(sandboxMode),
        "sandboxMode обязан быть одним из реальных значений",
        { sandboxMode },
      );
      if (sandboxMode === "degraded") {
        assertCondition(
          /reason/i.test(combined),
          "degraded обязан сопровождаться причиной",
          { combined: combined.slice(0, 4000) },
        );
      }

      // Попытка записи вне workspace: либо отказ, либо деградация с явной причиной.
      const escaped = await readIfExists(outsidePath);
      if (escaped !== null) await rm(outsidePath, { force: true }).catch(() => undefined);
      assertCondition(
        escaped === null,
        "запись вне workspace должна блокироваться реальной песочницей",
        { escaped, sandboxMode, sandboxReason },
      );
      void OUTSIDE_MARKER;

      const payload = {
        assertions: {
          escapeBlocked: escaped === null,
          sandboxModeReported: true,
          sandboxReasonWhenDegraded: sandboxMode !== "degraded",
        },
        case: CASE_NAME,
        response: result.response,
        sandboxMode,
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

async function readIfExists(path) {
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function createHandler(outsidePath) {
  let requestCount = 0;
  return async ({ body }) => {
    requestCount += 1;
    const model = body?.model;
    if (requestCount === 1) {
      return {
        body: chatCompletion({
          model,
          toolCalls: [
            openAiToolCall("call_sandbox_echo", "Bash", {
              command: "printf 'SANDBOX_INSIDE_OK\\n'",
              description: "Печать внутри workspace",
            }),
          ],
        }),
      };
    }
    if (requestCount === 2) {
      return {
        body: chatCompletion({
          model,
          toolCalls: [
            openAiToolCall("call_sandbox_escape", "Bash", {
              command: `printf ${JSON.stringify(OUTSIDE_MARKER)} > ${JSON.stringify(outsidePath)}; echo attempted`,
              description: "Попытка записи вне workspace",
            }),
          ],
        }),
      };
    }
    return { body: chatCompletion({ content: DONE, model }) };
  };
}
