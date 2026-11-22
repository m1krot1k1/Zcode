/**
 * F-03/F-04: стабильность кэшируемого префикса и доступность `ApplyPatch`
 * на не-GPT модели.
 *
 * Кэш промптов работает только когда байты префикса (system + tools) не
 * меняются между запросами. Проверяем это на реальных телах запросов к
 * провайдеру. Дополнительно убеждаемся, что `ApplyPatch` не отфильтрован по
 * семейству модели (сценарий F-03: он был доступен только GPT) и реально
 * применяет патч.
 */
import { readFile } from "node:fs/promises";
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
  parseRecordBody,
  prepareCaseDirs,
  writeCaseConfig,
  writeJson,
} from "./support.mjs";
import { startScriptedProvider, stopScriptedProvider, writeCapture } from "./scripted-provider.mjs";

const CASE_NAME = "prompt-cache-apply-patch";
const DONE = "CACHE_APPLY_PATCH_E2E_DONE";
const TARGET_FILE = "target.mjs";
const BEFORE = "export const alpha = 1;\n";
const AFTER = "export const alpha = 2;\n";

export const promptCacheApplyPatchCase = {
  name: CASE_NAME,
  async run({ artifactsRoot }) {
    const root = await createRunRoot();
    let app;
    let provider;
    let paths;
    let failed = false;
    try {
      paths = await prepareCaseDirs({ caseName: CASE_NAME, root: artifactsRoot });
      const targetPath = join(paths.workspace, TARGET_FILE);
      await writeFileSafe(targetPath, BEFORE);
      const events = [];
      provider = await startScriptedProvider({
        handler: createHandler(targetPath),
        name: CASE_NAME,
      });
      await writeCaseConfig(paths.configPath, {
        allowedTools: ["Read", "ApplyPatch"],
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
        "Прочитай target.mjs и примени патч, поменяв alpha=1 на alpha=2.",
        { onEvent: async (event) => events.push(event) },
      );

      const bodies = provider.records.map((record) => parseRecordBody(record));
      assertCondition(bodies.length >= 2, "ожидалось не менее двух запросов", {
        requestCount: bodies.length,
      });
      // Префикс = декларации инструментов + system-сообщение. Он обязан быть
      // побайтово одинаковым, иначе провайдерский prompt cache промахивается.
      const prefixes = bodies.map((body) => cacheablePrefix(body));
      const stable = prefixes.every((prefix) => prefix === prefixes[0]);
      assertCondition(
        stable,
        "кэшируемый префикс (tools + system) обязан быть побайтово стабильным",
        {
          lengths: prefixes.map((prefix) => prefix.length),
          firstDiff: firstDifference(prefixes[0], prefixes[1]),
        },
      );

      const toolNames = (bodies[0]?.tools ?? []).map((tool) => tool.function?.name ?? tool.name);
      assertCondition(
        toolNames.includes("ApplyPatch"),
        "ApplyPatch обязан быть виден модели на не-GPT провайдере",
        { toolNames },
      );

      const toolResults = collectToolResults(events, modules.SessionEventType);
      const applyPatchResult = toolResults.find((entry) => entry.toolName === "ApplyPatch");
      assertCondition(
        applyPatchResult !== undefined && applyPatchResult.success,
        "ApplyPatch обязан успешно примениться",
        { toolResults: toolResults.map((entry) => ({ ok: entry.success, tool: entry.toolName })) },
      );
      const content = await readFile(targetPath, "utf8");
      assertCondition(
        content.includes("export const alpha = 2;"),
        "патч обязан изменить файл на диске",
        { content },
      );
      assertCondition(
        String(result?.response ?? "").includes(DONE),
        "агент обязан завершить маркером",
        { response: result?.response },
      );

      const payload = {
        assertions: {
          applyPatchAppliedOnDisk: true,
          applyPatchVisibleForNonGptProvider: true,
          cacheablePrefixByteStable: stable,
        },
        case: CASE_NAME,
        prefixLength: prefixes[0]?.length ?? 0,
        providerRequestCount: bodies.length,
        status: "passed",
        toolCount: toolNames.length,
      };
      await writeCapture(provider, paths.capturePath);
      await writeJson(paths.eventsPath, events);
      await writeJson(paths.resultPath, payload);
      await writeJson(join(artifactsRoot, `${CASE_NAME}.json`), payload);
      return payload;
    } catch (error) {
      failed = true;
      if (paths) await writeCapture(provider, paths.capturePath).catch(() => undefined);
      throw error;
    } finally {
      await app?.close?.();
      await stopScriptedProvider(provider);
      if (!failed) await cleanupRunRoot(root);
    }
  },
};

async function writeFileSafe(path, content) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, content);
}

/** Первые два сообщения (system/контекст) + декларации инструментов. */
function cacheablePrefix(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const leading = messages
    .slice(0, 2)
    .map((message) => `${message.role}:${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}`)
    .join("\n");
  return `${JSON.stringify(body?.tools ?? [])}\n${leading}`;
}

function firstDifference(left = "", right = "") {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) {
      return { left: left.slice(index, index + 120), right: right.slice(index, index + 120) };
    }
  }
  return { lengthMismatch: [left.length, right.length] };
}

function createHandler(targetPath) {
  let requestCount = 0;
  return async ({ body }) => {
    requestCount += 1;
    const model = body?.model;
    if (requestCount === 1) {
      return {
        body: chatCompletion({
          model,
          toolCalls: [openAiToolCall("call_read_target", "Read", { file_path: targetPath })],
        }),
      };
    }
    if (requestCount === 2) {
      const patchText = [
        "*** Begin Patch",
        `*** Update File: ${targetPath}`,
        "@@",
        "-export const alpha = 1;",
        "+export const alpha = 2;",
        "*** End Patch",
      ].join("\n");
      return {
        body: chatCompletion({
          model,
          toolCalls: [openAiToolCall("call_apply_patch", "ApplyPatch", { patch_text: patchText })],
        }),
      };
    }
    return { body: chatCompletion({ content: DONE, model }) };
  };
}
