import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  isApiKeyAccess,
  type ModelConfig,
  type ProviderConfig,
  type ProviderConfigLayerSnapshot,
} from "@zcode/provider";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import { ZAI_PROVIDER_ID } from "@zcode/shared";
import type { AppSettings } from "@zcode/shared";
import { desktopAppPaths, ensureAppDataDir } from "./paths.js";

export interface CliConfigSnapshot {
  content: string | null;
}

/**
 * E2E 从 Personal Config 读取的断言快照。
 *
 * 它只描述测试需要观察的字段，不是 Provider 配置事实源，也不参与运行时装配。
 */
export interface E2EModelProviderSnapshot {
  apiFormat: "anthropic-messages" | "openai-chat-completions" | "openai-responses";
  apiKey: string;
  apiKeyRequired?: boolean;
  createdAt: number;
  defaultKind: E2EProviderKind;
  enabled?: boolean;
  endpoints: {
    anthropic?: string;
    baseURL?: string;
    openai?: string;
    paths?: Partial<Record<E2EProviderKind, string>>;
  };
  id: string;
  models: E2EProviderModelSnapshot[];
  name: string;
  source: "custom";
  systemDisabledReason?: string;
  updatedAt: number;
}

export type E2EProviderKind = "anthropic" | "openai" | "openai-compatible";
export type E2EProviderModality = "text" | "image" | "video" | "audio" | "pdf";

export interface E2EProviderModelSnapshot {
  contextWindow: number;
  defaultMaxOutputTokens?: number;
  defaultKind?: E2EProviderKind;
  deleted?: boolean;
  disabledReason?: string;
  id: string;
  kinds: E2EProviderKind[];
  maxOutputTokens?: number;
  modalities: { input: E2EProviderModality[]; output: E2EProviderModality[] };
  name?: string;
  reasoning?: unknown;
  supportsJsonSchemaOutput?: boolean;
  supportsTools?: boolean;
}

export function createE2EProviderModelSnapshot(params: {
  contextWindow?: number;
  defaultMaxOutputTokens?: number;
  defaultKind?: E2EProviderKind;
  id: string;
  kinds?: readonly E2EProviderKind[];
  maxOutputTokens?: number;
  modalities?: {
    input?: readonly E2EProviderModality[];
    output?: readonly E2EProviderModality[];
  };
  supportsJsonSchemaOutput?: boolean;
  supportsTools?: boolean;
}): E2EProviderModelSnapshot {
  return {
    id: params.id,
    kinds: [...new Set(params.kinds ?? [])],
    ...(params.defaultKind ? { defaultKind: params.defaultKind } : {}),
    contextWindow: params.contextWindow ?? 200_000,
    ...(params.defaultMaxOutputTokens === undefined
      ? {}
      : { defaultMaxOutputTokens: params.defaultMaxOutputTokens }),
    ...(params.maxOutputTokens === undefined ? {} : { maxOutputTokens: params.maxOutputTokens }),
    modalities: {
      input: [...new Set<E2EProviderModality>(params.modalities?.input ?? ["text"])],
      output: [...new Set<E2EProviderModality>(params.modalities?.output ?? ["text"])],
    },
    ...(params.supportsTools === undefined ? {} : { supportsTools: params.supportsTools }),
    ...(params.supportsJsonSchemaOutput === undefined
      ? {}
      : { supportsJsonSchemaOutput: params.supportsJsonSchemaOutput }),
  };
}

export function resolveE2EProviderRuntimeBaseUrl(provider: E2EModelProviderSnapshot): string {
  return provider.endpoints.baseURL?.trim().replace(/\/+$/, "") ?? "";
}

const E2E_USER_PROFILE = {
  displayName: "ZCode E2E",
  id: "zcode-e2e-user",
  username: "zcode-e2e-user",
};

export async function readSettings(): Promise<Partial<AppSettings>> {
  try {
    return JSON.parse(
      await readFile(desktopAppPaths.settingsFile, "utf-8"),
    ) as Partial<AppSettings>;
  } catch {
    return {};
  }
}

async function readCliConfig(): Promise<Record<string, unknown>> {
  try {
    const json = JSON.parse(await readFile(desktopAppPaths.cliConfigFile, "utf-8")) as unknown;
    return isRecord(json) ? json : {};
  } catch {
    return {};
  }
}

export async function readModelProviders(): Promise<E2EModelProviderSnapshot[]> {
  const repository = new NodePersonalProviderConfigRepository({
    filePath: desktopAppPaths.configFile,
    pollingIntervalMs: false,
  });
  try {
    return convertPersonalProviderConfig(await repository.read());
  } catch {
    return [];
  } finally {
    repository.dispose();
  }
}

