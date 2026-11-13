import {
  BIGMODEL_PROVIDER_ID,
  isCredentialDecryptError,
  resolveJwtExpiration,
  ZAI_PROVIDER_ID,
  type OAuthCachedSessionRestoreResult,
  type OAuthProviderId,
  type OAuthTokenSet,
  type OAuthUserProfile,
  type UserInfo,
} from "@zcode/shared";
import { refreshLegacyBigModelCachedProfile } from "../oauthProfileSchema.js";
import { log, serviceLog } from "./logging.js";
import { cancelPending } from "./pendingFlow.js";
import { notifyProviderLogout, runSessionMutation, runWithAdapterError } from "./runtime.js";
import { isSameOAuthProfile, toUserInfo } from "./support.js";
import { ZCODE_JWT_TOKEN_KEY, type OAuthServiceRuntime } from "./types.js";

export async function restoreCachedSession(runtime: OAuthServiceRuntime): Promise<UserInfo | null> {
  const result = await restoreCachedSessionState(runtime);
  return result.status === "authenticated" ? result.userInfo : null;
}

export async function restoreCachedSessionState(
  runtime: OAuthServiceRuntime,
): Promise<OAuthCachedSessionRestoreResult> {
  const restoreGeneration = runtime.oauthSessionGeneration;
  const activeProvider = await runtime.repo.getActiveProvider();
  if (!activeProvider) {
    log("restoreCachedSession skipped: no active provider");
    return { status: "signed-out" };
  }

  const adapter = runtime.adapters.get(activeProvider);
  if (!adapter || !adapter.meta.enabled) {
    log(
      "restoreCachedSession aborted: provider unavailable, clearing active provider:",
      activeProvider,
    );
    await runtime.repo.setActiveProvider(null);
    return { status: "signed-out" };
  }

  const profile = await runtime.repo.loadActiveUserProfile();
  if (!profile) {
    // zai / bigmodel 这类 OAuth token 生命周期很短，启动时如果强依赖远端 userinfo 校验，
    // 用户明明刚登录过，也会因为 access_token 过期被误判成未登录。
    // 这里改为优先读取登录成功时持久化的 user_info，只要用户没有手动退出，就按缓存恢复展示态。
    log("restoreCachedSession skipped: missing cached user profile:", activeProvider);
    return { status: "signed-out" };
  }

  // 业务 JWT 过期而共享 JWT 仍有效时，旧实现会恢复伪登录态；直接读两个凭据做本地检查，
  // 不调用 loadActiveTokenSet，避免把后台 profile 迁移或网络请求带回首屏恢复链路。
  let tokens: { key: string; value: string }[];
  try {
    tokens = await Promise.all(
      [ZCODE_JWT_TOKEN_KEY, `oauth:${activeProvider}:access_token`].map(async (key) => ({
        key,
        value: (await runtime.credentialService.load(key))?.trim() ?? "",
      })),
    );
  } catch (error) {
    if (!isCredentialDecryptError(error)) throw error;
    const cleared = await runSessionMutation(runtime, async () => {
      // 损坏凭据清理也是会话写入；旧恢复须在队列内重读，不能删除已提交的新登录。
      if (runtime.oauthSessionGeneration !== restoreGeneration) return false;
      const currentTokens = await runtime.repo.loadCachedSessionTokens(activeProvider);
      if (currentTokens !== null) return false;
      runtime.oauthSessionGeneration += 1;
      return true;
    });
    return cleared ? { status: "signed-out" } : restoreCachedSessionState(runtime);
  }
  const expired = tokens.find(
    ({ value }) => value && resolveJwtExpiration(value, runtime.now()).kind === "expired",
  );
  const zcodeJwtToken = tokens[0]?.value ?? "";
  if (expired) {
    serviceLog.info("cached session invalidated because login JWT expired", {
      provider: activeProvider,
      credentialKey: expired.key,
    });
    const invalidated = await invalidateExpiredCachedSession(
      runtime,
      restoreGeneration,
      activeProvider,
      profile,
      expired.value,
      expired.key,
    );
    if (!invalidated) {
      return restoreCachedSessionState(runtime);
    }
    return { status: "reauthentication-required", reason: "jwt-expired" };
  }

  if (activeProvider === BIGMODEL_PROVIDER_ID) {
    const migrationGeneration = runtime.oauthSessionGeneration;
    void refreshLegacyBigModelCachedProfile({
      adapter,
      cachedProfile: profile,
      loadTokenSet: () =>
        loadBigModelCachedProfileMigrationTokenSet(runtime, migrationGeneration, profile),
      now: runtime.now,
      runWithAdapterError: (run) => runWithAdapterError(adapter, run),
      saveProfile: (nextProfile) =>
        saveBigModelCachedProfileMigration(runtime, migrationGeneration, profile, nextProfile),
    })
      .then((migratedProfile) => {
        if (migratedProfile !== profile) {
          log("restoreCachedSession migrated cached profile:", activeProvider, migratedProfile.id);
        }
      })
      .catch((error: unknown) => {
        log(
          "restoreCachedSession background profile migration failed:",
          activeProvider,
          error instanceof Error ? error.message : String(error),
        );
      });
  }

  if (activeProvider === ZAI_PROVIDER_ID) {
    if (!zcodeJwtToken) {
      // sidebar 登录入口之前只看缓存 user_info，会把“缺少 zcodejwttoken”的状态误判成已登录。
      // 这里补充 zcodejwttoken 门槛，确保没有后端 JWT 时统一按未登录处理。
      log("restoreCachedSession skipped: missing zcodejwttoken:", activeProvider);
      return { status: "signed-out" };
    }
  }

  log("restoreCachedSession restored:", activeProvider, profile.id);
  return { status: "authenticated", userInfo: toUserInfo(profile) };
}

