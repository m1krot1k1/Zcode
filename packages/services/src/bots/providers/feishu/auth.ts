import { fetchBotProviderJson } from "#src/bots/providers/providerRequest.js";
import type { BotConfig } from "@zcode/shared";
import { getFeishuBaseUrl, getFeishuDomainProvider, type FeishuProviderDeps } from "./common.js";

interface FeishuAccessTokenResponse {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

interface FeishuAppInfoResponse {
  code?: number;
  msg?: string;
  data?: {
    app?: {
      app_name?: string;
      primary_language?: string;
      i18n?: Array<{
        i18n_key?: string;
        name?: string;
      }>;
    };
  };
}

interface FeishuUserInfoResponse {
  code?: number;
  msg?: string;
  data?: {
    user?: {
      name?: string;
      en_name?: string;
      nickname?: string;
    };
  };
}

const accessTokenCache = new Map<string, { token: string; expiresAt: number }>();
const userDisplayNameCache = new Map<string, { name: string | null; expiresAt: number }>();
export async function readTenantAccessToken(
  bot: BotConfig,
  deps: FeishuProviderDeps,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!bot.feishuAppId || !bot.credentialRef) {
    return null;
  }
  const appSecret = await deps.loadCredential(bot.credentialRef);
  if (!appSecret) {
    return null;
  }
  const cacheKey = `${getFeishuDomainProvider(bot)}:${bot.feishuAppId}:${bot.credentialRef}`;
  const cached = accessTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }
  const requestedAt = Date.now();
  const response = await fetchBotProviderJson<FeishuAccessTokenResponse>(
    `${getFeishuBaseUrl(bot)}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        app_id: bot.feishuAppId,
        app_secret: appSecret,
      }),
      signal,
    },
  );
  if (!response.ok) {
    throw new Error(`Feishu tenant_access_token failed: HTTP ${response.status}`);
  }
  const payload = response.payload ?? {};
  if (payload.code !== 0 || !payload.tenant_access_token) {
    throw new Error(payload.msg || "Feishu tenant_access_token failed.");
  }
  // 飞书可能返回尚未过期的旧令牌；固定缓存 90 分钟会超过其真实剩余有效期。
  // 从请求开始计时，避免网络耗时被错误计入令牌的可用时间。
  if (typeof payload.expire === "number" && Number.isFinite(payload.expire) && payload.expire > 0) {
    accessTokenCache.set(cacheKey, {
      token: payload.tenant_access_token,
      expiresAt: requestedAt + payload.expire * 1_000,
    });
  } else {
    accessTokenCache.delete(cacheKey);
  }
  return payload.tenant_access_token;
}

function resolveFeishuAppDisplayName(payload: FeishuAppInfoResponse): string | null {
  const app = payload.data?.app;
  const appName = app?.app_name?.trim();
  if (appName) {
    return appName;
  }
  const primaryLanguage = app?.primary_language?.trim();
  const primaryI18nName = app?.i18n
    ?.find((item) => item.i18n_key === primaryLanguage)
    ?.name?.trim();
  if (primaryI18nName) {
    return primaryI18nName;
  }
  return app?.i18n?.find((item) => item.name?.trim())?.name?.trim() ?? null;
}

async function fetchFeishuAppDisplayName(
  bot: BotConfig,
  token: string,
  appId: string,
): Promise<string | null> {
  const response = await fetchBotProviderJson<FeishuAppInfoResponse>(
    `${getFeishuBaseUrl(bot)}/open-apis/application/v6/applications/${appId}?lang=zh_cn`,
    {
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Feishu get application info failed app=${appId}: HTTP ${response.status}`);
  }
  const payload = response.payload ?? {};
  if (payload.code !== 0) {
    throw new Error(payload.msg || `Feishu get application info failed app=${appId}.`);
  }
  return resolveFeishuAppDisplayName(payload);
}

export async function readFeishuAppDisplayName(
  bot: BotConfig,
  deps: FeishuProviderDeps,
): Promise<string | null> {
  if (!bot.feishuAppId) {
    return null;
  }
  const token = await readTenantAccessToken(bot, deps);
  if (!token) {
    return null;
  }
  let appIdError: unknown;
  try {
    const appName = await fetchFeishuAppDisplayName(bot, token, bot.feishuAppId);
    if (appName?.trim()) {
      return appName;
    }
  } catch (error) {
    appIdError = error;
  }
  try {
    // Bugfix: 飞书 / Lark 扫码创建后 app_id 路径可能因为权限或同步延迟暂不可读；me 路径更适合读取当前应用名称。
    return await fetchFeishuAppDisplayName(bot, token, "me");
  } catch (error) {
    throw appIdError ?? error;
  }
}

function resolveFeishuUserIdType(userId: string): "open_id" | "union_id" | "user_id" {
  if (userId.startsWith("ou_")) {
    return "open_id";
  }
  if (userId.startsWith("on_")) {
    return "union_id";
  }
  return "user_id";
}

function resolveFeishuUserDisplayName(payload: FeishuUserInfoResponse): string | null {
  const user = payload.data?.user;
  return user?.name?.trim() || user?.en_name?.trim() || user?.nickname?.trim() || null;
}

export async function readFeishuUserDisplayName(
  bot: BotConfig,
  deps: FeishuProviderDeps,
  userId: string,
): Promise<string | null> {
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) {
    return null;
  }
  const cacheKey = `${getFeishuDomainProvider(bot)}:${bot.feishuAppId ?? ""}:${bot.credentialRef ?? ""}:${trimmedUserId}`;
  const cached = userDisplayNameCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.name;
  }
  const token = await readTenantAccessToken(bot, deps);
  if (!token) {
    return null;
  }
  const userIdType = resolveFeishuUserIdType(trimmedUserId);
  const response = await fetchBotProviderJson<FeishuUserInfoResponse>(
    `${getFeishuBaseUrl(bot)}/open-apis/contact/v3/users/${encodeURIComponent(trimmedUserId)}?user_id_type=${userIdType}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Feishu get user info failed user=${trimmedUserId}: HTTP ${response.status}`);
  }
  const payload = response.payload ?? {};
  if (payload.code !== 0) {
    throw new Error(payload.msg || `Feishu get user info failed user=${trimmedUserId}.`);
  }
  const name = resolveFeishuUserDisplayName(payload);
  // Bugfix: 飞书消息事件只稳定携带 sender_id，不携带发送者名称。
  // 这里缓存通讯录查询结果，避免同一个用户连续发消息时每条都请求 contact API。
  userDisplayNameCache.set(cacheKey, {
    name,
    expiresAt: Date.now() + 10 * 60_000,
  });
  return name;
}

export async function readFeishuAppSecret(
  bot: BotConfig,
  deps: FeishuProviderDeps,
): Promise<string | null> {
  if (!bot.feishuAppId || !bot.credentialRef) {
    return null;
  }
  return deps.loadCredential(bot.credentialRef);
}
