import {
  BIGMODEL_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  type OAuthProviderId,
  type OAuthUserProfile,
  type UserInfo,
} from "@zcode/shared";

export function readTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function toUserInfo(profile: OAuthUserProfile): UserInfo {
  return {
    id: profile.id,
    username: profile.username,
    displayName: profile.displayName,
    ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
  };
}

export function isSameOAuthProfile(left: OAuthUserProfile, right: OAuthUserProfile): boolean {
  return (
    left.id === right.id &&
    left.username === right.username &&
    left.displayName === right.displayName &&
    left.avatarUrl === right.avatarUrl &&
    JSON.stringify(left.rawProfile ?? null) === JSON.stringify(right.rawProfile ?? null)
  );
}

export function resolveInactiveOAuthProvider(provider: OAuthProviderId): OAuthProviderId | null {
  if (provider === ZAI_PROVIDER_ID) {
    return BIGMODEL_PROVIDER_ID;
  }
  if (provider === BIGMODEL_PROVIDER_ID) {
    return ZAI_PROVIDER_ID;
  }
  return null;
}
