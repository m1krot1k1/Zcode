import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EmbeddingProvider } from "./contract.js";
import { validateEmbeddingConfig, type EmbeddingConfig } from "./embeddings.js";

/**
 * Настройки провайдера эмбеддингов.
 *
 * Секрет (API-ключ) живёт только в `ICredentialService` под ключом, производным от
 * identity-workspace; в индексе и статусе остаётся лишь флаг `apiKeyConfigured`.
 * Это правило сохранено из v1: провайдерские секреты не должны попадать в индексные данные.
 */

export interface EmbeddingCredentialStore {
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface StoredEmbeddingSettings {
  provider?: EmbeddingProvider;
  endpoint?: string;
  model?: string;
  apiKeyConfigured?: boolean;
}

type SetEmbeddingConfigParams = {
  provider?: EmbeddingProvider | null;
  endpoint?: string | null;
  model?: string | null;
  apiKey?: string | null;
};

export function embeddingCredentialKey(workspaceKey: string): string {
  return `code-intelligence:${workspaceKey}:embedding-api-key`;
}

interface SettingsBackend {
  read(key: string): Promise<string | undefined>;
  write(key: string, value: string): Promise<void>;
  remove(keys: readonly string[]): Promise<void>;
}

async function readJsonFile(filePath: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

async function writeJsonFile(filePath: string, values: Record<string, string>): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(values, null, 2)}\n`, "utf8");
}

/**
 * Файловое хранилище настроек рядом с индексом.
 * Крошечный JSON без секретов: контракт запрещает держать настройки внутри индекса.
 */
function createFileBackend(settingsFile: string): SettingsBackend {
  return {
    async read(key) {
      const values = await readJsonFile(settingsFile);
      return values[key];
    },
    async write(key, value) {
      const values = await readJsonFile(settingsFile);
      values[key] = value;
      await writeJsonFile(settingsFile, values);
    },
    async remove(keys) {
      const values = await readJsonFile(settingsFile);
      let changed = false;
      for (const key of keys) {
        if (key in values) {
          delete values[key];
          changed = true;
        }
      }
      if (changed) await writeJsonFile(settingsFile, values);
    },
  };
}

let backendOverride: SettingsBackend | undefined;

/** Тестовый seam: подмена файлового хранилища настроек. */
export function setEmbeddingSettingsBackend(next: SettingsBackend | undefined): void {
  backendOverride = next;
}

function settingsKey(workspaceKey: string, name: string): string {
  return `embedding:${workspaceKey}:${name}`;
}

function resolveBackend(indexRootDir: string): SettingsBackend {
  if (backendOverride) return backendOverride;
  const root =
    indexRootDir || process.env.ZCODE_CODE_INDEX_ROOT || join(process.cwd(), ".zcode-code-index");
  return createFileBackend(join(root, "embedding-settings.json"));
}

export async function readEmbeddingSettings(
  credentialService: EmbeddingCredentialStore | undefined,
  workspaceKey: string,
  indexRootDir = "",
): Promise<StoredEmbeddingSettings> {
  const store = resolveBackend(indexRootDir);
  const [provider, endpoint, model, apiKeyFlag] = await Promise.all([
    store.read(settingsKey(workspaceKey, "provider")),
    store.read(settingsKey(workspaceKey, "endpoint")),
    store.read(settingsKey(workspaceKey, "model")),
    store.read(settingsKey(workspaceKey, "apiKeyConfigured")),
  ]);
  const storedCredential = await credentialService?.load(embeddingCredentialKey(workspaceKey));
  return {
    ...(provider === "ollama" || provider === "openai-compatible" ? { provider } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(model ? { model } : {}),
    // Флаг присутствует всегда: `undefined` неотличим от «неизвестно» и скрывал факт
    // снятия ключа, из-за чего UI продолжал показывать сохранённый токен.
    apiKeyConfigured: apiKeyFlag === "true" || Boolean(storedCredential),
  };
}

export async function writeEmbeddingSettings(
  credentialService: EmbeddingCredentialStore | undefined,
  workspaceKey: string,
  params: SetEmbeddingConfigParams,
  indexRootDir = "",
): Promise<StoredEmbeddingSettings> {
  const store = resolveBackend(indexRootDir);
  const previous = await readEmbeddingSettings(credentialService, workspaceKey, indexRootDir);
  const cleared = params.provider === null || params.endpoint === null || params.model === null;

  let apiKey: string | null | undefined;
  if (typeof params.apiKey === "string") {
    const trimmed = params.apiKey.trim();
    if (trimmed && (trimmed.length > 4096 || trimmed.includes("\r") || trimmed.includes("\n"))) {
      throw new Error("Embedding API key has an invalid format.");
    }
    apiKey = trimmed || undefined;
  } else if (params.apiKey === null) {
    apiKey = null;
  }
  if (typeof apiKey === "string" && !credentialService)
    throw new Error("Secure credential storage is unavailable.");

  const nextEndpoint = cleared
    ? undefined
    : params.endpoint === undefined
      ? previous.endpoint
      : params.endpoint;
  const nextModel = cleared
    ? undefined
    : params.model === undefined
      ? previous.model
      : params.model;
  const nextProvider = cleared
    ? undefined
    : params.provider === undefined
      ? (previous.provider ?? "ollama")
      : params.provider;

  if (cleared) {
    await store.remove([
      settingsKey(workspaceKey, "provider"),
      settingsKey(workspaceKey, "endpoint"),
      settingsKey(workspaceKey, "model"),
      settingsKey(workspaceKey, "apiKeyConfigured"),
    ]);
  } else if (nextEndpoint && nextModel) {
    const config: EmbeddingConfig = validateEmbeddingConfig(nextProvider, nextEndpoint, nextModel);
    if (config.provider && config.endpoint && config.model) {
      await store.write(settingsKey(workspaceKey, "provider"), config.provider);
      await store.write(settingsKey(workspaceKey, "endpoint"), config.endpoint);
      await store.write(settingsKey(workspaceKey, "model"), config.model);
    }
  }

  if (apiKey === null) {
    await credentialService?.delete(embeddingCredentialKey(workspaceKey));
    await store.write(settingsKey(workspaceKey, "apiKeyConfigured"), "false");
  } else if (typeof apiKey === "string") {
    await credentialService!.save(embeddingCredentialKey(workspaceKey), apiKey);
    await store.write(settingsKey(workspaceKey, "apiKeyConfigured"), "true");
  }

  return readEmbeddingSettings(credentialService, workspaceKey, indexRootDir);
}