export async function readAgentsState(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(desktopAppPaths.agentsStateFile, "utf-8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

function convertPersonalProviderConfig(
  document: ProviderConfigLayerSnapshot,
): E2EModelProviderSnapshot[] {
  return document.providers.entries().flatMap(([providerId, provider]) => {
    // E2E personal-provider fixture models HTTP endpoints only; local CLI SDKs are runtime-owned.
    if (provider.api?.type === "opencode-sdk" || provider.api?.type === "cursor-cli") return [];
    const now = Date.now();
    const kind = mapPersonalProviderKind(provider);
    return {
      id: providerId,
      name: document.providers.getRule(providerId)?.providerName?.trim() || providerId,
      endpoints: {
        baseURL: provider.api?.baseUrl?.trim() || "",
        paths: { [kind]: "" },
      },
      apiFormat: provider.api?.type ?? "openai-chat-completions",
      apiKeyRequired: true,
      // 套餐手动 Key 同样是 API Key；仅识别普通类型会把已保存凭据误报为空。
      apiKey: isApiKeyAccess(provider.access) ? provider.access.apiKey?.trim() || "" : "",
      defaultKind: kind,
      models: (provider.personalModelIds ?? []).map((modelId) =>
        convertPersonalModelConfig(
          modelId,
          document.models.resolve({
            providerId,
            modelId,
            apiType: provider.api?.type,
            baseUrl: provider.api?.baseUrl,
          }),
          kind,
        ),
      ),
      source: "custom" as const,
      createdAt: now,
      updatedAt: now,
    };
  });
}

function convertPersonalModelConfig(
  modelId: string,
  model: ModelConfig,
  defaultKind: E2EProviderKind,
) {
  const properties = model.properties;
  const input: E2EProviderModality[] = ["text"];
  if (properties?.inputFormat?.supportsImage) input.push("image");
  if (properties?.inputFormat?.supportsAudio) input.push("audio");
  if (properties?.inputFormat?.supportsPdf) input.push("pdf");
  if (properties?.inputFormat?.supportsVideo) input.push("video");
  return createE2EProviderModelSnapshot({
    id: modelId,
    kinds: [defaultKind],
    defaultKind,
    contextWindow: properties?.contextWindow ?? undefined,
    defaultMaxOutputTokens: model.optionSpecs?.maxOutputTokens?.max ?? undefined,
    maxOutputTokens: model.optionSpecs?.maxOutputTokens?.max ?? undefined,
    modalities: { input, output: ["text"] },
    supportsTools: properties?.supportsToolCall ?? undefined,
    supportsJsonSchemaOutput: properties?.supportsJsonSchemaOutput ?? undefined,
  });
}

function mapPersonalProviderKind(provider: ProviderConfig): E2EProviderKind {
  switch (provider.api?.type) {
    case "opencode-sdk":
    case "cursor-cli":
      return "openai-compatible";
    case "anthropic-messages":
      return "anthropic";
    case "openai-responses":
      return "openai";
    case "openai-chat-completions":
    case null:
    case undefined:
      return "openai-compatible";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mergeRecord(
  current: Record<string, unknown>,
  partial: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(partial)) {
    const existing = next[key];
    next[key] = isRecord(existing) && isRecord(value) ? mergeRecord(existing, value) : value;
  }
  return next;
}

export async function readModelProvider(
  providerId: string,
): Promise<E2EModelProviderSnapshot | null> {
  const providers = await readModelProviders();
  return providers.find((provider) => provider.id === providerId) ?? null;
}

export async function seedSettings(partial: Partial<AppSettings>): Promise<Partial<AppSettings>> {
  const current = await readSettings();
  const next = { ...current, ...partial };
  await ensureAppDataDir();
  await writeFile(desktopAppPaths.settingsFile, JSON.stringify(next), "utf-8");
  return next;
}

export async function seedCliConfig(
  partial: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const current = await readCliConfig();
  const next = mergeRecord(current, partial);
  await mkdir(dirname(desktopAppPaths.cliConfigFile), { recursive: true });
  await writeFile(desktopAppPaths.cliConfigFile, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

export async function snapshotCliConfig(): Promise<CliConfigSnapshot> {
  try {
    return { content: await readFile(desktopAppPaths.cliConfigFile, "utf-8") };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { content: null };
    }
    throw error;
  }
}

export async function restoreCliConfig(snapshot: CliConfigSnapshot): Promise<void> {
  // 修复原因：seedCliConfig 写的是隔离 HOME 下的 CLI 全局配置；只清 ~/.zcode/v2
  // 会让 WebFetch 临时代理留到同一 E2E session 后续步骤，必须恢复文件级快照。
  if (snapshot.content === null) {
    await rm(desktopAppPaths.cliConfigFile, { force: true });
    return;
  }

  await mkdir(dirname(desktopAppPaths.cliConfigFile), { recursive: true });
  await writeFile(desktopAppPaths.cliConfigFile, snapshot.content, "utf-8");
}

/** 仅用于旧 Electron 已退出后的 fixture 注入；删除指定测试凭据，保留登录与其他键。 */
export async function removeSeededCredentials(keys: string[]): Promise<void> {
  const credentials = JSON.parse(
    await readFile(desktopAppPaths.credentialsFile, "utf-8"),
  ) as Record<string, string>;
  for (const key of keys) delete credentials[key];
  await writeFile(desktopAppPaths.credentialsFile, JSON.stringify(credentials), "utf-8");
}

export async function seedCredentials(authToken = "mock-token") {
  await ensureAppDataDir();
  // Bugfix: 登录恢复已经迁移到 OAuth 命名空间；只写旧 auth_token
  // 会让 e2e 在欢迎页等待 workspace，录制 provider 流之前就失败。
  await writeFile(
    desktopAppPaths.credentialsFile,
    JSON.stringify(
      {
        auth_token: authToken,
        "oauth:active_provider": ZAI_PROVIDER_ID,
        [`oauth:${ZAI_PROVIDER_ID}:access_token`]: authToken,
        [`oauth:${ZAI_PROVIDER_ID}:user_info`]: JSON.stringify(E2E_USER_PROFILE),
        zcodejwttoken: authToken,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function isMissingFileError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