async function invalidateExpiredCachedSession(
  runtime: OAuthServiceRuntime,
  expectedGeneration: number,
  expectedProvider: OAuthProviderId,
  expectedProfile: OAuthUserProfile,
  expectedJwt: string,
  credentialKey = ZCODE_JWT_TOKEN_KEY,
): Promise<boolean> {
  const invalidated = await runSessionMutation(runtime, async () => {
    const currentProvider = await runtime.repo.getActiveProvider();
    const currentProfile = await runtime.repo.loadUserProfile(expectedProvider);
    const currentJwt = (await runtime.credentialService.load(credentialKey))?.trim() ?? "";
    if (
      runtime.oauthSessionGeneration !== expectedGeneration ||
      currentProvider !== expectedProvider ||
      !currentProfile ||
      !isSameOAuthProfile(currentProfile, expectedProfile) ||
      currentJwt !== expectedJwt
    ) {
      // 启动恢复读取过期凭据后，新登录或 provider 切换可能已经完成；
      // 旧恢复任务只能清理仍与其快照完全一致的会话，不能误删刚写入的新认证状态。
      serviceLog.info("skipped stale expired JWT session invalidation", {
        provider: expectedProvider,
      });
      return false;
    }
    runtime.oauthSessionGeneration += 1;
    await runtime.repo.clearActiveSession();
    runtime.sessionChanges.fire("signed-out");
    return true;
  });
  if (!invalidated) {
    return false;
  }
  await cancelPending(runtime, expectedProvider);
  try {
    await notifyProviderLogout(runtime, expectedProvider, expectedProfile.id);
  } catch (error) {
    // JWT 已过期时主认证事实必须先失效；派生 provider 清理失败不能把 UI 留在伪登录态。
    serviceLog.warn("expired JWT derived provider cleanup failed", {
      provider: expectedProvider,
      error,
    });
  }
  return true;
}

async function loadBigModelCachedProfileMigrationTokenSet(
  runtime: OAuthServiceRuntime,
  expectedGeneration: number,
  expectedCachedProfile: OAuthUserProfile,
): Promise<OAuthTokenSet | null> {
  return runSessionMutation(runtime, async () => {
    if (runtime.oauthSessionGeneration !== expectedGeneration) {
      log("restoreCachedSession skipped stale BigModel token migration");
      return null;
    }

    const activeProvider = await runtime.repo.getActiveProvider();
    const currentProfile = await runtime.repo.loadUserProfile(BIGMODEL_PROVIDER_ID);
    if (
      activeProvider !== BIGMODEL_PROVIDER_ID ||
      !currentProfile ||
      !isSameOAuthProfile(currentProfile, expectedCachedProfile)
    ) {
      // 迁移请求目标固定是 BigModel，token 也必须固定读取 BigModel 命名空间；
      // 发请求前先复核持久化快照，避免切换到 ZAI 后把其他 provider token 发给 BigModel。
      log("restoreCachedSession skipped stale BigModel token migration:", activeProvider);
      return null;
    }

    return runtime.repo.loadTokenSet(BIGMODEL_PROVIDER_ID);
  });
}

async function saveBigModelCachedProfileMigration(
  runtime: OAuthServiceRuntime,
  expectedGeneration: number,
  expectedCachedProfile: OAuthUserProfile,
  nextProfile: OAuthUserProfile,
): Promise<void> {
  await runSessionMutation(runtime, async () => {
    if (runtime.oauthSessionGeneration !== expectedGeneration) {
      log("restoreCachedSession skipped stale BigModel profile migration");
      return;
    }

    const activeProvider = await runtime.repo.getActiveProvider();
    if (activeProvider !== BIGMODEL_PROVIDER_ID) {
      log("restoreCachedSession skipped stale BigModel profile migration:", activeProvider);
      return;
    }

    const currentProfile = await runtime.repo.loadUserProfile(BIGMODEL_PROVIDER_ID);
    if (!currentProfile || !isSameOAuthProfile(currentProfile, expectedCachedProfile)) {
      // BigModel 旧缓存迁移在后台完成，期间用户可能 logout、切到 ZAI，
      // 或重新登录 BigModel。只有当前缓存仍是启动时那份旧缓存时，旧迁移结果才允许落盘。
      log("restoreCachedSession skipped outdated BigModel profile migration");
      return;
    }

    await runtime.repo.saveUserProfile(BIGMODEL_PROVIDER_ID, nextProfile);
  });
}
