import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  ZCodeUncensoredGetConfigResult,
  ZCodeUncensoredModelEntry,
  ZCodeUncensoredProviderConfig,
  ZCodeUncensoredProviderStatus,
  ZCodeUncensoredProviderWrite,
  ZCodeUncensoredSettingsStatus,
  ZCodeUncensoredSettingsWrite,
} from "@zcode/shared";
import { getZCodeDataRootDir } from "../paths.js";
import type {
  UncensoredSettingsStore,
  UncensoredSettingsWorkspace,
} from "./contract.js";
import { workspaceKeyOf } from "./worker/workspaceIdentity.js";

/**
 * Настройки нецензурированных провайдеров для перехвата отказанных пунктов задачи.
 *
 * Владелец состояния — этот файл (`<indexRootDir>/uncensored-settings.json`) плюс
 * `ICredentialService` для секретов. Секреты никогда не пишутся в JSON, не
 * возвращаются статусом и не попадают в логи: наружу отдаётся только флаг
 * `apiKeyConfigured` на провайдера. Запись — единственный путь: полный снимок
 * workspace-ключа сериализуется во временный файл в том же каталоге и заменяет
 * целевой через `rename` под module-level очередью.
 */

export const UNCENSORED_SETTINGS_FILE = "uncensored-settings.json";

export type { UncensoredSettingsStore, UncensoredSettingsWorkspace };

/** Минимальная поверхность `ICredentialService`, нужная хранилищу. */
export interface UncensoredCredentialStore {
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface UncensoredSettingsStoreOptions {
  /**
   * Корень code intelligence: `<root>/uncensored-settings.json`.
   * По умолчанию совпадает с сервисом индекса (`<dataRoot>/code-intelligence`),
   * чтобы настройки и индекс всегда жили рядом; cwd-фолбэка нет.
   */
  indexRootDir?: string;
  credentialStore?: UncensoredCredentialStore;
}

export const MAX_UNCENSORED_PROVIDERS = 20;
export const MAX_UNCENSORED_MODELS = 50;
const MAX_API_KEY_LENGTH = 4096;
const MAX_PROVIDER_ID_LENGTH = 128;
const MAX_PROVIDER_NAME_LENGTH = 200;
const MAX_API_URL_LENGTH = 2048;

export function uncensoredCredentialKey(workspaceKey: string, providerId: string): string {
  return `code-intelligence:${workspaceKey}:uncensored-api-key:${providerId}`;
}

function providersKey(workspaceKey: string): string {
  return `uncensored:${workspaceKey}:providers`;
}

/**
 * Очередь по абсолютному пути файла: read-modify-write одного файла из двух
 * параллельных вызовов иначе теряет записи других workspace. Очередь module-level,
 * поэтому два экземпляра хранилища на один каталог тоже сериализуются.
 */
const writeQueues = new Map<string, Promise<unknown>>();

function enqueueFileWrite<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const key = resolve(filePath);
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  const tracked = next.catch(() => undefined);
  writeQueues.set(key, tracked);
  void tracked.finally(() => {
    if (writeQueues.get(key) === tracked) writeQueues.delete(key);
  });
  return next;
}

async function readJsonFile(filePath: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") values[key] = value;
    }
    return values;
  } catch {
    // Битый/отсутствующий файл — не ошибка: настройки по умолчанию.
    return {};
  }
}

