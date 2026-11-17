/**
 * Общая обвязка forensic-replay набора.
 *
 * Набор детерминированный: модель подменяется локальным скриптованным
 * OpenAI-compatible провайдером, реальная сеть и ключи не нужны. Проверяется
 * настоящий путь адаптер → runtime → tool executor → файловая транзакция.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const scriptDir = dirname(fileURLToPath(import.meta.url));
/** Корень монорепозитория: apps/zcode-cli/e2e/session-forensic-replay → ../../../.. */
export const repoRoot = resolve(scriptDir, "../../../..");
export const MODULE_ROOT = join(repoRoot, "apps", "zcode-cli", "packages");

export const FAKE_MODEL = "forensic-replay-model";
export const FAKE_PROVIDER = "forensic-replay-provider";
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;
const DEFAULT_CONTEXT_WINDOW = 1_000_000;

export async function loadZCodeModules() {
  try {
    const [bootstrap, contracts, providerConfig, providerRegistry] = await Promise.all([
      import(pathToFileURL(join(MODULE_ROOT, "bootstrap", "dist", "index.js")).href),
      import(pathToFileURL(join(MODULE_ROOT, "contracts", "dist", "index.js")).href),
      import(
        pathToFileURL(join(repoRoot, "packages", "provider", "dist", "config", "index.js")).href
      ),
      import(pathToFileURL(join(repoRoot, "packages", "provider", "dist", "registry.js")).href),
    ]);
    return {
      SessionEventType: contracts.SessionEventType,
      createZCodeApp: bootstrap.createZCodeApp,
      provider: { ...providerConfig, ...providerRegistry },
    };
  } catch (error) {
    throw new Error(
      "Не удалось загрузить собранные пакеты ZCode. Сначала выполните `pnpm build`.",
      { cause: error },
    );
  }
}

export async function prepareCaseDirs({ caseName, root }) {
  const caseRoot = join(root, "cases", caseName);
  const paths = {
    artifactsDir: caseRoot,
    capturePath: join(caseRoot, "capture.json"),
    configPath: join(caseRoot, "config.json"),
    eventsPath: join(caseRoot, "events.json"),
    resultPath: join(caseRoot, "result.json"),
    storageDir: join(caseRoot, "storage"),
    workspace: join(caseRoot, "workspace"),
  };
  await mkdir(paths.storageDir, { recursive: true });
  await mkdir(paths.workspace, { recursive: true });
  return paths;
}

export async function createRunRoot() {
  return await mkdtemp(join(tmpdir(), "zcode-forensic-replay-"));
}

export async function writeCaseConfig(configPath, input) {
  const config = {
    features: { mcp: false, memory: false, skill: false },
    logging: { level: "warn" },
    permission: { allowedTools: [...(input.allowedTools ?? ["Bash", "Read", "Write", "Edit", "ApplyPatch", "MultiEdit", "Agent"])], mode: "yolo" },
    storage: { dir: input.storageDir },
  };
  const providerFixture = {
    apiFormat: "openai-chat-completions",
    apiKey: "forensic-replay-key",
    baseURL: input.baseURL,
    contextWindow: input.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    modelId: FAKE_MODEL,
    providerId: FAKE_PROVIDER,
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(`${configPath}.provider.json`, `${JSON.stringify(providerFixture, null, 2)}\n`);
}

export function buildRuntimeConfig(input) {
  return {
    compact: {
      bufferTokens: input.compact?.bufferTokens ?? 1_000,
      contextWindow: input.compact?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      ...(input.compact?.enabled === undefined ? {} : { enabled: input.compact.enabled }),
      ...(input.compact?.maxConsecutiveFailures === undefined
        ? {}
        : { maxConsecutiveFailures: input.compact.maxConsecutiveFailures }),
      ...(input.compact?.microcompact === undefined
        ? {}
        : { microcompact: input.compact.microcompact }),
      summaryReserveTokens: input.compact?.summaryReserveTokens ?? 0,
      ...(input.compact?.thresholdPercentOverride === undefined
        ? {}
        : { thresholdPercentOverride: input.compact.thresholdPercentOverride }),
    },
    maxTurns: input.maxTurns ?? 10,
    mcp: { enabled: false, servers: {} },
    memory: { enabled: false, use: false },
    mode: "yolo",
    streamingToolExecution: "off",
    workingDirectory: input.workspace,
    ...(input.modelStreaming ? { modelStreaming: input.modelStreaming } : {}),
    ...(input.enableToolCallSelfRepair === undefined
      ? {}
      : { enableToolCallSelfRepair: input.enableToolCallSelfRepair }),
    ...(input.enableAutoRepairLoop === undefined
      ? {}
      : { enableAutoRepairLoop: input.enableAutoRepairLoop }),
  };
}

function createProviderRegistry(providerModule, fixture) {
  const config = new providerModule.ProviderConfig({
    group: "standard-personal",
    access: new providerModule.ApiKeyAccessConfig({ apiKey: fixture.apiKey }),
    api: new providerModule.ProviderApiConfig({
      type: fixture.apiFormat,
      baseUrl: fixture.baseURL,
    }),
    personalModelIds: [fixture.modelId],
    visibility: "visible",
  });
  const model = new providerModule.ModelConfig({
    enabled: true,
    properties: new providerModule.ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      contextWindow: fixture.contextWindow,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
    }),
    optionSpecs: new providerModule.ModelOptionSpecsConfig({
      reasoningLevel: { values: ["disabled"], map: "{}" },
      maxOutputTokens: {
        max: fixture.maxOutputTokens,
        map: '{"max_tokens":maxOutputTokens}',
      },
    }),
  });
  return new providerModule.ProviderRegistry([
    { providerId: fixture.providerId, config, models: [{ modelId: fixture.modelId, config: model }] },
  ]);
}

