import { createServiceLogger } from "../logger/serviceLogger.js";
import type {
  UncensoredChatInput,
  UncensoredChatResult,
  UncensoredSettingsService,
  UncensoredSettingsStorePort,
  UncensoredSettingsWorkspace,
} from "./contract.js";

/**
 * Сервис — тонкая обёртка над единственным владельцем состояния — файловым
 * хранилищем code intelligence. Он не держит копию настроек, не читает credential
 * store для статуса и не отдаёт секрет: композиционный корень (`node/features.ts`)
 * связывает его с `createUncensoredSettingsStore`, а host-only store отдельно
 * передаётся обработчику `uncensored/getConfig`.
 */

export interface UncensoredSettingsServiceOptions {
  store: UncensoredSettingsStorePort;
  /** Injectable for tests; production uses the Host's global fetch. */
  fetch?: typeof fetch;
}

const CHAT_TIMEOUT_MS = 60_000;
const CHAT_MAX_TOKENS = 4096;
const CHAT_MAX_INPUT_CHARS = 32_000;

function summarizeSettingsError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Ошибки валидации называют поле, но не секрет. Остальные ошибки сворачиваем,
  // чтобы исключить случайное попадание credential material в лог.
  return message.startsWith("Uncensored") ||
    message.startsWith("At most") ||
    message.startsWith("Duplicate") ||
    message.startsWith("Each")
    ? message
    : "uncensored settings write failed";
}

export function createUncensoredSettingsService(
  options: UncensoredSettingsServiceOptions,
): UncensoredSettingsService {
  const logger = createServiceLogger("uncensored-settings");
  const { store } = options;
  const fetchImpl = options.fetch ?? fetch;

  return {
    getConfig: (workspace) => store.read(workspace),

    async updateConfig(workspace, write) {
      try {
        const status = await store.write(workspace, write);
        logger.info(undefined, "Uncensored settings updated", {
          providerCount: status.providers.length,
          modelCount: status.providers.reduce((total, provider) => total + provider.models.length, 0),
          configuredKeyCount: status.providers.filter((provider) => provider.apiKeyConfigured)
            .length,
        });
        return status;
      } catch (error) {
        logger.warn(undefined, "Uncensored settings update rejected", {
          reason: summarizeSettingsError(error),
        });
        throw error;
      }
    },

    async sendMessage(
      workspace: UncensoredSettingsWorkspace,
      input: UncensoredChatInput,
    ): Promise<UncensoredChatResult> {
      const text = input.text.trim();
      if (!text) return { ok: false, error: "empty-message" };
      if (text.length > CHAT_MAX_INPUT_CHARS) return { ok: false, error: "message-too-long" };

      let config;
      try {
        config = await store.readTakeoverConfig(workspace);
      } catch {
        return { ok: false, error: "config" };
      }
      const provider = config.providers.find((candidate) => candidate.id === input.providerId);
      if (!provider) return { ok: false, error: "provider-not-found" };
      if (!provider.models.some((model) => model.id === input.modelId)) {
        return { ok: false, error: "model-not-found" };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (provider.apiKey && provider.apiKey.trim().length > 0) {
          headers.Authorization = `Bearer ${provider.apiKey}`;
        }
        const response = await fetchImpl(provider.apiUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: input.modelId,
            messages: [{ role: "user", content: text }],
            max_tokens: CHAT_MAX_TOKENS,
            stream: false,
          }),
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok) return { ok: false, error: `http-${response.status}` };
        const body = (await response.json()) as {
          choices?: Array<{ message?: { content?: unknown } }>;
        };
        const content = body.choices?.[0]?.message?.content;
        if (typeof content !== "string" || content.trim().length === 0) {
          return { ok: false, error: "empty-content" };
        }
        logger.info(undefined, "Uncensored chat completed", {
          providerId: provider.id,
          modelId: input.modelId,
          chars: content.length,
        });
        return { ok: true, text: content };
      } catch {
        return { ok: false, error: controller.signal.aborted ? "timeout" : "network" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
