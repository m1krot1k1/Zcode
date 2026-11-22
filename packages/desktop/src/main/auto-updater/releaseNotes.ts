import type { PostUpdateReleaseNotesPayload } from "@zcode/shared";
import semver from "semver";
import { logger } from "../logger.js";
import {
  getCurrentAppVersionForUpdate,
  isVersionGreaterThan,
  updaterState,
  type SettingServiceLike,
  type UpdateDownloadedInfoLike,
} from "./state.js";

function deriveReleaseNotesTitle(markdown: string, version: string) {
  const firstHeading = markdown
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("# ") && line.length > 2);

  return firstHeading ? firstHeading.slice(2).trim() : `Release v${version}`;
}

function normalizeReleaseNotesMarkdown(
  releaseNotes: UpdateDownloadedInfoLike["releaseNotes"],
): string | null {
  if (typeof releaseNotes === "string") {
    const markdown = releaseNotes.trim();
    return markdown === "" ? null : markdown;
  }

  if (!Array.isArray(releaseNotes)) {
    return null;
  }

  const markdown = releaseNotes
    .map((item) => (typeof item?.note === "string" ? item.note.trim() : ""))
    .filter((item) => item.length > 0)
    .join("\n\n")
    .trim();

  return markdown === "" ? null : markdown;
}

function normalizeLocalizedReleaseNotes(
  version: string,
  releaseNotesByLocale: UpdateDownloadedInfoLike["releaseNotesByLocale"],
): PostUpdateReleaseNotesPayload["releaseNotesByLocale"] | undefined {
  const localized: PostUpdateReleaseNotesPayload["releaseNotesByLocale"] = {};
  if (!releaseNotesByLocale || typeof releaseNotesByLocale !== "object") {
    return undefined;
  }

  for (const locale of ["zh-CN", "en-US"] as const) {
    const entry = releaseNotesByLocale[locale];
    if (!entry) {
      continue;
    }

    const markdown =
      typeof entry === "string"
        ? normalizeReleaseNotesMarkdown(entry)
        : normalizeReleaseNotesMarkdown(entry.markdown ?? entry.releaseNotes);
    if (!markdown) {
      continue;
    }

    localized[locale] = {
      title:
        typeof entry === "object" && entry.title?.trim()
          ? entry.title.trim()
          : deriveReleaseNotesTitle(markdown, version),
      markdown,
    };
  }

  return Object.keys(localized).length > 0 ? localized : undefined;
}

function pickFallbackReleaseNotesMarkdown(
  localized: PostUpdateReleaseNotesPayload["releaseNotesByLocale"] | undefined,
): string | null {
  const { menu } = updaterState;
  return (
    localized?.[menu.locale]?.markdown ??
    localized?.["zh-CN"]?.markdown ??
    localized?.["en-US"]?.markdown ??
    null
  );
}

function normalizeReleaseDate(
  releaseDate: UpdateDownloadedInfoLike["releaseDate"],
): string | undefined {
  if (releaseDate instanceof Date && !Number.isNaN(releaseDate.getTime())) {
    return releaseDate.toISOString();
  }
  if (typeof releaseDate !== "string") {
    return undefined;
  }
  const trimmed = releaseDate.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function toPostUpdateReleaseNotesPayload(
  info: UpdateDownloadedInfoLike,
): PostUpdateReleaseNotesPayload | null {
  const releaseNotesByLocale = normalizeLocalizedReleaseNotes(
    info.version,
    info.releaseNotesByLocale,
  );
  const markdown =
    normalizeReleaseNotesMarkdown(info.releaseNotes) ??
    pickFallbackReleaseNotesMarkdown(releaseNotesByLocale);
  if (!markdown) {
    return null;
  }

  const title = info.releaseName?.trim() || deriveReleaseNotesTitle(markdown, info.version);
  const releaseDate = normalizeReleaseDate(info.releaseDate);
  return {
    version: info.version,
    title,
    markdown,
    ...(releaseDate ? { releaseDate } : {}),
    ...(releaseNotesByLocale ? { releaseNotesByLocale } : {}),
  };
}

export async function persistPendingPostUpdateReleaseNotes(
  settingService: SettingServiceLike,
  payload: PostUpdateReleaseNotesPayload,
  reason: string,
) {
  const { notes } = updaterState;
  if (notes.acknowledgedVersions.has(payload.version)) {
    logger.info(
      `[auto-update] skip persisting acknowledged post-update release notes (${reason}) version=${payload.version}`,
    );
    return;
  }

  await settingService.update({ pendingPostUpdateReleaseNotes: payload });
  notes.pending = payload;
  notes.deliveredWebContentsId = null;
  logger.info(
    `[auto-update] persisted post-update release notes (${reason}) version=${payload.version}`,
  );
}

/**
 * 待展示说明里的 version 来自「已下载的安装包」；当前进程版本在安装完成前仍可能是旧版，
 * 此时待展示版本高于当前运行版本属于正常中间态，不能丢弃。
 * 若用户跳过自动更新链路（官网安装包等）直接升到更高版本，磁盘里可能仍残留更早一次下载写入的 pending，
 * 此时待展示版本低于已安装版本，应在启动时丢弃，否则会弹出旧版更新说明。
 */
export function shouldDiscardStalePendingReleaseNotes(
  pendingVersion: string,
  appVersion: string,
): boolean {
  const pending = pendingVersion.trim();
  const current = appVersion.trim();
  if (pending === current) {
    return false;
  }

  const pendingCoerced = semver.valid(semver.coerce(pending));
  const appCoerced = semver.valid(semver.coerce(current));
  if (!pendingCoerced || !appCoerced) {
    return false;
  }

  return semver.lt(pendingCoerced, appCoerced);
}

export function isPendingReleaseNotesForFutureVersion(
  payload: PostUpdateReleaseNotesPayload,
): boolean {
  return isVersionGreaterThan(payload.version, getCurrentAppVersionForUpdate());
}

export async function clearPendingPostUpdateReleaseNotes(
  settingService: SettingServiceLike,
  reason: string,
) {
  const { notes } = updaterState;
  if (!notes.pending) {
    return;
  }

  const version = notes.pending.version;
  await settingService.update({ pendingPostUpdateReleaseNotes: undefined });
  notes.pending = null;
  notes.deliveredWebContentsId = null;
  logger.info(`[auto-update] cleared post-update release notes (${reason}) version=${version}`);
}

export function clearPersistedPostUpdateReleaseNotesForVersion(version: string, reason: string) {
  const { notes, runtime } = updaterState;
  if (notes.pending?.version === version) {
    notes.pending = null;
    notes.deliveredWebContentsId = null;
  }

  const settingService = runtime.settingService;
  if (!settingService) {
    return;
  }

  void (async () => {
    try {
      const settings = await settingService.get();
      if (settings.pendingPostUpdateReleaseNotes?.version !== version) {
        return;
      }

      await settingService.update({ pendingPostUpdateReleaseNotes: undefined });
      logger.info(`[auto-update] cleared post-update release notes (${reason}) version=${version}`);
    } catch (error) {
      logger.warn(`[auto-update] clear post-update release notes (${reason}) failed:`, error);
    }
  })();
}