async function writeJsonFileAtomic(
  filePath: string,
  values: Record<string, string>,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(values, null, 2)}\n`, "utf8");
    // rename в том же каталоге атомарен: частично записанный файл не наблюдаем.
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function validateApiUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Uncensored provider API URL is required.");
  }
  const raw = value.trim();
  if (raw.length > MAX_API_URL_LENGTH) {
    throw new Error("Uncensored provider API URL is too long.");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Uncensored provider API URL must be an absolute http(s) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Uncensored provider API URL must use http or https.");
  }
  if (!parsed.hostname) {
    throw new Error("Uncensored provider API URL must include a host.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Uncensored provider API URL must not include user credentials.");
  }
  if (parsed.search) {
    throw new Error("Uncensored provider API URL must not include a query string.");
  }
  if (parsed.hash) {
    throw new Error("Uncensored provider API URL must not include a fragment.");
  }
  if (!parsed.pathname || parsed.pathname === "/") {
    throw new Error("Uncensored provider API URL must include a non-root path.");
  }
  // Значение используется как есть: /v1 и /chat/completions не дописываются.
  return raw;
}

function validateProviderId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) throw new Error("Uncensored provider id must be a non-empty string.");
  if (id.length > MAX_PROVIDER_ID_LENGTH) {
    throw new Error("Uncensored provider id is too long.");
  }
  return id;
}

function validateProviderName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new Error("Uncensored provider name must be a non-empty string.");
  if (name.length > MAX_PROVIDER_NAME_LENGTH) {
    throw new Error("Uncensored provider name is too long.");
  }
  return name;
}

function validateModels(value: unknown): ZCodeUncensoredModelEntry[] {
  if (!Array.isArray(value)) throw new Error("Uncensored models must be an array.");
  if (value.length > MAX_UNCENSORED_MODELS) {
    throw new Error(`At most ${MAX_UNCENSORED_MODELS} uncensored models are allowed per provider.`);
  }
  const seen = new Set<string>();
  const models: ZCodeUncensoredModelEntry[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      throw new Error("Each uncensored model must be an object.");
    }
    const record = entry as { id?: unknown; enabled?: unknown };
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) throw new Error("Uncensored model id must be a non-empty string.");
    if (id.length > 256) throw new Error("Uncensored model id is too long.");
    if (typeof record.enabled !== "boolean") {
      throw new Error(`Uncensored model ${id} must have a boolean enabled flag.`);
    }
    if (seen.has(id)) throw new Error(`Duplicate uncensored model id: ${id}`);
    seen.add(id);
    models.push({ id, enabled: record.enabled });
  }
  return models;
}

function validateProviders(value: unknown): ZCodeUncensoredProviderWrite[] {
  if (!Array.isArray(value)) throw new Error("Uncensored providers must be an array.");
  if (value.length > MAX_UNCENSORED_PROVIDERS) {
    throw new Error(`At most ${MAX_UNCENSORED_PROVIDERS} uncensored providers are allowed.`);
  }
  const seen = new Set<string>();
  const providers: ZCodeUncensoredProviderWrite[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      throw new Error("Each uncensored provider must be an object.");
    }
    const record = entry as {
      id?: unknown;
      name?: unknown;
      apiUrl?: unknown;
      apiKey?: unknown;
      models?: unknown;
    };
    const id = validateProviderId(record.id);
    if (seen.has(id)) throw new Error(`Duplicate uncensored provider id: ${id}`);
    seen.add(id);
    const provider: ZCodeUncensoredProviderWrite = {
      id,
      name: validateProviderName(record.name),
      apiUrl: validateApiUrl(record.apiUrl),
      models: validateModels(record.models),
    };
    if (record.apiKey === null) {
      provider.apiKey = null;
    } else if (typeof record.apiKey === "string") {
      provider.apiKey = record.apiKey;
    } else if (record.apiKey !== undefined) {
      throw new Error("Uncensored API key must be a string or null.");
    }
    providers.push(provider);
  }
  return providers;
}

function parseStoredModels(raw: unknown): ZCodeUncensoredModelEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const models: ZCodeUncensoredModelEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { id?: unknown; enabled?: unknown };
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id || typeof record.enabled !== "boolean" || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, enabled: record.enabled });
    if (models.length >= MAX_UNCENSORED_MODELS) break;
  }
  return models;
}

function parseStoredProviders(raw: string | undefined): ZCodeUncensoredProviderStatus[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const providers: ZCodeUncensoredProviderStatus[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as {
        id?: unknown;
        name?: unknown;
        apiUrl?: unknown;
        apiKeyConfigured?: unknown;
        models?: unknown;
      };
      const id = typeof record.id === "string" ? record.id.trim() : "";
      const name = typeof record.name === "string" ? record.name.trim() : "";
      const apiUrl = typeof record.apiUrl === "string" ? record.apiUrl.trim() : "";
      if (!id || !name || !apiUrl || seen.has(id)) continue;
      seen.add(id);
      providers.push({
        id,
        name,
        apiUrl,
        apiKeyConfigured: record.apiKeyConfigured === true,
        models: parseStoredModels(record.models),
      });
      if (providers.length >= MAX_UNCENSORED_PROVIDERS) break;
    }
    return providers;
  } catch {
    return [];
  }
}

type ApiKeyAction = { kind: "keep" } | { kind: "delete" } | { kind: "save"; value: string };

function resolveApiKeyWrite(value: string | null | undefined): ApiKeyAction {
  if (value === undefined) return { kind: "keep" };
  if (value === null) return { kind: "delete" };
  if (typeof value !== "string") {
    throw new Error("Uncensored API key must be a string or null.");
  }
  const trimmed = value.trim();
  // Пустая строка = сохранить текущий секрет.
  if (!trimmed) return { kind: "keep" };
  if (trimmed.length > MAX_API_KEY_LENGTH || trimmed.includes("\r") || trimmed.includes("\n")) {
    throw new Error("Uncensored API key has an invalid format.");
  }
  return { kind: "save", value: trimmed };
}

function defaultStatus(): ZCodeUncensoredSettingsStatus {
  return { providers: [] };
}

export function createUncensoredSettingsStore(
  options: UncensoredSettingsStoreOptions = {},
): UncensoredSettingsStore {
  const indexRootDir =
    options.indexRootDir ?? join(getZCodeDataRootDir(), "code-intelligence");
  const filePath = join(indexRootDir, UNCENSORED_SETTINGS_FILE);
  const credentialStore = options.credentialStore;

  async function read(
    workspace: UncensoredSettingsWorkspace,
  ): Promise<ZCodeUncensoredSettingsStatus> {
    const workspaceKey = workspaceKeyOf(workspace);
    const values = await readJsonFile(filePath);
    return { providers: parseStoredProviders(values[providersKey(workspaceKey)]) };
  }

  async function write(
    workspace: UncensoredSettingsWorkspace,
    input: ZCodeUncensoredSettingsWrite,
  ): Promise<ZCodeUncensoredSettingsStatus> {
    const workspaceKey = workspaceKeyOf(workspace);
    const key = providersKey(workspaceKey);
    const providers = validateProviders(input.providers);

    return enqueueFileWrite(filePath, async () => {
      // Read-modify-write внутри очереди: записи других workspace сохраняются.
      const values = await readJsonFile(filePath);
      const previous = parseStoredProviders(values[key]);
      const nextIds = new Set(providers.map((provider) => provider.id));

      // Удалённые провайдеры не должны оставлять висячие секреты.
      for (const provider of previous) {
        if (nextIds.has(provider.id)) continue;
        await credentialStore
          ?.delete(uncensoredCredentialKey(workspaceKey, provider.id))
          .catch(() => undefined);
      }

      const stored: ZCodeUncensoredProviderStatus[] = [];
      for (const provider of providers) {
        const apiKeyAction = resolveApiKeyWrite(provider.apiKey);
        if (apiKeyAction.kind === "save" && !credentialStore) {
          throw new Error("Secure credential storage is unavailable.");
        }
        const previousProvider = previous.find((entry) => entry.id === provider.id);
        if (apiKeyAction.kind === "save") {
          await credentialStore!.save(
            uncensoredCredentialKey(workspaceKey, provider.id),
            apiKeyAction.value,
          );
        } else if (apiKeyAction.kind === "delete") {
          await credentialStore
            ?.delete(uncensoredCredentialKey(workspaceKey, provider.id))
            .catch(() => undefined);
        }
        const apiKeyConfigured =
          apiKeyAction.kind === "save"
            ? true
            : apiKeyAction.kind === "delete"
              ? false
              : (previousProvider?.apiKeyConfigured ?? false);
        stored.push({
          id: provider.id,
          name: provider.name,
          apiUrl: provider.apiUrl,
          apiKeyConfigured,
          models: provider.models,
        });
      }

      if (stored.length === 0) {
        delete values[key];
      } else {
        values[key] = JSON.stringify(stored);
      }
      await writeJsonFileAtomic(filePath, values);
      return { providers: stored };
    });
  }

  async function readTakeoverConfig(
    workspace: UncensoredSettingsWorkspace,
  ): Promise<ZCodeUncensoredGetConfigResult> {
    const status = await read(workspace);
    if (!credentialStore) {
      return {
        providers: status.providers.map(
          (provider): ZCodeUncensoredProviderConfig => ({
            id: provider.id,
            name: provider.name,
            apiUrl: provider.apiUrl,
            apiKey: null,
            models: provider.models,
          }),
        ),
      };
    }
    const workspaceKey = workspaceKeyOf(workspace);
    const providers: ZCodeUncensoredProviderConfig[] = [];
    for (const provider of status.providers) {
      const stored = await credentialStore
        .load(uncensoredCredentialKey(workspaceKey, provider.id))
        .catch(() => null);
      providers.push({
        id: provider.id,
        name: provider.name,
        apiUrl: provider.apiUrl,
        apiKey: stored && stored.length > 0 ? stored : null,
        models: provider.models,
      });
    }
    return { providers };
  }

  return { read, write, readTakeoverConfig };
}