export async function createApp({ configPath, modules, runtimeConfig, codeIntelligencePort }) {
  const fixture = JSON.parse(await readFile(`${configPath}.provider.json`, "utf8"));
  return await modules.createZCodeApp({
    // Порт кодового индекса инжектируется так же, как в реальном Host: без него
    // инструмент `CodeIndex` не попадает в список инструментов хода.
    ...(codeIntelligencePort ? { codeIntelligencePort } : {}),
    configuredDefaultModelSelection: {
      options: { reasoningLevel: "disabled" },
      modelId: fixture.modelId,
      providerId: fixture.providerId,
    },
    env: { ...process.env, ZCODE_STORAGE_DIR: join(dirname(configPath), "storage") },
    providerRegistry: createProviderRegistry(modules.provider, fixture),
    runtimeConfig,
    userConfigPath: configPath,
  });
}

export function assertCondition(condition, message, details) {
  if (condition) return;
  const suffix = details === undefined ? "" : `\n${JSON.stringify(details, null, 2)}`;
  throw new Error(`${message}${suffix}`);
}

export function countEventTypes(events) {
  const counts = {};
  for (const event of events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
  }
  return counts;
}

export function openAiToolCall(id, name, input) {
  return { function: { arguments: JSON.stringify(input), name }, id, type: "function" };
}

export function openAiToolCallRawArgs(id, name, rawArguments) {
  return { function: { arguments: rawArguments, name }, id, type: "function" };
}

export function chatCompletion(input) {
  return {
    choices: [
      {
        // Явный finishReason имеет приоритет: именно он несёт признак обрыва по
        // maxOutputTokens (`length`), без которого runtime не отличит усечение
        // аргументов инструмента от обычного невалидного JSON.
        finish_reason: input.finishReason ?? (input.toolCalls ? "tool_calls" : "stop"),
        index: 0,
        message: {
          content: input.content ?? "",
          role: "assistant",
          ...(input.toolCalls ? { tool_calls: input.toolCalls } : {}),
        },
      },
    ],
    created: Math.floor(Date.now() / 1000),
    id: `chatcmpl-${crypto.randomUUID()}`,
    model: input.model,
    object: "chat.completion",
    usage: input.usage ?? {
      completion_tokens: input.completionTokens ?? 20,
      prompt_tokens: input.promptTokens ?? 100,
      total_tokens: (input.promptTokens ?? 100) + (input.completionTokens ?? 20),
    },
  };
}

export function parseRecordBody(record) {
  try {
    return JSON.parse(record?.requestBody ?? "{}");
  } catch {
    return {};
  }
}

export function requestMessages(body) {
  return Array.isArray(body?.messages) ? body.messages : [];
}

export function requestText(body) {
  return JSON.stringify(body?.messages ?? []);
}

export async function cleanupRunRoot(root) {
  await rm(root, { force: true, recursive: true });
}

export async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Собирает результаты инструментов по реальным именам событий сессии.
 * Имена берутся из `SessionEventType`, а не из предположений: `tool_call_result`,
 * `tool_call_scheduled`, `tool_call_started`.
 */
export function collectToolResults(events, SessionEventType) {
  const namesById = new Map();
  for (const event of events) {
    if (
      event.type === SessionEventType.ToolCallScheduled ||
      event.type === SessionEventType.ToolCallStarted
    ) {
      namesById.set(event.payload?.toolCallId, event.payload?.toolName);
    }
  }
  return events
    .filter((event) => event.type === SessionEventType.ToolCallResult)
    .map((event) => {
      const result = event.payload?.result ?? {};
      return {
        content: String(result.content ?? ""),
        output: result.output,
        success: result.success === true,
        toolCallId: event.payload?.toolCallId,
        toolName: namesById.get(event.payload?.toolCallId),
      };
    });
}

/** Ошибки инструментов в той же форме, что и успешные результаты. */
export function collectToolErrors(events, SessionEventType) {
  const namesById = new Map();
  for (const event of events) {
    if (
      event.type === SessionEventType.ToolCallScheduled ||
      event.type === SessionEventType.ToolCallStarted
    ) {
      namesById.set(event.payload?.toolCallId, event.payload?.toolName);
    }
  }
  return events
    .filter((event) => event.type === SessionEventType.ToolCallError)
    .map((event) => ({
      content: String(event.payload?.error?.message ?? ""),
      success: false,
      toolCallId: event.payload?.toolCallId,
      toolName: namesById.get(event.payload?.toolCallId),
    }));
}
