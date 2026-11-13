import type {
  OAuthCallbackResult,
  OAuthProviderId,
  OAuthTokenSet,
  OAuthUserProfile,
} from "@zcode/shared";
import { withProviderProfileSchema } from "../oauthProfileSchema.js";
import { clearPendingState, runSessionMutation } from "./runtime.js";
import { resolveInactiveOAuthProvider, toUserInfo } from "./support.js";
import {
  COMPLETED_POLLING_STATE_GRACE_MS,
  type OAuthServiceRuntime,
  type PendingState,
} from "./types.js";

export async function persistOAuthSession(
  runtime: OAuthServiceRuntime,
  provider: OAuthProviderId,
  tokenSet: OAuthTokenSet,
  profile: OAuthUserProfile,
  isStillCurrent?: () => boolean,
): Promise<void> {
  const inactiveProvider = resolveInactiveOAuthProvider(provider);
  const previousTokenSet = await runtime.repo.loadTokenSet(provider);
  const previousProfile = await runtime.repo.loadUserProfile(provider);
  const previousInactiveTokenSet = inactiveProvider
    ? await runtime.repo.loadTokenSet(inactiveProvider)
    : null;
  const previousInactiveProfile = inactiveProvider
    ? await runtime.repo.loadUserProfile(inactiveProvider)
    : null;
  const previousActiveProvider = await runtime.repo.getActiveProvider();
  const rollback = async () => {
    if (previousTokenSet) await runtime.repo.saveTokenSet(provider, previousTokenSet);
    else await runtime.repo.clearProvider(provider);
    if (previousProfile) await runtime.repo.saveUserProfile(provider, previousProfile);
    else await runtime.repo.clearUserProfile(provider);
    if (inactiveProvider) {
      if (previousInactiveTokenSet)
        await runtime.repo.saveTokenSet(inactiveProvider, previousInactiveTokenSet);
      else await runtime.repo.clearProvider(inactiveProvider);
      if (previousInactiveProfile)
        await runtime.repo.saveUserProfile(inactiveProvider, previousInactiveProfile);
      else await runtime.repo.clearUserProfile(inactiveProvider);
    }
    if (previousActiveProvider) await runtime.repo.setActiveProvider(previousActiveProvider);
    else await runtime.repo.setActiveProvider(null);
  };
  const assertCurrent = async () => {
    if (isStillCurrent && !isStillCurrent()) {
      await rollback();
      throw new Error("OAuth flow 已取消");
    }
  };
  runtime.oauthSessionGeneration += 1;
  if (inactiveProvider) {
    await assertCurrent();
    // ZAI 与 BigModel 是互斥身份域。切换 provider 时必须先清旧 provider，
    // 再保存当前 token；反序会让 clearProvider 误删共享的 zcodejwttoken。
    await runtime.repo.clearProvider(inactiveProvider);
  }
  await assertCurrent();
  await runtime.repo.saveTokenSet(provider, tokenSet);
  await assertCurrent();
  await runtime.repo.saveUserProfile(provider, withProviderProfileSchema(provider, profile));
  await assertCurrent();
  await runtime.repo.setActiveProvider(provider);
  if (isStillCurrent && !isStillCurrent()) {
    // active provider 写入无法被底层 credential IO 取消；失效 flow 不能仅按
    // provider 清理，否则同 provider 的新 flow 可能被旧 flow 误删。
    await rollback();
    throw new Error("OAuth flow 已取消");
  }
  // 凭据是认证事实源；同账号重登也必须通知，不能等 renderer 的设置更新或成功计数。
  runtime.sessionChanges.fire("signed-in");
}

export async function runPendingSessionCompletion(
  runtime: OAuthServiceRuntime,
  pending: PendingState,
  complete: () => Promise<{ tokenSet: OAuthTokenSet; profile: OAuthUserProfile }>,
  preserveAttribution?: () => Promise<void>,
): Promise<OAuthCallbackResult | null> {
  const completion = runSessionMutation(runtime, async () => {
    // polling 与 deep link 可能同时完成，也可能在等待期间开始新登录。
    // 只有仍指向同一 pending 对象的路径能落盘，防止迟到结果覆盖更新的登录选择。
    if (runtime.pendingState !== pending) {
      if (
        !runtime.pendingState &&
        runtime.recentlyCompletedPollingState?.state === pending.state &&
        runtime.recentlyCompletedPollingState.generation === runtime.oauthFlowStartGeneration
      ) {
        // 回调入队时已通过有效性检查，不能因队列等待超过去重窗口而丢失归因。
        await preserveAttribution?.();
        return { kind: "duplicate" as const, provider: pending.provider };
      }
      return null;
    }
    await preserveAttribution?.();
    if (runtime.pendingState !== pending) return null;
    const { tokenSet, profile } = await complete();
    // exchangeToken 期间用户可能取消或切换到新 flow；旧请求返回后必须再次校验，
    // 否则已取消的登录仍会把旧凭据写回本地。
    if (runtime.pendingState !== pending) {
      return null;
    }
    await persistOAuthSession(runtime, pending.provider, tokenSet, profile, () => {
      return runtime.pendingState === pending;
    });
    if (runtime.pendingState === pending) {
      clearPendingState(runtime);
    }
    runtime.recentlyCompletedPollingState = {
      generation: runtime.oauthFlowStartGeneration,
      expiresAt: runtime.now() + COMPLETED_POLLING_STATE_GRACE_MS,
      provider: pending.provider,
      state: pending.state,
    };
    return {
      kind: "session" as const,
      provider: pending.provider,
      userInfo: toUserInfo(profile),
    };
  });
  // 共享首个兑换 Promise 会让失败传播给另一条已拿到凭据的路径。
  // 复用会话串行队列，每个候选独立执行；失败只在已排队候选均失败后向 UI 报告。
  pending.completionPromise = completion;
  try {
    return await completion;
  } catch (error) {
    const fallback = pending.completionPromise;
    if (fallback && fallback !== completion) {
      try {
        await fallback;
      } catch {
        // 两条路径均失败时保留各自的错误，不能让备用路径覆盖首条失败原因。
        throw error;
      }
      if (
        !runtime.pendingState &&
        runtime.recentlyCompletedPollingState?.state === pending.state &&
        runtime.recentlyCompletedPollingState.generation === runtime.oauthFlowStartGeneration
      ) {
        return { kind: "duplicate", provider: pending.provider };
      }
      if (runtime.pendingState !== pending) return null;
    }
    throw error;
  } finally {
    if (pending.completionPromise === completion) pending.completionPromise = undefined;
  }
}
